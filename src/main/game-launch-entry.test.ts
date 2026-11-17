import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createSourceFile, isFunctionDeclaration, isIdentifier, isVariableStatement, ScriptKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { captureSteamLaunchEnvironment, gameSteamContext, steamGameEnvironment, steamOverlayFiltered, type SteamGameContext, type SteamLaunchEnvironment } from './steam-launch-context.js';

// Execute the actual production dispatcher and selection statements, not copies
// of their logic. Electron/account/process services remain outside this fixture.
const source = readFileSync('src/main/index.ts', 'utf8');
const tree = createSourceFile('index.ts', source, ScriptTarget.ES2022, true, ScriptKind.TS);
function indexFunction(name: string) {
  const fn = tree.statements.find(node => isFunctionDeclaration(node) && node.name?.text === name);
  if (!fn || !isFunctionDeclaration(fn) || !fn.body) throw Error(`Missing production function ${name}`);
  return fn;
}
const compile = (text: string) => transpileModule(text, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
const dispatchNames = new Set(['receiveLaunchRequest', 'handleLaunchRequest', 'launchRequest', 'launchContext']);
const dispatchScript = compile(tree.statements.filter(node => isFunctionDeclaration(node) && node.name && dispatchNames.has(node.name.text))
  .map(node => node.getText(tree)).join('\n'));
const selectionNames = new Set(['steamContext', 'launchEnvironment', 'restoreSteamOverlay', 'steamSignal']);
const selectionStatements = indexFunction('prepareGameLaunch').body!.statements.filter(node => isVariableStatement(node)
  && node.declarationList.declarations.some(declaration => isIdentifier(declaration.name) && selectionNames.has(declaration.name.text)));
const selectionScript = compile(`(()=>{${selectionStatements.map(node => node.getText(tree)).join('\n')}
  return {steamContext, launchEnvironment, restoreSteamOverlay, steamSignal};})()`);
const primaryEnvironment = { SteamGameId: '456', XODUS_NEXUS_STEAM_OVERLAY_FILTERED: '1' };
const requestEnvironment: SteamLaunchEnvironment = { SteamGameId: '789', SDL_GAMECONTROLLERCONFIG: 'request mapping' };
const gameId = '0123456789abcdef';

function selection(base: NodeJS.ProcessEnv, request?: SteamGameContext,
  session?: { environment: SteamLaunchEnvironment; overlayFiltered: boolean; lease: { signal: AbortSignal } }) {
  const primarySteam = captureSteamLaunchEnvironment(base);
  return runInNewContext(selectionScript, { process: { env: base }, steam: request, steamLauncherSession: session,
    primarySteam, primaryOverlayFiltered: primarySteam ? steamOverlayFiltered(base) : false,
    gameSteamContext, steamGameEnvironment }) as { steamContext?: SteamGameContext; launchEnvironment: NodeJS.ProcessEnv;
      restoreSteamOverlay: boolean; steamSignal?: AbortSignal };
}

function dispatcher() {
  let started!: () => void, finalized!: () => void, finished!: () => void;
  const onStarted = new Promise<void>(resolve => { started = resolve; });
  const onFinalized = new Promise<void>(resolve => { finalized = resolve; });
  const onFinished = new Promise<void>(resolve => { finished = resolve; });
  const controller = new AbortController();
  const lease = { signal: controller.signal, close: vi.fn() };
  const context = {
    launchReady: true, pendingRequests: [], steamLauncherSession: undefined,
    primarySteam: captureSteamLaunchEnvironment(primaryEnvironment), primaryOverlayFiltered: true,
    gameSteamContext, steamLeases: new Set(),
    acceptSteamHandoff: vi.fn(async () => lease),
    shortcutLaunch: { request: vi.fn(async (_id: string, _steam?: SteamGameContext) => { started(); }) },
    gameFinalizations: new Map([[gameId, onFinalized]]),
    showLauncher: vi.fn(async () => {}), shortcutError: vi.fn(), finishShortcutSession: vi.fn(() => finished()),
  };
  const entry = runInNewContext(dispatchScript + '\n({receiveLaunchRequest})', context) as {
    receiveLaunchRequest(request: { gameId?: string; steam?: unknown }): void;
  };
  return { context, entry, controller, lease, onStarted, onFinished, finalized };
}

const handoff = (filtered: boolean) => ({ environment: requestEnvironment, overlayFiltered: filtered,
  lease: { socket: '/private-fixture', token: 'a'.repeat(64) } });

describe('production Steam launch entry', () => {
  it('accepts the actual warm dispatch lease before launch and holds it through finalization', async () => {
    const f = dispatcher();
    f.entry.receiveLaunchRequest({ gameId, steam: handoff(true) });
    await f.onStarted;
    expect(f.context.acceptSteamHandoff).toHaveBeenCalledOnce();
    const [id, context] = f.context.shortcutLaunch.request.mock.calls[0];
    expect(id).toBe(gameId);
    expect(context).toMatchObject({ environment: requestEnvironment, overlayFiltered: true });
    expect(context?.signal).toBe(f.lease.signal);
    expect(f.context.steamLeases.has(f.lease)).toBe(true);
    expect(f.lease.close).not.toHaveBeenCalled();
    f.controller.abort();
    expect(context?.signal.aborted).toBe(true);
    expect(f.lease.close).not.toHaveBeenCalled();
    f.finalized(); await f.onFinished;
    expect(f.lease.close).toHaveBeenCalledOnce();
    expect(f.context.steamLeases.size).toBe(0);
  });

  it('keeps explicit false authoritative over a filtered Steam primary', async () => {
    const f = dispatcher();
    f.entry.receiveLaunchRequest({ gameId, steam: handoff(false) }); await f.onStarted;
    const context = f.context.shortcutLaunch.request.mock.calls[0][1];
    expect(context?.overlayFiltered).toBe(false);
    const chosen = selection(primaryEnvironment, context);
    expect(chosen.restoreSteamOverlay).toBe(false);
    expect(chosen.launchEnvironment.SteamGameId).toBe('789');
    expect(chosen.steamSignal).toBe(f.lease.signal);
    f.finalized(); await f.onFinished;
  });

  it('never launches or falls back to the primary after handoff acceptance fails', async () => {
    const f = dispatcher();f.context.acceptSteamHandoff.mockRejectedValueOnce(Error('Rejected lease'));
    f.entry.receiveLaunchRequest({ gameId, steam: handoff(true) });await f.onFinished;
    expect(f.context.shortcutLaunch.request).not.toHaveBeenCalled();
    expect(f.context.shortcutError).toHaveBeenCalledOnce();
    expect(f.lease.close).not.toHaveBeenCalled();
  });

  it('keeps desktop dispatch free of any invented Steam lease', async () => {
    const f = dispatcher();f.entry.receiveLaunchRequest({ gameId });await f.onFinished;
    expect(f.context.acceptSteamHandoff).not.toHaveBeenCalled();
    expect(f.context.shortcutLaunch.request).toHaveBeenCalledWith(gameId, undefined);
    expect(f.lease.close).not.toHaveBeenCalled();
  });

  it('uses validated primary startup for both context-free cold shortcut and UI Play', () => {
    const result = selection(primaryEnvironment);
    expect(result.restoreSteamOverlay).toBe(true);
    expect(result.launchEnvironment.SteamGameId).toBe('456');
    expect(result.steamSignal).toBeUndefined();
    expect(selection({ SteamGameId: '456' }).restoreSteamOverlay).toBe(false);
    expect(selection({ XODUS_NEXUS_STEAM_OVERLAY_FILTERED: '1' }).restoreSteamOverlay).toBe(false);
    expect(selection({}).restoreSteamOverlay).toBe(false);
  });

  it('prefers request over session over primary, with each false preserved', () => {
    const signal = new AbortController().signal;
    const session = { environment: { SteamGameId: '901' }, overlayFiltered: false, lease: { signal } };
    expect(selection(primaryEnvironment, undefined, session).restoreSteamOverlay).toBe(false);
    expect(selection(primaryEnvironment, undefined, session).launchEnvironment.SteamGameId).toBe('901');
    const request = { environment: requestEnvironment, overlayFiltered: true, signal };
    expect(selection(primaryEnvironment, request, session).restoreSteamOverlay).toBe(true);
    expect(selection(primaryEnvironment, request, session).launchEnvironment.SteamGameId).toBe('789');
    expect(selection({}, undefined, { ...session, overlayFiltered: true }).restoreSteamOverlay).toBe(true);
  });
});
