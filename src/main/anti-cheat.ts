import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Clear inherited per-launch markers; the package's own launcher controls EAC. */
export function antiCheatEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  // These are launch-scoped values, not global launcher preferences.
  delete result.EOS_USE_ANTICHEATCLIENTNULL;
  delete result.PROTON_EAC_LAUNCHER_PROCESS;
  // Keep PROTON_EAC_RUNTIME and PROTON_BATTLEYE_RUNTIME: they select the
  // actual compatibility bridges.
  return result;
}

/** The Steam installation roots in the user's home, native first, then Flatpak. */
function steamRoots(home: string): string[] {
  return [
    path.join(home, '.steam', 'root'),
    path.join(home, '.steam', 'steam'),
    path.join(home, '.local', 'share', 'Steam'),
    path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
  ];
}

/** Each Steam root followed by the libraries its VDF lists. */
async function steamLibraries(steamRoot: string): Promise<Set<string>> {
  const libraries = new Set([steamRoot]);
  try {
    const folders = await fs.readFile(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const match of folders.matchAll(/"path"\s*"((?:\\.|[^"\\])*)"/g)) {
      const folder = match[1].replace(/\\([\\"])/g, '$1');
      if (path.isAbsolute(folder)) libraries.add(folder);
    }
  } catch { /* Steam or a library listing need not exist. */ }
  return libraries;
}

/** Discover an already installed official Steam tool; never download or copy it. */
export async function installedEacRuntime(steamRoot: string): Promise<string | undefined> {
  for (const library of await steamLibraries(steamRoot)) {
    const root = path.join(library, 'steamapps', 'common', 'Proton EasyAntiCheat Runtime');
    try {
      for (const name of ['easyanticheat_x64.dll', 'easyanticheat_x64.so']) {
        const file = path.join(root, 'v2', 'lib64', name);
        await fs.access(file, constants.R_OK);
        if (!(await fs.stat(file)).isFile()) throw new Error('Not an EAC bridge file.');
      }
      return root;
    } catch { /* Incomplete installs must not be advertised as a runtime. */ }
  }
  return undefined;
}

/**
 * Discover Steam's official Proton BattlEye Runtime (app 1161040) in the
 * standard Steam locations. The Wine loader reads PROTON_BATTLEYE_RUNTIME and
 * loads beclient.dll from `v1/lib/wine` and beclient_x64.dll from
 * `v1/lib64/wine`; both bridges must be present for either architecture.
 * An absent or partial install is not a runtime, and nothing is downloaded.
 */
export async function installedBattlEyeRuntime(
  steamRoot: string,
  home = os.homedir(),
): Promise<string | undefined> {
  const libraries = new Set<string>();
  for (const root of new Set([steamRoot, ...steamRoots(home)])) {
    for (const library of await steamLibraries(root)) libraries.add(library);
  }
  for (const library of libraries) {
    const root = path.join(library, 'steamapps', 'common', 'Proton BattlEye Runtime');
    try {
      for (const [directory, name] of [['v1/lib/wine', 'beclient.dll'], ['v1/lib/wine', 'beclient.so'],
        ['v1/lib64/wine', 'beclient_x64.dll'], ['v1/lib64/wine', 'beclient_x64.so']] as const) {
        const file = path.join(root, directory, name);
        await fs.access(file, constants.R_OK);
        if (!(await fs.stat(file)).isFile()) throw new Error('Not a BattlEye bridge file.');
      }
      return root;
    } catch { /* Incomplete installs must not be advertised as a runtime. */ }
  }
  return undefined;
}
