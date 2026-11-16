import { spawn } from 'node:child_process';
import { externalLauncherEnvironment } from './launcher-environment.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {releasedInviteDllHashes,releasedInviteModules,releasedInviteSource} from './game-invite-runtime.js';
import { constants, promises as fs } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { backendDiagnostic, observeBackendChild } from './backend-diagnostics.js';
import { CredentialErrorReader } from './credential-errors.js';

export interface XodusServiceSession {
  socketPath: string;
  bridgePort: number;
  bridgeKey: string;
  stop(): Promise<void>;
}

export interface XodusBridge {
  port: number;
  key: string;
  stop(): Promise<void>;
}

export async function startXodusBridge(socketPath: string): Promise<XodusBridge> {
  const key = randomBytes(32).toString('hex');
  const expected = Buffer.from(key, 'ascii');
  const clients = new Set<Socket>();
  const server: Server = createServer((client) => {
    clients.add(client);
    client.once('close', () => clients.delete(client));
    client.setTimeout(10_000, () => client.destroy());
    let received = Buffer.alloc(0);
    const authenticate = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length < expected.length) return;
      const supplied = received.subarray(0, expected.length);
      if (!timingSafeEqual(supplied, expected)) { client.destroy(); return; }
      const remaining = received.subarray(expected.length);
      client.removeListener('data', authenticate);
      client.pause();
      client.setTimeout(0);
      const upstream = createConnection(socketPath);
      clients.add(upstream);
      upstream.once('close', () => clients.delete(upstream));
      upstream.once('error', () => client.destroy());
      client.once('error', () => upstream.destroy());
      upstream.once('connect', () => {
        if (remaining.length) upstream.write(remaining);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
    };
    client.on('data', authenticate);
    client.on('error', () => client.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not bind the Xodus loopback bridge.');
  return {
    port: address.port,
    key,
    stop: async () => {
      for (const socket of clients) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function socketReady(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function runtimeFeatures(winePath: string): Promise<unknown[]> {
  const root = path.resolve(path.dirname(winePath), '..', '..');
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(root, 'XODUS_NEXUS_PATCH.json'), 'utf8')) as { features?: unknown };
    return Array.isArray(metadata.features) ? metadata.features : [];
  } catch { return []; }
}

export async function cloudSaveRuntime(winePath: string): Promise<boolean> {
  const features = await runtimeFeatures(winePath);
  return features.includes('cloud-saves-pr28') && features.includes('xodus-tcp-bridge-v1');
}
export async function offlineIdentityRuntime(winePath: string): Promise<boolean> {
  return (await runtimeFeatures(winePath)).includes('xuser-offline-identity-v2');
}
export async function gameInviteRuntime(winePath:string):Promise<boolean>{
 if((await runtimeFeatures(winePath)).includes('xgame-invitations-v1'))return true;
 const root=path.resolve(path.dirname(winePath),'..','..');
 try{
  const metadata:unknown=JSON.parse(await fs.readFile(path.join(root,'XODUS_NEXUS_PATCH.json'),'utf8'));
  if(!releasedInviteSource(metadata))return false;
  const hashes=Object.fromEntries(await Promise.all(Object.keys(releasedInviteDllHashes).map(async arch=>[
   arch,createHash('sha256').update(await fs.readFile(path.join(root,'files/lib/wine',arch+'-windows/xgameruntime.dll'))).digest('hex'),
  ])));
  return releasedInviteModules(hashes);
 }catch{return false;}
}

export async function storeContentRuntime(winePath: string): Promise<boolean> {
  const features = await runtimeFeatures(winePath);
  return ['xstore-entitlements-v1', 'xpackage-content-v1', 'xstore-package-license-v1', 'xodus-tcp-bridge-v1', 'cloud-saves-pr28'].every(feature => features.includes(feature));
}

export async function storeDiscoveryRuntime(winePath: string): Promise<boolean> {
  const features = await runtimeFeatures(winePath);
  return ['xstore-related-discovery-v1', 'xstore-durable-license-v1', 'xstore-entitlements-v1', 'xodus-tcp-bridge-v1']
    .every(feature => features.includes(feature));
}

export async function unbridgedCloudSaveRuntime(winePath: string): Promise<boolean> {
  const features = await runtimeFeatures(winePath);
  return features.includes('cloud-saves-pr28') && !features.includes('xodus-tcp-bridge-v1');
}

export function selectedWinePath(
  configuredWine: string,
  runtimeRoot: string,
  activeWine: string | undefined,
): string | undefined {
  if (!configuredWine) return activeWine;
  const releases = path.join(runtimeRoot, 'releases');
  const relative = path.relative(releases, configuredWine);
  const isManaged = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  return isManaged && activeWine ? activeWine : configuredWine;
}

/** Linux AF_UNIX sun_path is 108 bytes including the terminator, so a socket
 * pathname may occupy at most 107 UTF-8 bytes. Rust's UnixListener::bind and
 * Python's socket.bind enforce this strictly; a longer path is rejected with
 * EINVAL / "path too long" before the service can ever listen. */
const MAX_SOCKET_PATH_BYTES = 107;
const SOCKET_NAME = 'xodus.sock';

/** Byte length as the kernel sees it, not JavaScript string length. */
export function socketPathBytes(socketPath: string): number {
  return Buffer.byteLength(socketPath, 'utf8');
}

export function socketPathFits(socketPath: string): boolean {
  return socketPathBytes(socketPath) <= MAX_SOCKET_PATH_BYTES;
}

/** A session directory is usable only when it is a real directory (not a
 * symlink), owned by this user, and private: no group or other permissions at
 * all. A merely world-readable base would expose the session listing. */
async function usableSessionBase(directory: string): Promise<boolean> {
  try {
    const info = await fs.lstat(directory);
    if (!info.isDirectory()) return false;
    if (info.uid !== process.getuid?.()) return false;
    return (info.mode & 0o077) === 0;
  } catch { return false; }
}

/** Short, private fallback bases. A long profile cannot host the socket, so the
 * session directory moves to a per-user location whose path is short enough.
 * Every candidate must already exist, be owned by this user, and be private or
 * a standard sticky OS temp directory; nothing is created here. */
function fallbackSessionBases(): string[] {
  const bases: string[] = [];
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime && path.isAbsolute(runtime)) bases.push(runtime);
  bases.push(os.tmpdir());
  return [...new Set(bases)];
}

async function stickyTempBase(directory: string): Promise<boolean> {
  try {
    const info = await fs.lstat(directory);
    if (!info.isDirectory()) return false;
    if (info.uid !== 0) return false;
    return (info.mode & 0o1000) !== 0 && (info.mode & 0o002) !== 0;
  } catch { return false; }
}

/** Creates the private per-session directory. The profile-local location is kept
 * whenever its socket path fits, so existing short profiles behave exactly as
 * before. Only a profile whose socket path is too long falls back to a short
 * private base, and the byte length is re-checked before anything is spawned. */
async function createSessionDirectory(userData: string): Promise<string> {
  const sessionRoot = path.join(userData, 'service-sessions');
  await fs.mkdir(sessionRoot, { recursive: true, mode: 0o700 });
  // mkdtemp adds six random characters, so the profile path is measured with
  // that reserve; the exact path is re-checked after creation.
  const profileReserve = path.join(sessionRoot, 'game-XXXXXX', SOCKET_NAME);
  if (socketPathFits(profileReserve)) {
    const directory = await fs.mkdtemp(path.join(sessionRoot, 'game-'));
    await fs.chmod(directory, 0o700);
    if (socketPathFits(path.join(directory, SOCKET_NAME))) return directory;
    await fs.rm(directory, { recursive: true, force: true });
  }
  for (const base of fallbackSessionBases()) {
    const privateBase = await usableSessionBase(base);
    if (!privateBase && !await stickyTempBase(base)) continue;
    if (!socketPathFits(path.join(base, 'nexus-service-XXXXXX', SOCKET_NAME))) continue;
    let directory: string;
    try { directory = await fs.mkdtemp(path.join(base, 'nexus-service-')); }
    catch { continue; }
    try {
      await fs.chmod(directory, 0o700);
      if (socketPathFits(path.join(directory, SOCKET_NAME))) return directory;
    } catch { /* fall through to remove and try the next base */ }
    await fs.rm(directory, { recursive: true, force: true });
  }
  throw new Error(
    `The Xodus account service socket path is too long (${socketPathBytes(profileReserve)} bytes; the limit is ${MAX_SOCKET_PATH_BYTES}). `
    + 'Move the launcher profile to a shorter path, or set XDG_RUNTIME_DIR to a short private directory.',
  );
}

export async function startXodusService(
  backendBinary: string,
  userData: string,
  onStatus: (message: string) => void,
  signal?: AbortSignal,
): Promise<XodusServiceSession> {
  const binary = path.join(path.dirname(backendBinary), 'xodus-service');
  try { await fs.access(binary, constants.X_OK); }
  catch { throw new Error('This Nexus backend has no xodus-service. Rebuild the managed backend to use Xbox cloud saves.'); }

  const runtimeDir = await createSessionDirectory(userData);
  const socketPath = path.join(runtimeDir, SOCKET_NAME);
  if (!socketPathFits(socketPath)) {
    await fs.rm(runtimeDir, { recursive: true, force: true });
    throw new Error('The Xodus account service socket path is too long.');
  }
  const child = spawn(binary, [], {
    env: { ...externalLauncherEnvironment(), XDG_RUNTIME_DIR: runtimeDir, XODUS_LOG: 'error' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  observeBackendChild(child, 'service');
  const credentialError = new CredentialErrorReader();
  child.stderr.on('data', (bytes: Buffer) => credentialError.push(bytes));
  let stopped = false;
  let bridge: XodusBridge | undefined;
  let exitCode: number | null = null;
  let spawnError: Error | undefined;
  child.on('error', (error) => { spawnError = error; });
  child.stdout.resume();
  child.stderr.resume();
  child.once('exit', (code) => { exitCode = code ?? -1; });
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (bridge) await bridge.stop();
    if (exitCode === null) {
      child.kill('SIGINT');
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 4000)),
      ]);
      if (exitCode === null) child.kill('SIGTERM');
    }
    await fs.rm(runtimeDir, { recursive: true, force: true });
    signal?.removeEventListener('abort', aborted);
  };

  const aborted = () => { child.kill('SIGINT'); };
  signal?.addEventListener('abort', aborted, { once: true });

  try {
    onStatus('Connecting the Xodus account service…');
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('Account service operation cancelled.');
      if (spawnError) throw new Error(`Could not start xodus-service: ${spawnError.message}`);
      if (await socketReady(socketPath)) {
        bridge = await startXodusBridge(socketPath);
        backendDiagnostic({ operation: 'service', event: 'validation', stage: 'ready' });
        onStatus('Xodus account service and private loopback bridge are ready.');
        return { socketPath, bridgePort: bridge.port, bridgeKey: bridge.key, stop };
      }
      if (exitCode !== null) throw new Error(credentialError.message ?? `xodus-service exited with code ${exitCode}. Check the stored Xodus account and network connection.`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    backendDiagnostic({ operation: 'service', event: 'validation', stage: 'timeout' });
    throw new Error('xodus-service did not become ready within 90 seconds. Check the stored Xodus account and network connection.');
  } catch (error) {
    await stop();
    throw error;
  }
}
