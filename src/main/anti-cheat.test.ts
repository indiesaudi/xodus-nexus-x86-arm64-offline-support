import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { antiCheatEnvironment, installedBattlEyeRuntime, installedEacRuntime } from './anti-cheat.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function bridge(library: string): Promise<string> {
  const root = path.join(library, 'steamapps/common/Proton EasyAntiCheat Runtime');
  await mkdir(path.join(root, 'v2/lib64'), { recursive: true });
  for (const name of ['easyanticheat_x64.dll', 'easyanticheat_x64.so']) await writeFile(path.join(root, 'v2/lib64', name), 'test fixture');
  return root;
}

describe('anti-cheat launch environment', () => {
  it('does not inherit a Null Client or launcher-only marker for online play', () => {
    const original = {
      EOS_USE_ANTICHEATCLIENTNULL: '1', PROTON_EAC_LAUNCHER_PROCESS: '1',
      PROTON_EAC_RUNTIME: '/runtime/eac', WINEPREFIX: '/prefix',
    };
    const result = antiCheatEnvironment(original);
    expect(result).not.toHaveProperty('EOS_USE_ANTICHEATCLIENTNULL');
    expect(result).not.toHaveProperty('PROTON_EAC_LAUNCHER_PROCESS');
    expect(result.PROTON_EAC_RUNTIME).toBe('/runtime/eac');
    expect(result.WINEPREFIX).toBe('/prefix');
    expect(original.EOS_USE_ANTICHEATCLIENTNULL).toBe('1');
  });

  it('never enables the Null Client on the shared Play path', () => {
    const original = { PATH: '/bin' };
    expect(antiCheatEnvironment(original)).toEqual(original);
  });
});

describe('installed EAC runtime discovery', () => {
  it('finds a complete bridge in the default Steam library', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexus-eac-'));
    temporary.push(root);
    expect(await installedEacRuntime(root)).toBeUndefined();
    const runtime = await bridge(root);
    expect(await installedEacRuntime(root)).toBe(runtime);
    await rm(path.join(runtime, 'v2/lib64/easyanticheat_x64.so'));
    expect(await installedEacRuntime(root)).toBeUndefined();
  });

  it('checks secondary libraries and decodes quoted VDF paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexus-eac-libraries-'));
    temporary.push(root);
    const secondary = path.join(root, 'secondary "library"');
    const runtime = await bridge(secondary);
    await mkdir(path.join(root, 'steamapps'), { recursive: true });
    await writeFile(path.join(root, 'steamapps/libraryfolders.vdf'), `"libraryfolders" { "1" { "path" ${JSON.stringify(secondary)} } "2" { "path" "relative-path" } }`);
    expect(await installedEacRuntime(root)).toBe(runtime);
  });
});

// The official layout of Steam app 1161040: both Wine bridges per architecture.
async function battlEyeBridge(library: string): Promise<string> {
  const root = path.join(library, 'steamapps/common/Proton BattlEye Runtime');
  for (const [directory, name] of [['v1/lib/wine', 'beclient.dll'], ['v1/lib/wine', 'beclient.so'],
    ['v1/lib64/wine', 'beclient_x64.dll'], ['v1/lib64/wine', 'beclient_x64.so']] as const) {
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, name), 'test fixture');
  }
  return root;
}

/** A home without Steam, so only the fixture locations are searched. */
async function emptyHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'nexus-be-home-'));
  temporary.push(home);
  return home;
}

describe('installed BattlEye runtime discovery', () => {
  it('finds a complete official tool in the default Steam library', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexus-be-'));
    temporary.push(root);
    const home = await emptyHome();
    expect(await installedBattlEyeRuntime(root, home)).toBeUndefined();
    const runtime = await battlEyeBridge(root);
    expect(await installedBattlEyeRuntime(root, home)).toBe(runtime);
  });

  it('checks secondary libraries and decodes quoted VDF paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexus-be-libraries-'));
    temporary.push(root);
    const secondary = path.join(root, 'secondary "library"');
    const runtime = await battlEyeBridge(secondary);
    await mkdir(path.join(root, 'steamapps'), { recursive: true });
    await writeFile(path.join(root, 'steamapps/libraryfolders.vdf'), `"libraryfolders" { "1" { "path" ${JSON.stringify(secondary)} } "2" { "path" "relative-path" } }`);
    expect(await installedBattlEyeRuntime(root, await emptyHome())).toBe(runtime);
  });

  it('finds a complete official tool in a Flatpak Steam installation', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'nexus-be-flatpak-'));
    temporary.push(home);
    const flatpakRoot = path.join(home, '.var/app/com.valvesoftware.Steam/.local/share/Steam');
    const runtime = await battlEyeBridge(flatpakRoot);
    expect(await installedBattlEyeRuntime(path.join(home, '.steam/root'), home)).toBe(runtime);
  });

  it('rejects absent and partial installs, and never accepts another tool', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexus-be-partial-'));
    temporary.push(root);
    const home = await emptyHome();
    // An EAC runtime is not a BattlEye runtime.
    await mkdir(path.join(root, 'steamapps/common/Proton EasyAntiCheat Runtime/v2/lib64'), { recursive: true });
    await writeFile(path.join(root, 'steamapps/common/Proton EasyAntiCheat Runtime/v2/lib64/easyanticheat_x64.so'), 'test fixture');
    expect(await installedBattlEyeRuntime(root, home)).toBeUndefined();
    const runtime = await battlEyeBridge(root);
    for (const file of ['v1/lib/wine/beclient.so', 'v1/lib64/wine/beclient_x64.dll', 'v1/lib64/wine/beclient_x64.so']) {
      await rm(path.join(runtime, file));
      expect(await installedBattlEyeRuntime(root, home)).toBeUndefined();
      await writeFile(path.join(runtime, file), 'test fixture');
    }
  });
});
