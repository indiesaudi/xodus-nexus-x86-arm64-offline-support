import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createBrowserAuthViewFactory } from './auth-browser';
import type { AuthView } from './auth-transport';

// Synthetic Chrome speaking the private fd3/fd4 pipe protocol. No browser is
// started, no profile is used and no network is contacted.
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn }));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, promises: { ...actual.promises, mkdtemp: async (prefix: string) => `${prefix}synthetic`, chmod: async () => undefined, mkdir: async () => undefined, rm: async () => undefined } };
});

const frame = { type: 'open' as const, session: 1, url: 'https://login.live.com/ppsecure/InlineLogin.srf', headers: { hostapp: 'CloudExperienceHost' } };
const origin = 'https://login.live.com';
const navigated = 'https://login.live.com/ppsecure/inlineconnect.srf';
type Command = { id: number; method: string; params: any; sessionId?: string };
type Realm = { id: number; origin: string; frameId: string; isDefault?: boolean };

// The synthetic child is never a real process: process.kill is replaced for the
// whole file so no process group can ever be signalled by a fixture.
const signals: { pid: number; signal: string | number | undefined }[] = [];
const processKill = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
  signals.push({ pid, signal });
  return true;
});
const views: AuthView[] = [];
function fixture() {
  const input = new PassThrough(), output = new PassThrough();
  const chrome = Object.assign(new EventEmitter(), { stdio: [null, null, null, input, output], exitCode: null, signalCode: null, pid: 424242, kill: vi.fn() });
  // Browser.close ends the synthetic browser cleanly, so a correct dispose never needs to signal it.
  const exit = () => { chrome.exitCode = 0; chrome.emit('close', 0); };
  spawn.mockReturnValue(chrome);
  let buffer = '';
  const commands: Command[] = [];
  const reply = (command: Command) => {
    const result: any = { id: command.id, sessionId: command.sessionId, result: {} };
    if (command.method === 'Target.getTargets') result.result = { targetInfos: [{ type: 'page', url: 'about:blank', targetId: 'target-1' }] };
    else if (command.method === 'Target.attachToTarget') result.result = { sessionId: 'session-1' };
    else if (command.method === 'Page.getFrameTree') result.result = { frameTree: { frame: { id: 'main-frame' } } };
    // A real browser has exited by the time its Browser.close reply is read.
    if (command.method === 'Browser.close') { exit(); output.write(JSON.stringify(result) + '\0'); return; }
    // Origin evaluations are answered explicitly by each test to control the race.
    if (command.method !== 'Runtime.evaluate') output.write(JSON.stringify(result) + '\0');
  };
  input.on('data', (bytes: Buffer) => {
    buffer += String(bytes);
    let end: number;
    while ((end = buffer.indexOf('\0')) >= 0) { const command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); commands.push(command); reply(command); }
  });
  const event = (method: string, params: object, sessionId: string | undefined = 'session-1') => output.write(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  const create = (realm: Realm) => event('Runtime.executionContextCreated', { context: { id: realm.id, origin: realm.origin, auxData: { isDefault: realm.isDefault ?? true, frameId: realm.frameId } } });
  const destroy = (id: number) => event('Runtime.executionContextDestroyed', { executionContextId: id });
  const evaluate = (contextId: number) => commands.filter(command => command.method === 'Runtime.evaluate' && command.params.contextId === contextId);
  const answer = (contextId: number, response: { value?: string; error?: string }) => {
    const command = evaluate(contextId)[0];
    output.write(JSON.stringify({ id: command.id, sessionId: 'session-1', ...(response.error ? { error: { message: response.error } } : { result: { result: { value: response.value } } }) }) + '\0');
  };
  const waitFor = async (predicate: () => boolean) => { for (let attempt = 0; attempt < 300 && !predicate(); attempt++) await new Promise(resolve => setTimeout(resolve, 2)); return predicate(); };
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  return { chrome, commands, event, create, destroy, evaluate, answer, waitFor, settle };
}
function viewOf(f: ReturnType<typeof fixture>) {
  const send = vi.fn(), cancel = vi.fn(), fail = vi.fn();
  const view: AuthView = createBrowserAuthViewFactory('/usr/bin/google-chrome', { PATH: '' })(send, cancel, fail);
  views.push(view);
  return { view, send, cancel, fail };
}
const bindingOf = (f: ReturnType<typeof fixture>) => f.commands.find(command => command.method === 'Runtime.addBinding')!.params.name;
const notify = (f: ReturnType<typeof fixture>, contextId: number, payload: string) => f.event('Runtime.bindingCalled', { name: bindingOf(f), executionContextId: contextId, payload });
const navigate = (f: ReturnType<typeof fixture>) => f.event('Page.frameNavigated', { frame: { id: 'main-frame', url: navigated } });

beforeEach(() => { spawn.mockReset(); signals.length = 0; });
afterEach(async () => {
  // Disposal is idempotent; this also runs when an assertion failed mid-test.
  for (const view of views.splice(0)) await view.dispose().catch(() => {});
  expect(signals).toEqual([]);
  expect(processKill).toHaveBeenCalledTimes(0);
});

describe('browser auth navigation races (#554)', () => {
  it('ignores a callback origin evaluation rejected by navigation and keeps the new session alive', async () => {
    const f = fixture(), { view, send, fail } = viewOf(f);
    await view.open(frame);
    f.create({ id: 1, origin, frameId: 'main-frame' });
    notify(f, 1, '{"synthetic":"notification"}');
    expect(await f.waitFor(() => f.evaluate(1).length === 1)).toBe(true);
    // The realm is destroyed while its origin evaluation is in flight.
    f.destroy(1); navigate(f); f.create({ id: 2, origin, frameId: 'main-frame' });
    f.answer(1, { error: 'Cannot find context with specified id' });
    await f.settle();
    expect(fail).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    notify(f, 2, '{"synthetic":"current"}');
    expect(await f.waitFor(() => f.evaluate(2).length === 1)).toBe(true);
    f.answer(2, { value: origin });
    expect(await f.waitFor(() => send.mock.calls.length === 1)).toBe(true);
    expect(send).toHaveBeenCalledWith(1, '{"synthetic":"current"}');
    expect(fail).not.toHaveBeenCalled();
    await view.dispose();
  });
  it('still fails the session when the current realm origin evaluation rejects', async () => {
    const f = fixture(), { view, send, fail } = viewOf(f);
    await view.open(frame);
    f.create({ id: 1, origin, frameId: 'main-frame' });
    notify(f, 1, '{"synthetic":"notification"}');
    expect(await f.waitFor(() => f.evaluate(1).length === 1)).toBe(true);
    f.answer(1, { error: 'synthetic' });
    expect(await f.waitFor(() => fail.mock.calls.length === 1)).toBe(true);
    expect(send).not.toHaveBeenCalled();
    await view.dispose();
  });
  it('does not send a callback whose origin evaluation answers after the realm was replaced', async () => {
    const f = fixture(), { view, send, fail } = viewOf(f);
    await view.open(frame);
    f.create({ id: 1, origin, frameId: 'main-frame' });
    notify(f, 1, '{"synthetic":"stale"}');
    expect(await f.waitFor(() => f.evaluate(1).length === 1)).toBe(true);
    f.destroy(1); f.create({ id: 2, origin, frameId: 'main-frame' });
    f.answer(1, { value: origin });
    await f.settle();
    expect(send).not.toHaveBeenCalled(); expect(fail).not.toHaveBeenCalled();
    await view.dispose();
  });
  it('ignores a context() evaluation rejected by navigation and never dispatches to the retired realm', async () => {
    const f = fixture(), { view, send, fail } = viewOf(f);
    await view.open(frame);
    f.create({ id: 1, origin, frameId: 'main-frame' });
    const pending = view.context(1, 'opaque-context');
    expect(await f.waitFor(() => f.evaluate(1).length === 1)).toBe(true);
    f.destroy(1); navigate(f); f.create({ id: 2, origin, frameId: 'main-frame' });
    f.answer(1, { error: 'Cannot find context with specified id' });
    await expect(pending).resolves.toBeUndefined();
    await f.settle();
    expect(f.evaluate(1)).toHaveLength(1); expect(f.evaluate(2)).toHaveLength(0);
    expect(send).not.toHaveBeenCalled(); expect(fail).not.toHaveBeenCalled();
    await view.dispose();
  });
  it('still rejects context() when the current realm evaluation fails', async () => {
    const f = fixture(), { view, fail } = viewOf(f);
    await view.open(frame);
    f.create({ id: 1, origin, frameId: 'main-frame' });
    const pending = view.context(1, 'opaque-context');
    expect(await f.waitFor(() => f.evaluate(1).length === 1)).toBe(true);
    f.answer(1, { error: 'synthetic' });
    await expect(pending).rejects.toThrow('Browser sign-in command failed.');
    expect(fail).not.toHaveBeenCalled();
    await view.dispose();
  });
  it('ignores a context() rejection after disposal instead of failing the closed view', async () => {
    const f = fixture(), { view, fail } = viewOf(f);
    await view.open(frame);
    f.create({ id: 1, origin, frameId: 'main-frame' });
    const pending = view.context(1, 'opaque-context');
    expect(await f.waitFor(() => f.evaluate(1).length === 1)).toBe(true);
    await view.dispose();
    f.answer(1, { error: 'synthetic' });
    await expect(pending).resolves.toBeUndefined();
    expect(fail).not.toHaveBeenCalled();
  });
  it('still enforces the trusted origin and main frame before and after the evaluation', async () => {
    const f = fixture(), { view, send, fail } = viewOf(f);
    await view.open(frame);
    // Untrusted and subframe realms are rejected before any evaluation.
    f.create({ id: 1, origin: 'https://example.invalid', frameId: 'main-frame' });
    f.create({ id: 3, origin, frameId: 'sub-frame' });
    notify(f, 1, '{"synthetic":"untrusted"}'); notify(f, 3, '{"synthetic":"subframe"}');
    // A trusted realm that navigates to an untrusted origin during the evaluation is rejected after it.
    f.create({ id: 2, origin, frameId: 'main-frame' });
    notify(f, 2, '{"synthetic":"mismatch"}');
    expect(await f.waitFor(() => f.evaluate(2).length === 1)).toBe(true);
    f.event('Runtime.executionContextCreated', { context: { id: 2, origin: 'https://example.invalid', auxData: { isDefault: true, frameId: 'main-frame' } } });
    f.answer(2, { value: 'https://example.invalid' });
    await f.settle();
    expect(send).not.toHaveBeenCalled(); expect(fail).not.toHaveBeenCalled();
    expect(f.evaluate(1)).toHaveLength(0); expect(f.evaluate(3)).toHaveLength(0);
    await view.dispose();
  });
});
