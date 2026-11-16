import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSteamLaunchEnvironment, steamGameEnvironment } from './steam-launch-context.js';
import { prepareProtonRunner } from './proton.js';
import { vcOperationEnvironment } from './vc-runtime.js';

const execFile = promisify(execFileCallback);
const created: string[] = [];
afterEach(async () => { await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

// The Steam client's own shader-cache environment, as reported in issue 595.
const steamCache = {
  MESA_SHADER_CACHE_DIR: '/home/u/.local/share/Steam/steamapps/shadercache/4139748769',
  MESA_SHADER_CACHE_MAX_SIZE: '1G',
  MESA_DISK_CACHE_SINGLE_FILE: '1',
  MESA_DISK_CACHE_READ_ONLY_FOZ_DBS: '/home/u/.local/share/Steam/steamapps/shadercache/4139748769/foz',
  MESA_GLSL_CACHE_DIR: '/home/u/.local/share/Steam/steamapps/shadercache/4139748769/glsl',
  MESA_GLSL_CACHE_MAX_SIZE: '1G',
  __GL_SHADER_DISK_CACHE_PATH: '/home/u/.local/share/Steam/steamapps/shadercache/4139748769/nv',
  __GL_SHADER_DISK_CACHE_APP_NAME: 'app',
  __GL_SHADER_DISK_CACHE_READ_ONLY_APP_NAME: 'ro',
  __GL_SHADER_DISK_CACHE_SKIP_CLEANUP: '1',
  DXVK_STATE_CACHE_PATH: '/home/u/.local/share/Steam/steamapps/shadercache/4139748769/dxvk',
  ENABLE_VK_LAYER_VALVE_steam_fossilize_1: '1',
  STEAM_FOSSILIZE_DUMP_PATH: '/home/u/.local/share/Steam/steamapps/shadercache/4139748769/foz',
};
const steamCacheNames = Object.keys(steamCache);
// Explicit Vulkan loader configuration is not Steam's; it must survive.
const explicitVulkan = { VK_LAYER_PATH: '/home/u/.local/share/vulkan/explicit_layer.d', VK_INSTANCE_LAYERS: 'VK_LAYER_MESA_device_select' };
const steamIdentity = { SteamGameId: '4139748769', SteamAppId: '4139748769' };

/**
 * A runtime payload whose Wine records the environment the game process
 * actually receives. The generated runner script is executed, not just read.
 */
// Synthetic x86_64 and aarch64 layouts exercise the shared launcher policy.
// These are not native Standard/CachyOS runtime or hardware tests.
const layouts = [
  { layout: 'x86_64', bin: 'bin', prefix: 'default_pfx', required: ['libvkd3d-utils-1.dll', 'dxgi.dll', 'd3d12.dll'] },
  { layout: 'aarch64', bin: 'bin-arm64', prefix: 'default_pfx_arm64', required: ['dxgi.dll', 'd3d12.dll'] },
] as const;

async function runtime(layout = layouts[0]) {
  const root = await mkdtemp(path.join(tmpdir(), 'nexus-cache595-')); created.push(root);
  const files = path.join(root, 'runtime/files');
  const wine = path.join(files, layout.bin, 'wine');
  const compat = path.join(root, 'compat');
  const record = path.join(root, 'environment.txt');
  await mkdir(path.dirname(wine), { recursive: true });
  await mkdir(path.join(files, 'share', layout.prefix), { recursive: true });
  await writeFile(wine, `#!/bin/sh\nenv > ${JSON.stringify(record)}\n`, { mode: 0o700 });
  const touch = layout.required.map((name) => `"$root/${name}"`).join(' ');
  await writeFile(path.join(root, 'runtime/proton'), `#!/bin/sh\nroot="$STEAM_COMPAT_DATA_PATH/pfx/drive_c/windows/system32"\nmkdir -p "$root"\ntouch ${touch}\n`, { mode: 0o700 });
  await writeFile(path.join(files, layout.bin, 'wineserver'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const runner = (await prepareProtonRunner(wine, compat, path.join(root, 'steam')))!;
  return { root, runner, compat, record, layout };
}

async function recorded(record: string): Promise<Record<string, string>> {
  const text = await readFile(record, 'utf8');
  return Object.fromEntries(text.split('\n').filter(Boolean).map((line) => {
    const equals = line.indexOf('=');
    return [line.slice(0, equals), line.slice(equals + 1)] as const;
  }));
}


/** Apply overrides to the real process environment and restore exact prior values. */
async function withProcessEnvironment<T>(overrides: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(overrides).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try { return await run(); }
  finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe('issue 595: Steam shader cache inheritance', () => {
  it.each(layouts)('cold start from a game shortcut uses the managed per-prefix cache ($layout)', async (layout) => {
    const { runner, compat, record } = await runtime(layout);
    // Nexus was started by Steam, so its main process carries Steam's cache paths.
    const main = { PATH: process.env.PATH, HOME: '/home/u', ...steamCache, ...explicitVulkan, ...steamIdentity };
    const launch = steamGameEnvironment(main, captureSteamLaunchEnvironment(main));
    await execFile(runner.command, ['game.exe'], { env: launch as NodeJS.ProcessEnv });
    const game = await recorded(record);
    const caches = path.join(compat, 'shadercache');
    expect(game.MESA_SHADER_CACHE_DIR).toBe(path.join(caches, 'mesa'));
    expect(game.MESA_SHADER_CACHE_MAX_SIZE).toBe('4G');
    expect(game.__GL_SHADER_DISK_CACHE_PATH).toBe(path.join(caches, 'nvidia'));
    expect(game.VKD3D_SHADER_CACHE_PATH).toBe(path.join(caches, 'vkd3d-proton'));
    expect(game.STEAM_COMPAT_SHADER_PATH).toBeUndefined();
    // Steam's single-file/read-only/Fossilize switches are gone.
    for (const name of ['MESA_DISK_CACHE_SINGLE_FILE', 'MESA_DISK_CACHE_READ_ONLY_FOZ_DBS', 'MESA_GLSL_CACHE_DIR',
      'MESA_GLSL_CACHE_MAX_SIZE', '__GL_SHADER_DISK_CACHE_APP_NAME', '__GL_SHADER_DISK_CACHE_READ_ONLY_APP_NAME',
      '__GL_SHADER_DISK_CACHE_SKIP_CLEANUP', 'DXVK_STATE_CACHE_PATH', 'ENABLE_VK_LAYER_VALVE_steam_fossilize_1',
      'STEAM_FOSSILIZE_DUMP_PATH']) expect(game[name]).toBeUndefined();
    // Steam identity and explicit Vulkan loader configuration are preserved.
    expect(game.SteamGameId).toBe('4139748769');
    expect(game.SteamAppId).toBe('4139748769');
    expect(game).toMatchObject(explicitVulkan);
  });

  it('the AppImage added directly to Steam behaves like a game shortcut', async () => {
    const { runner, compat, record } = await runtime();
    // Directly added: Steam sets its identity and cache paths, but no handoff.
    const main = { PATH: process.env.PATH, HOME: '/home/u', ...steamCache, ...explicitVulkan, ...steamIdentity };
    await execFile(runner.command, ['game.exe'], { env: steamGameEnvironment(main, captureSteamLaunchEnvironment(main)) as NodeJS.ProcessEnv });
    const game = await recorded(record);
    expect(game.MESA_SHADER_CACHE_DIR).toBe(path.join(compat, 'shadercache/mesa'));
    expect(game.ENABLE_VK_LAYER_VALVE_steam_fossilize_1).toBeUndefined();
    expect(game).toMatchObject(explicitVulkan);
  });

  it('a normally started Nexus keeps custom cache settings for a later Steam shortcut', async () => {
    const { runner, compat, record } = await runtime();
    // Warm: Nexus started from the desktop with the user's own cache settings.
    const main = { PATH: process.env.PATH, HOME: '/home/u', MESA_SHADER_CACHE_DIR: '/home/u/custom-mesa', DXVK_STATE_CACHE_PATH: '/home/u/custom-dxvk' };
    const launch = steamGameEnvironment(main, steamIdentity);
    await execFile(runner.command, ['game.exe'], { env: launch as NodeJS.ProcessEnv });
    const game = await recorded(record);
    expect(game.MESA_SHADER_CACHE_DIR).toBe('/home/u/custom-mesa');
    expect(game.DXVK_STATE_CACHE_PATH).toBe('/home/u/custom-dxvk');
    // The managed defaults never replace an explicit value.
    expect(game.MESA_SHADER_CACHE_MAX_SIZE).toBeUndefined();
    expect(game.MESA_SHADER_CACHE_DIR).not.toBe(path.join(compat, 'shadercache/mesa'));
    expect(game.SteamGameId).toBe('4139748769');
  });

  it('sanitizes a Steam-started primary that opened Nexus from its own shortcut', async () => {
    const { runner, compat, record } = await runtime();
    // Nexus itself was started by Steam, then its own shortcut session context
    // arrives (launcher session, not a game request). The primary is still a
    // Steam start, so the managed per-prefix cache applies.
    const main = { PATH: process.env.PATH, HOME: '/home/u', ...steamCache, ...steamIdentity };
    const launcherSession = captureSteamLaunchEnvironment({ ...steamIdentity, SteamOverlayGameId: '4139748769' });
    const launch = steamGameEnvironment(main, launcherSession);
    await execFile(runner.command, ['game.exe'], { env: launch as NodeJS.ProcessEnv });
    const game = await recorded(record);
    expect(game.MESA_SHADER_CACHE_DIR).toBe(path.join(compat, 'shadercache/mesa'));
    expect(game.ENABLE_VK_LAYER_VALVE_steam_fossilize_1).toBeUndefined();
    expect(game.SteamGameId).toBe('4139748769');
  });

  it('per-game launch options still override the managed cache', async () => {
    const { runner, compat, record } = await runtime();
    const main = { PATH: process.env.PATH, HOME: '/home/u', ...steamCache, ...steamIdentity };
    const launch = steamGameEnvironment(main, captureSteamLaunchEnvironment(main));
    // The game wrapper runs `env MESA_SHADER_CACHE_DIR=... <runner>` above this.
    await execFile('/usr/bin/env', ['MESA_SHADER_CACHE_DIR=/home/u/per-game', 'DXVK_STATE_CACHE_PATH=/home/u/per-game-dxvk', runner.command, 'game.exe'],
      { env: launch as NodeJS.ProcessEnv });
    const game = await recorded(record);
    expect(game.MESA_SHADER_CACHE_DIR).toBe('/home/u/per-game');
    expect(game.DXVK_STATE_CACHE_PATH).toBe('/home/u/per-game-dxvk');
    expect(game.MESA_SHADER_CACHE_MAX_SIZE).toBeUndefined();
    expect(game.MESA_SHADER_CACHE_DIR).not.toBe(path.join(compat, 'shadercache/mesa'));
  });

  it.each(layouts)('prefix initialization receives the sanitized copy, not the main process environment ($layout)', async (layout) => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexus-cache595-prefix-')); created.push(root);
    const files = path.join(root, 'runtime/files');
    const wine = path.join(files, layout.bin, 'wine');
    const compat = path.join(root, 'compat');
    const record = path.join(root, 'prefix-environment.txt');
    await mkdir(path.dirname(wine), { recursive: true });
    await mkdir(path.join(files, 'share', layout.prefix), { recursive: true });
    await writeFile(wine, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    // Record the environment of the prefix-initialization run.
    const touch = layout.required.map((name) => `"$root/${name}"`).join(' ');
    await writeFile(path.join(root, 'runtime/proton'), `#!/bin/sh\nenv > ${JSON.stringify(record)}\nroot="$STEAM_COMPAT_DATA_PATH/pfx/drive_c/windows/system32"\nmkdir -p "$root"\ntouch ${touch}\n`, { mode: 0o700 });
    await writeFile(path.join(files, layout.bin, 'wineserver'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const main = { PATH: process.env.PATH, HOME: '/home/u', ...steamCache, ...steamIdentity };
    const launch = steamGameEnvironment(main, captureSteamLaunchEnvironment(main));
    // The sanitizer must never mutate the real process environment object.
    const before = { ...process.env };
    await prepareProtonRunner(wine, compat, path.join(root, 'steam'), undefined, { environment: launch });
    expect(process.env).toEqual(before);
    const initialized = await recorded(record);
    for (const name of steamCacheNames) expect(initialized[name]).toBeUndefined();
    expect(initialized.SteamGameId).toBe('0');
    // The caller's environment object is untouched by the sanitizer.
    expect(main.MESA_SHADER_CACHE_DIR).toBe(steamCache.MESA_SHADER_CACHE_DIR);
  });

  // The VC++ operation (index.ts installGameVcRuntime) has no incoming game
  // launch context: it builds ONE sanitized copy of the primary process
  // environment and passes it to prepareProtonRunner and to the installer.
  // These tests exercise that exact production seam with the real process
  // environment as input. They do NOT drive the Electron IPC handler end to
  // end (installGameVcRuntime is module-private); the real-IPC fixture mocks
  // prepareProtonRunner and cannot safely host a runner-returning variant.
  it('VC operation: one sanitized primary copy reaches prefix init and installer', async () => {
    const { root, runner } = await runtime();
    const record = path.join(root, 'vc-prefix-environment.txt');
    const files = path.join(root, 'runtime/files');
    const wine = path.join(files, 'bin/wine');
    // A fresh, uninitialized prefix so the initialization run really happens.
    const compat = path.join(root, 'vc-compat');
    await writeFile(path.join(root, 'runtime/proton'), `#!/bin/sh\nenv > ${JSON.stringify(record)}\nroot="$STEAM_COMPAT_DATA_PATH/pfx/drive_c/windows/system32"\nmkdir -p "$root"\ntouch "$root/libvkd3d-utils-1.dll" "$root/dxgi.dll" "$root/d3d12.dll"\n`, { mode: 0o700 });
    const overrides = { ...steamCache, ...steamIdentity, WINEDEBUG: undefined };
    const before = Object.fromEntries(Object.keys(overrides).map((name) => [name, process.env[name]]));
    await withProcessEnvironment(overrides, async () => {
      // The exact production seam installGameVcRuntime calls.
      const { environment, installerEnvironment } = vcOperationEnvironment();
      for (const name of steamCacheNames) expect(installerEnvironment[name]).toBeUndefined();
      expect(installerEnvironment.WINEDEBUG).toBe('-fixme');
      // Prefix initialization receives the same copy.
      await prepareProtonRunner(wine, compat, path.join(root, 'steam'), undefined, { environment });
      const initialized = await recorded(record);
      for (const name of steamCacheNames) expect(initialized[name]).toBeUndefined();
      expect(initialized.SteamGameId).toBe('0');
      // The sanitizer never mutated the real process environment.
      for (const name of Object.keys(overrides)) expect(process.env[name]).toBe(overrides[name]);
    });
    for (const name of Object.keys(overrides)) expect(process.env[name]).toBe(before[name]);
  });

  it('VC operation: a normally started Nexus keeps its custom cache settings', async () => {
    const { root } = await runtime();
    const record = path.join(root, 'vc-warm-environment.txt');
    const files = path.join(root, 'runtime/files');
    const wine = path.join(files, 'bin/wine');
    const compat = path.join(root, 'vc-compat-warm');
    await writeFile(path.join(root, 'runtime/proton'), `#!/bin/sh\nenv > ${JSON.stringify(record)}\nroot="$STEAM_COMPAT_DATA_PATH/pfx/drive_c/windows/system32"\nmkdir -p "$root"\ntouch "$root/libvkd3d-utils-1.dll" "$root/dxgi.dll" "$root/d3d12.dll"\n`, { mode: 0o700 });
    const custom = { MESA_SHADER_CACHE_DIR: '/home/u/custom-mesa', DXVK_STATE_CACHE_PATH: '/home/u/custom-dxvk' };
    const before = Object.fromEntries(Object.keys(custom).map((name) => [name, process.env[name]]));
    await withProcessEnvironment({ ...custom, SteamGameId: undefined, SteamAppId: undefined }, async () => {
      const { environment, installerEnvironment } = vcOperationEnvironment();
      expect(installerEnvironment).toMatchObject(custom);
      await prepareProtonRunner(wine, compat, path.join(root, 'steam'), undefined, { environment });
      expect(await recorded(record)).toMatchObject(custom);
    });
    for (const name of Object.keys(custom)) expect(process.env[name]).toBe(before[name]);
  });
});
