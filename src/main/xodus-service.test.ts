import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { gameInviteRuntime, offlineIdentityRuntime, selectedWinePath, socketPathBytes, socketPathFits, startXodusBridge, startXodusService, storeContentRuntime, storeDiscoveryRuntime } from './xodus-service.js';

it.each(['bin', 'bin-arm64'])('requires the offline identity v2 contract, not merely cloud support (%s)', async bin => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-offline-runtime-'));
  const wine = path.join(root, 'files', bin, 'wine');
  try {
    expect(await offlineIdentityRuntime(wine)).toBe(false);
    await fs.writeFile(path.join(root, 'XODUS_NEXUS_PATCH.json'), JSON.stringify({ features: ['cloud-saves-pr28', 'xuser-offline-identity-v1'] }));
    expect(await offlineIdentityRuntime(wine)).toBe(false);
    await fs.writeFile(path.join(root, 'XODUS_NEXUS_PATCH.json'), JSON.stringify({ features: ['xuser-offline-identity-v2'] }));
    expect(await offlineIdentityRuntime(wine)).toBe(true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('does not enable invitations for an older or unmarked runtime',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-invite-runtime-')),wine=path.join(root,'files/bin/wine');
  try{
    expect(await gameInviteRuntime(wine)).toBe(false);
    await fs.writeFile(path.join(root,'XODUS_NEXUS_PATCH.json'),JSON.stringify({features:['xodus-tcp-bridge-v1']}));expect(await gameInviteRuntime(wine)).toBe(false);
    await fs.writeFile(path.join(root,'XODUS_NEXUS_PATCH.json'),JSON.stringify({features:['xgame-invitations-v1']}));expect(await gameInviteRuntime(wine)).toBe(true);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

it.each(['credential', 'unknown', 'stdout'])('reports only safe service %s errors and cleans its private session directory', async mode => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-service-error-'));
  try {
    const marker = mode === 'unknown' ? 'NEXUS_CREDENTIAL_ERROR_V1 private-secret\n' : 'NEXUS_CREDENTIAL_ERROR_V1 keyring-unavailable\n';
    const body = `#!/usr/bin/env node\nprocess.stderr.write('private-account-token\\n');\nprocess.${mode === 'stdout' ? 'stdout' : 'stderr'}.write(${JSON.stringify(marker)});\nprocess.exitCode=1;\n`;
    await fs.writeFile(path.join(root,'xodus-service'), body, {mode:0o700});
    const error = await startXodusService(path.join(root,'xodus-cli'), path.join(root,'profile'), () => {}).then(() => '', e => e.message as string);
    expect(error).toContain(mode === 'credential' ? 'system keyring could not be accessed' : 'xodus-service exited with code 1');
    expect(error).not.toMatch(/private-account|private-secret/);
    expect(await fs.readdir(path.join(root,'profile/service-sessions'))).toEqual([]);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

it('requires all genuine Store/content/bridge runtime capabilities, not just an installed Wine binary', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-content-runtime-'));
  try {
    const wine = path.join(root, 'files/bin/wine');
    expect(await storeContentRuntime(wine)).toBe(false);
    const features = ['xstore-entitlements-v1', 'xpackage-content-v1', 'xstore-package-license-v1', 'xodus-tcp-bridge-v1', 'cloud-saves-pr28'];
    for (const missing of features) {
      await fs.writeFile(path.join(root, 'XODUS_NEXUS_PATCH.json'), JSON.stringify({ features: features.filter(feature => feature !== missing) }));
      expect(await storeContentRuntime(wine)).toBe(false);
    }
    await fs.writeFile(path.join(root, 'XODUS_NEXUS_PATCH.json'), JSON.stringify({ features }));
    expect(await storeContentRuntime(wine)).toBe(true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('enables public DLC discovery only with all matching runtime capabilities', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-discovery-runtime-'));
  try {
    const wine=path.join(root,'files/bin/wine');expect(await storeDiscoveryRuntime(wine)).toBe(false);
    const features=['xstore-related-discovery-v1','xstore-durable-license-v1','xstore-entitlements-v1','xodus-tcp-bridge-v1'];
    for(const missing of features){
      await fs.writeFile(path.join(root,'XODUS_NEXUS_PATCH.json'),JSON.stringify({features:features.filter(feature=>feature!==missing)}));
      expect(await storeDiscoveryRuntime(wine)).toBe(false);
    }
    await fs.writeFile(path.join(root,'XODUS_NEXUS_PATCH.json'),JSON.stringify({features}));expect(await storeDiscoveryRuntime(wine)).toBe(true);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

describe('selectedWinePath', () => {
  const root = '/data/runtimes';
  const active = '/data/runtimes/releases/new/files/bin/wine';

  it('follows the managed runtime pointer when settings still name an older release', () => {
    expect(selectedWinePath('/data/runtimes/releases/old/files/bin/wine', root, active)).toBe(active);
  });

  it('uses one external configured Wine for every game', () => {
    expect(selectedWinePath('/custom/global/wine', root, active)).toBe('/custom/global/wine');
    expect(selectedWinePath('', root, active)).toBe(active);
  });
});

describe('startXodusBridge', () => {
  it('forwards authenticated loopback traffic to the private Unix socket', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xodus-bridge-test-'));
    const socketPath = path.join(dir, 'backend.sock');
    let connections = 0;
    const backend = createServer((socket) => {
      connections += 1;
      socket.on('data', (chunk) => socket.write(chunk));
    });
    backend.listen(socketPath);
    await once(backend, 'listening');
    const bridge = await startXodusBridge(socketPath);
    try {
      const client = createConnection(bridge.port, '127.0.0.1');
      await once(client, 'connect');
      client.write(`${bridge.key}ping`);
      const [reply] = await once(client, 'data') as [Buffer];
      expect(reply.toString()).toBe('ping');
      client.destroy();

      const rejected = createConnection(bridge.port, '127.0.0.1');
      await once(rejected, 'connect');
      rejected.write(`${'0'.repeat(64)}ping`);
      await once(rejected, 'close');
      expect(connections).toBe(1);
    } finally {
      await bridge.stop();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('service socket path policy', () => {
  it('measures the pathname in UTF-8 bytes, not string length', () => {
    expect(socketPathBytes('/tmp/ascii')).toBe(10);
    // Multi-byte characters must count as their encoded width.
    expect(socketPathBytes('/tmp/žluťoučký')).toBe(Buffer.byteLength('/tmp/žluťoučký', 'utf8'));
    expect(socketPathBytes('/tmp/žluťoučký')).toBeGreaterThan('/tmp/žluťoučký'.length);
  });

  it('accepts at most 107 bytes, the Linux sun_path limit without the terminator', () => {
    const base = '/tmp/';
    const at = (bytes: number) => base + 'a'.repeat(bytes - base.length);
    expect(socketPathFits(at(107))).toBe(true);
    expect(socketPathFits(at(108))).toBe(false);
    expect(socketPathFits(at(200))).toBe(false);
  });

  it('rejects a long path by byte length even when the string is short', () => {
    // 55 two-byte characters = 115 bytes but only 60 JS characters.
    const wide = '/tmp/' + 'ů'.repeat(55);
    expect(wide.length).toBeLessThan(107);
    expect(socketPathBytes(wide)).toBeGreaterThan(107);
    expect(socketPathFits(wide)).toBe(false);
  });
});

describe('startXodusService socket placement', () => {
  const shortBase = async () => {
    // A short private base keeps the profile-local socket under the 107-byte limit.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-'));
    return root;
  };

  const serviceFixture = async (root: string, body: string) => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'xodus-service'), body, { mode: 0o700 });
    return path.join(root, 'xodus-cli');
  };

  it('keeps the profile-local session directory for a short profile', async () => {
    const root = await shortBase();
    try {
      // The fixture reports the socket path it was given, then exits.
      const binary = await serviceFixture(root, `#!/usr/bin/env node\nprocess.stdout.write(process.env.XDG_RUNTIME_DIR+'\\n');process.exitCode=1;\n`);
      const profile = path.join(root, 'p');
      const error = await startXodusService(binary, profile, () => {}).then(() => '', e => e.message as string);
      expect(error).toContain('xodus-service exited with code 1');
      // Profile-local layout is unchanged for short profiles; the session is cleaned up.
      expect(await fs.readdir(path.join(profile, 'service-sessions'))).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('moves the session to a short private base when the profile path is too long', async () => {
    const root = await shortBase();
    const record = path.join(root, 'used-dir');
    try {
      // The fixture records the exact XDG_RUNTIME_DIR it was given, then exits.
      const binary = await serviceFixture(root, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(record)}, process.env.XDG_RUNTIME_DIR);process.exitCode=1;\n`);
      // Deep profile whose profile-local socket path would exceed 107 bytes.
      const profile = path.join(root, 'deep', 'x'.repeat(60), 'y'.repeat(60), 'z'.repeat(40));
      await fs.mkdir(profile, { recursive: true, mode: 0o700 });
      const error = await startXodusService(binary, profile, () => {}).then(() => '', e => e.message as string);
      expect(error).toContain('xodus-service exited with code 1');
      const used = await fs.readFile(record, 'utf8');
      // It must be a private per-session directory whose socket path fits.
      expect(path.basename(used)).toMatch(/^nexus-service-/);
      expect(used.startsWith(profile)).toBe(false);
      expect(socketPathFits(path.join(used, 'xodus.sock'))).toBe(true);
      // The session directory is removed after the service stops.
      await expect(fs.access(used)).rejects.toThrow();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('reports a clear path error, not a credential error, when no safe base fits', async () => {
    const root = await shortBase();
    const previous = { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, TMPDIR: process.env.TMPDIR };
    try {
      const binary = await serviceFixture(root, '#!/usr/bin/env node\nprocess.exitCode=1;\n');
      // Force every candidate base to be unusable: a long XDG_RUNTIME_DIR and a
      // TMPDIR that is itself too long to host the socket.
      const longBase = path.join(root, 'r'.repeat(80), 's'.repeat(80));
      await fs.mkdir(longBase, { recursive: true, mode: 0o700 });
      process.env.XDG_RUNTIME_DIR = longBase;
      process.env.TMPDIR = longBase;
      const profile = path.join(root, 'deep', 'x'.repeat(60), 'y'.repeat(60));
      await fs.mkdir(profile, { recursive: true, mode: 0o700 });
      const error = await startXodusService(binary, profile, () => {}).then(() => '', e => e.message as string);
      expect(error).toMatch(/socket path is too long/i);
      expect(error).not.toMatch(/keyring|network connection|stored Xodus account/i);
    } finally {
      if (previous.XDG_RUNTIME_DIR === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous.XDG_RUNTIME_DIR;
      if (previous.TMPDIR === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous.TMPDIR;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['world-writable non-sticky', 0o777],
    ['group-writable', 0o770],
    ['world-readable non-sticky', 0o755],
  ])('refuses an unsafe %s fallback base with a path error, not a credential error', async (_label, mode) => {
    const root = await shortBase();
    const previous = { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, TMPDIR: process.env.TMPDIR };
    try {
      const binary = await serviceFixture(root, '#!/usr/bin/env node\nprocess.exitCode=1;\n');
      const base = path.join(root, 'base');
      await fs.mkdir(base, { recursive: true, mode });
      await fs.chmod(base, mode);
      process.env.XDG_RUNTIME_DIR = base;
      process.env.TMPDIR = base;
      const profile = path.join(root, 'deep', 'x'.repeat(60), 'y'.repeat(60));
      await fs.mkdir(profile, { recursive: true, mode: 0o700 });
      const error = await startXodusService(binary, profile, () => {}).then(() => '', e => e.message as string);
      expect(error).toMatch(/socket path is too long/i);
      expect(error).not.toMatch(/keyring|network connection|stored Xodus account/i);
      // Nothing is left behind in a base we refused.
      expect((await fs.readdir(base)).filter(name => name.startsWith('nexus-service-'))).toEqual([]);
    } finally {
      if (previous.XDG_RUNTIME_DIR === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous.XDG_RUNTIME_DIR;
      if (previous.TMPDIR === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous.TMPDIR;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a symlinked fallback base instead of following it', async () => {
    const root = await shortBase();
    const previous = { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, TMPDIR: process.env.TMPDIR };
    try {
      const binary = await serviceFixture(root, '#!/usr/bin/env node\nprocess.exitCode=1;\n');
      const real = path.join(root, 'real');
      await fs.mkdir(real, { recursive: true, mode: 0o700 });
      const link = path.join(root, 'link');
      await fs.symlink(real, link);
      process.env.XDG_RUNTIME_DIR = link;
      process.env.TMPDIR = link;
      const profile = path.join(root, 'deep', 'x'.repeat(60), 'y'.repeat(60));
      await fs.mkdir(profile, { recursive: true, mode: 0o700 });
      const error = await startXodusService(binary, profile, () => {}).then(() => '', e => e.message as string);
      expect(error).toMatch(/socket path is too long/i);
      // The symlink target must not receive a session directory.
      expect((await fs.readdir(real)).filter(name => name.startsWith('nexus-service-'))).toEqual([]);
    } finally {
      if (previous.XDG_RUNTIME_DIR === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous.XDG_RUNTIME_DIR;
      if (previous.TMPDIR === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous.TMPDIR;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('never reuses a predictable shared name and isolates two concurrent sessions', async () => {
    const root = await shortBase();
    try {
      const binary = await serviceFixture(root, `#!/usr/bin/env node\nprocess.stdout.write(process.env.XDG_RUNTIME_DIR+'\\n');process.exitCode=1;\n`);
      const profile = path.join(root, 'deep', 'x'.repeat(60), 'y'.repeat(60), 'z'.repeat(40));
      await fs.mkdir(profile, { recursive: true, mode: 0o700 });
      const seen: string[] = [];
      const run = () => startXodusService(binary, profile, () => {}).then(() => '', e => e.message as string);
      await Promise.all([run(), run()]);
      // Both sessions must clean up after themselves.
      const leftovers = await fs.readdir(os.tmpdir()).catch(() => [] as string[]);
      const ours = leftovers.filter(name => name.startsWith('nexus-service-'));
      expect(ours.length).toBe(0);
      expect(seen.length).toBe(0);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
