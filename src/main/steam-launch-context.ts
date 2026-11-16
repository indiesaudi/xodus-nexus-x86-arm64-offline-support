import { chmodSync, lstatSync, mkdtempSync, rmdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// No executable/library paths, account values, display policy or arbitrary env.
const names = ['SteamAppId', 'SteamGameId', 'SteamOverlayGameId', 'STEAM_COMPAT_APP_ID',
  'SDL_GAMECONTROLLERCONFIG', 'SDL_GAMECONTROLLER_IGNORE_DEVICES',
  'SDL_GAMECONTROLLER_IGNORE_DEVICES_EXCEPT', 'SDL_GAMECONTROLLER_ALLOW_STEAM_VIRTUAL_GAMEPAD',
  'SteamVirtualGamepadInfo', 'SteamVirtualGamepadInfo_Proton'] as const;
export type SteamLaunchEnvironment = Partial<Record<typeof names[number], string>>;
interface LeaseAddress { socket: string; token: string }
export interface SteamHandoff { environment: SteamLaunchEnvironment; lease: LeaseAddress }
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export function captureSteamLaunchEnvironment(env: NodeJS.ProcessEnv): SteamLaunchEnvironment | undefined {
  if (!env.SteamGameId || !/^[1-9][0-9]{0,19}$/.test(env.SteamGameId) || BigInt(env.SteamGameId) > 0xffffffffffffffffn) return;
  const result: SteamLaunchEnvironment = {};
  for (const name of names) {
    const value = env[name];
    if (value === undefined) continue;
    if (value.length > 32768 || (name === 'SDL_GAMECONTROLLERCONFIG' ? value.includes('\0') : /[\0\r\n]/.test(value))) throw Error('Invalid Steam controller launch context.');
    if (['SteamAppId', 'SteamOverlayGameId', 'STEAM_COMPAT_APP_ID'].includes(name) && !/^[0-9]{1,20}$/.test(value)) throw Error('Invalid Steam launch identity.');
    result[name] = value;
  }
  return result;
}

export function steamHandoffRequest(data: unknown): SteamHandoff | undefined {
  if (!object(data) || !Object.hasOwn(data, 'nexusSteam')) return;
  const value = data.nexusSteam;
  if (!object(value) || Object.keys(value).some(key => !['environment', 'lease'].includes(key)) ||
      !object(value.environment) || Object.keys(value.environment).some(key => !(names as readonly string[]).includes(key)) ||
      Object.values(value.environment).some(item => typeof item !== 'string') || !object(value.lease) ||
      Object.keys(value.lease).some(key => !['socket', 'token'].includes(key)) ||
      typeof value.lease.socket !== 'string' || typeof value.lease.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.lease.token))
    throw Error('Invalid Steam shortcut handoff.');
  const environment = captureSteamLaunchEnvironment(value.environment as NodeJS.ProcessEnv);
  if (!environment) throw Error('Missing Steam shortcut identity.');
  return { environment, lease: { socket: value.lease.socket, token: value.lease.token } };
}

// Driver and DXVK cache locations the Steam client puts in a launched
// process. Steam does not mark them as its own, so a value that reached the
// main process from Steam cannot be told apart from one the user exported
// before starting Steam. Only these names are dropped; Vulkan loader
// configuration such as VK_LAYER_PATH or VK_INSTANCE_LAYERS stays untouched.
const steamCacheNames = ['MESA_SHADER_CACHE_DIR', 'MESA_SHADER_CACHE_MAX_SIZE', 'MESA_DISK_CACHE_SINGLE_FILE',
  'MESA_DISK_CACHE_READ_ONLY_FOZ_DBS', 'MESA_GLSL_CACHE_DIR', 'MESA_GLSL_CACHE_MAX_SIZE',
  '__GL_SHADER_DISK_CACHE_PATH', '__GL_SHADER_DISK_CACHE_APP_NAME', '__GL_SHADER_DISK_CACHE_READ_ONLY_APP_NAME',
  '__GL_SHADER_DISK_CACHE_SKIP_CLEANUP', 'DXVK_STATE_CACHE_PATH',
  // Fossilize's own switch. Removing it only stops the layer being enabled
  // implicitly; an explicit loader setting can still activate it.
  'ENABLE_VK_LAYER_VALVE_steam_fossilize_1'] as const;

/** Whether the launcher process itself was started by Steam (not a later request). */
export function steamPrimaryEnvironment(env: NodeJS.ProcessEnv): boolean {
  return captureSteamLaunchEnvironment(env) !== undefined;
}

const steamCacheVariable = (name: string): boolean => (steamCacheNames as readonly string[]).includes(name)
  || name.startsWith('STEAM_FOSSILIZE_');

/**
 * Copy of the inherited environment for one launch. A main process started by
 * Steam drops Steam's cache variables so the managed per-prefix cache applies;
 * a normally started process keeps every value, including a later Steam
 * shortcut request. The caller's environment object is never modified.
 */
export function steamGameEnvironment(base: NodeJS.ProcessEnv, context?: SteamLaunchEnvironment): NodeJS.ProcessEnv {
  const result = { ...base };
  if (steamPrimaryEnvironment(base)) for (const name of Object.keys(result)) if (steamCacheVariable(name)) delete result[name];
  if (context) for (const name of names) {
    delete result[name];
    if (context[name] !== undefined) result[name] = context[name];
  }
  return result;
}

/** Keep the Steam-launched secondary process alive without opening another UI.
 * Only a private, token-authenticated local connection can own this lifetime. */
export function offerSteamHandoff(environment: SteamLaunchEnvironment, onFinished: () => void,
  timeoutMs = 90_000): { handoff: SteamHandoff; close(): void } {
  const directory = mkdtempSync(path.join(os.tmpdir(), `nexus-steam-${process.getuid?.() ?? 0}-`));
  chmodSync(directory, 0o700);
  const socket = path.join(directory, 'launch.sock');
  const token = randomBytes(32).toString('hex');
  if (Buffer.byteLength(socket) > 100) { rmdirSync(directory); throw Error('Temporary directory path is too long for Steam handoff.'); }
  let finished = false, accepted = false;
  const peers = new Set<Socket>();
  const finish = () => { if (finished) return; close(); onFinished(); };
  const server = createServer(peer => {
    peers.add(peer);
    peer.setTimeout(3000, () => peer.destroy());
    let input = '';
    peer.on('error', () => {});
    peer.on('close', () => { peers.delete(peer); if (accepted && owner === peer) finish(); });
    peer.on('data', chunk => {
      input += chunk.toString();
      if (input.length > 65) { peer.destroy(); return; }
      if (!input.endsWith('\n')) return;
      if (accepted || input !== token + '\n') { peer.destroy(); return; }
      accepted = true; owner = peer;
      clearTimeout(timer); peer.setTimeout(0); peer.removeAllListeners('data');
      peer.write('ready\n');
    });
  });
  let owner: Socket | undefined;
  const timer = setTimeout(finish, timeoutMs);
  function close() {
    if (finished) return;
    finished = true; clearTimeout(timer);
    for (const peer of peers) peer.destroy();
    server.close(() => { try { rmdirSync(directory); } catch { /* Never remove unrelated files. */ } });
  }
  server.on('error', finish);
  // Unix sockets bind synchronously. Electron's single-instance call may
  // deliver the handoff while its sender is still blocked in that call, so
  // permissions must be private before returning, not in the listen callback.
  try { server.listen(socket); chmodSync(socket, 0o600); }
  catch (error) { close(); throw error; }
  return { handoff: { environment, lease: { socket, token } }, close };
}

export interface SteamLaunchLease { signal: AbortSignal; close(): void }
export async function acceptSteamHandoff(handoff: SteamHandoff): Promise<SteamLaunchLease> {
  const address = handoff.lease;
  const directory = path.dirname(address.socket);
  const parent = await fs.realpath(os.tmpdir());
  if (path.basename(address.socket) !== 'launch.sock' ||
      !new RegExp(`^nexus-steam-${process.getuid?.() ?? 0}-[A-Za-z0-9]{6}$`).test(path.basename(directory)) ||
      path.dirname(directory) !== os.tmpdir() || await fs.realpath(directory) !== path.join(parent, path.basename(directory)))
    throw Error('Invalid Steam handoff socket path.');
  const stat = lstatSync(directory);
  const target = lstatSync(address.socket);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) ||
      !target.isSocket() || target.uid !== process.getuid?.() || (target.mode & 0o077))
    throw Error('Unsafe Steam handoff socket.');
  const controller = new AbortController();
  const peer = createConnection(address.socket);
  peer.on('error', () => {}); // Also cover the handshake-to-owner transition.
  peer.on('close', () => controller.abort());
  try {
    await new Promise<void>((resolve, reject) => {
      let input = '';
      const timer = setTimeout(() => failed(Error('Steam handoff timed out.')), 3000);
      const failed = (error?: Error) => { cleanup(); reject(error ?? Error('Steam shortcut closed before launch.')); };
      const receive = (chunk: Buffer) => {
        input += chunk.toString();
        if (input === 'ready\n') { cleanup(); resolve(); }
        else if (input.length >= 6) failed(Error('Invalid Steam handoff response.'));
      };
      const cleanup = () => { clearTimeout(timer); peer.off('error', failed); peer.off('close', failed); peer.off('data', receive); };
      peer.once('error', failed); peer.once('close', failed); peer.on('data', receive);
      peer.once('connect', () => peer.write(address.token + '\n'));
    });
    return { signal: controller.signal, close: () => peer.end() };
  } catch (error) { peer.destroy(); throw error; }
}
