import { describe, expect, it, vi } from 'vitest';
import { fallbackAuthViewFactory } from './auth-fallback';
import type { AuthView, AuthViewFactory } from './auth-transport';
const frame = { type: 'open' as const, session: 1, url: 'https://login.live.com/', headers: {} };
const second = { ...frame, session: 2, url: 'https://login.live.com/ppsecure/inlineconnect.srf' };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => resolve = yes); return { resolve, promise }; };
function fixture(resolveBrowser?: () => Promise<AuthViewFactory>) {
  let request!: () => Promise<void>, oldSend!: (id: number, payload: string) => void, oldCancel!: (id: number) => void;
  const events: string[] = [];
  const embedded: AuthView = { open: vi.fn(async () => { events.push('old-open'); }), context: vi.fn(async () => {}), close: vi.fn(), dispose: vi.fn(async () => { events.push('old-disposed'); }) };
  const browser: AuthView = { open: vi.fn(async () => { events.push('browser-open'); }), context: vi.fn(async () => {}), close: vi.fn(), dispose: vi.fn(async () => {}) };
  const factory: AuthViewFactory = () => { events.push('browser-created'); return browser; };
  const send = vi.fn(), cancel = vi.fn(), fail = vi.fn();
  const view = fallbackAuthViewFactory(callback => {
    request = callback; return (s, c) => { oldSend = s; oldCancel = c; return embedded; };
  }, resolveBrowser ?? (async () => factory))(send, cancel, fail);
  return { view, request: () => request(), oldSend: () => oldSend(1, 'stale'), oldCancel: () => oldCancel(1), embedded, browser, factory, events, send, cancel, fail };
}
describe('explicit browser fallback', () => {
  it('fully closes the old view first, keeps the same session and drops old events', async () => {
    const f = fixture(); await f.view.open(frame); await f.request();
    expect(f.events).toEqual(['old-open', 'old-disposed', 'browser-created', 'browser-open']);
    expect(f.browser.open).toHaveBeenCalledWith(frame);
    f.oldSend(); f.oldCancel(); expect(f.send).not.toHaveBeenCalled(); expect(f.cancel).not.toHaveBeenCalled();
    await f.view.context(1, 'opaque-context'); expect(f.browser.context).toHaveBeenCalledWith(1, 'opaque-context');
    await f.request(); expect(f.browser.open).toHaveBeenCalledOnce(); await f.view.dispose();
  });
  it('does not close embedded sign-in if no supported browser is available', async () => {
    const f = fixture(async () => { throw Error('missing'); }); await f.view.open(frame);
    await expect(f.request()).rejects.toThrow('missing'); expect(f.embedded.dispose).not.toHaveBeenCalled();
    f.oldSend(); expect(f.send).toHaveBeenCalledOnce(); await f.view.dispose();
  });
  it('does not open a browser if the attempt closes during discovery', async () => {
    const gate = deferred(); let f: ReturnType<typeof fixture>;
    f = fixture(async () => { await gate.promise; return f.factory; }); await f.view.open(frame);
    const switching = f.request(); f.view.close(1); gate.resolve(); await switching;
    expect(f.browser.open).not.toHaveBeenCalled(); await f.view.dispose();
  });
  it('does not resurrect a disposed attempt', async () => {
    const gate = deferred(); let f: ReturnType<typeof fixture>;
    f = fixture(async () => { await gate.promise; return f.factory; }); await f.view.open(frame);
    const switching = f.request(); await f.view.dispose(); gate.resolve(); await switching;
    expect(f.browser.open).not.toHaveBeenCalled();
  });
  it('waits for embedded disposal before opening Chrome and delivering context', async () => {
    const f = fixture(), gate = deferred(); await f.view.open(frame);
    vi.mocked(f.embedded.dispose).mockImplementation(async () => { await gate.promise; f.events.push('old-disposed'); });
    const switching = f.request(); await Promise.resolve();
    const context = f.view.context(1, 'opaque-context'); expect(f.browser.open).not.toHaveBeenCalled();
    gate.resolve(); await switching; await context;
    expect(f.browser.context).toHaveBeenCalledOnce(); await f.view.dispose();
  });
});

const settledWithin = async (promise: Promise<unknown>) => Promise.race([
  promise.then(() => 'settled', () => 'rejected'), new Promise(resolve => setTimeout(() => resolve('stalled'), 500)),
]);
describe('retired view waits (#554)', () => {
  it('releases an open() still pending on the retired embedded view when the next session opens', async () => {
    const f = fixture(); await f.view.open(frame);
    const first = deferred();
    vi.mocked(f.embedded.open).mockImplementationOnce(async () => { await first.promise; });
    const opening = f.view.open({ ...frame, session: 3 });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.embedded.open).toHaveBeenCalledTimes(2);
    await f.request();
    expect(f.browser.open).toHaveBeenCalledWith({ ...frame, session: 3 });
    // The original call on the retired view is released by the switch itself, before its own promise resolves.
    expect(await settledWithin(opening)).toBe('settled');
    expect(await settledWithin(f.view.open(second))).toBe('settled');
    first.resolve(); await opening;
    expect(f.fail).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    await f.view.dispose();
  });
  it('releases a context() still pending on the retired embedded view when the next session opens', async () => {
    const f = fixture(); await f.view.open(frame);
    const first = deferred();
    vi.mocked(f.embedded.context).mockImplementationOnce(async () => { await first.promise; });
    const pending = f.view.context(1, 'opaque-context'); await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.embedded.context).toHaveBeenCalledOnce();
    // The backend's next frame opens session 3 before it asks for the context.
    await f.view.open({ ...frame, session: 3 });
    await f.request();
    // The original context() on the retired view is released by the switch itself, not by its own promise.
    expect(await settledWithin(pending)).toBe('settled');
    expect(await settledWithin(f.view.context(3, 'next-context'))).toBe('settled');
    first.resolve(); await pending;
    expect(f.browser.context).toHaveBeenCalledWith(3, 'next-context');
    expect(f.fail).not.toHaveBeenCalled();
    await f.view.dispose();
  });
  it('releases pending waits on disposal and ignores their late results and rejections', async () => {
    const f = fixture(); await f.view.open(frame);
    const opening = deferred(), context = deferred();
    vi.mocked(f.embedded.open).mockImplementationOnce(async () => { await opening.promise; });
    vi.mocked(f.embedded.context).mockImplementationOnce(async () => { await context.promise; });
    // An open() is pending on the retired embedded view when the attempt is disposed.
    const first = f.view.open({ ...frame, session: 3 });
    await vi.waitFor(() => expect(f.embedded.open).toHaveBeenCalledTimes(2));
    const disposing = f.view.dispose();
    expect(await settledWithin(first)).toBe('settled');
    await disposing;
    opening.resolve(); await first;
    // A context() that resolves late on the disposed view is never delivered.
    await f.view.context(1, 'opaque-context');
    expect(f.embedded.context).not.toHaveBeenCalled();
    expect(f.fail).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it('still propagates a current generation open() and context() failure', async () => {
    const f = fixture(); await f.view.open(frame);
    vi.mocked(f.embedded.open).mockRejectedValueOnce(Error('current open failed'));
    const failing = f.view.open({ ...frame, session: 3 });
    await expect(failing).rejects.toThrow('current open failed');
    // The backend reopens the same session in Chrome after the embedded view failed.
    await f.request();
    await f.view.open({ ...frame, session: 3 });
    await vi.waitFor(() => expect(f.browser.open).toHaveBeenCalledTimes(2));
    vi.mocked(f.browser.context).mockRejectedValueOnce(Error('current context failed'));
    const failingContext = f.view.context(3, 'opaque-context');
    await expect(failingContext).rejects.toThrow('current context failed');
    expect(f.browser.context).toHaveBeenCalledOnce();
    expect(f.fail).not.toHaveBeenCalled();
    await f.view.dispose();
  });
  it('still propagates a current generation browser failure', async () => {
    const f = fixture(); await f.view.open(frame);
    vi.mocked(f.browser.open).mockRejectedValueOnce(Error('browser open failed'));
    await expect(f.request()).rejects.toThrow('Browser sign-in could not be opened');
    expect(f.fail).toHaveBeenCalledOnce();
    await f.view.dispose();
  });
});
