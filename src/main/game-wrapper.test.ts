import { copyFileSync, existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { prepareGameWrapper } from './game-wrapper.js';
import { defaultLaunchTools } from '../shared/launch-tools.js';
import { run } from './process.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true,force:true}))); });
async function setup() {
  const root=await mkdtemp(path.join(tmpdir(), 'nexus-launch-tools-')); roots.push(root);
  const bin=path.join(root, "tool's bin"); await mkdir(bin);
  const tool=async(name:string,body:string)=>{const file=path.join(bin,name);await writeFile(file,`#!/bin/sh\n${body}\n`);await chmod(file,0o700);return file;};
  const wine=await tool('wine',`printf '%s\\n' "$DXVK_HUD" "$WINEDLLOVERRIDES" "$XODUS_SOCKET"; printf '<%s>\\n' "$@"; exit 7`);
  return {root,bin,tool,wine,env:{...process.env,PATH:`${bin}:/usr/bin:/bin`,XODUS_SOCKET:'/private-synthetic-socket'}};
}
it('leaves the default launch command unchanged without creating files',async()=>{
  const {root,wine}=await setup(); const dir=path.join(root,'wrappers');
  expect((await prepareGameWrapper(wine,undefined,dir)).command).toBe(wine);
  await expect(stat(dir)).rejects.toThrow();
});
it('applies the DualSense HIDRAW workaround per game without changing inherited Steam Input or other controllers', async () => {
  const { root, wine, env } = await setup();
  await writeFile(wine, '#!/bin/sh\nprintf "%s\\n" "$PROTON_DISABLE_HIDRAW" "$SteamGameId" "$SDL_GAMECONTROLLERCONFIG"\n');
  const source = { ...env, PROTON_DISABLE_HIDRAW: '1', SteamGameId: '16968485195965530112', SDL_GAMECONTROLLERCONFIG: 'mapping with spaces' };
  const wrapper = await prepareGameWrapper(wine, { ...defaultLaunchTools, launchOptions: 'PROTON_DISABLE_HIDRAW=0x054c/0x0ce6 %command%' }, path.join(root, 'wrappers'), source);
  const changed = await run(wrapper.command, [], { env: source });
  expect(changed.code).toBe(0);
  expect(changed.output.trimEnd()).toBe('0x054c/0x0ce6\n16968485195965530112\nmapping with spaces');
  const unmodified = await prepareGameWrapper(wine, undefined, path.join(root, 'other'), source);
  expect((await run(unmodified.command, [], { env: source })).output.trimEnd()).toBe('1\n16968485195965530112\nmapping with spaces');
  expect(source.PROTON_DISABLE_HIDRAW).toBe('1');
});
it('preserves quoted environment, literal arguments, original identity and actual exit status',async()=>{
  const {root,wine,env}=await setup();
  const wrapper=await prepareGameWrapper(wine,{...defaultLaunchTools,launchOptions:'DXVK_HUD="fps,frametimes" WINEDLLOVERRIDES="dxgi=n,b;winhttp=b" %command% --launcher-skip "two words" "literal $HOME"'},path.join(root,'wrappers'),env);
  const result=await run(wrapper.command,['original game.exe'],{env});
  expect(result.code).toBe(7); expect(result.output).toContain('fps,frametimes\ndxgi=n,b;winhttp=b\n/private-synthetic-socket');
  expect(result.output).toContain('<original game.exe>\n<--launcher-skip>\n<two words>\n<literal $HOME>');
  await wrapper.cleanup(); await expect(stat(wrapper.command)).rejects.toThrow();
});
it.each([undefined, '', '0', '0x1234/0xabcd', '0x054C/0x0CE6', '1'])('scopes the optional DualSense mode and preserves existing HIDRAW exclusions: %s', async disabled => {
  const { root, wine, env } = await setup();
  await writeFile(wine, '#!/bin/sh\nprintf "%s\\n" "$PROTON_DISABLE_HIDRAW" "$PROTON_ENABLE_HIDRAW" "$SteamGameId" "$SDL_GAMECONTROLLERCONFIG"\n');
  const source = { ...env, PROTON_DISABLE_HIDRAW: disabled, PROTON_ENABLE_HIDRAW:'0x045e/0x0b12', SteamGameId:'16968485195965530112', SDL_GAMECONTROLLERCONFIG:'Xbox mapping' };
  const before = { ...source };
  const wrapper = await prepareGameWrapper(wine, { ...defaultLaunchTools, dualSenseCompatibility:true }, path.join(root,'wrappers'), source);
  const expected = disabled === '1' || /0x054c\/0x0ce6/i.test(disabled ?? '') ? disabled : [disabled === '0' ? '' : disabled, '0x054c/0x0ce6'].filter(Boolean).join(',');
  expect((await run(wrapper.command, [], { env:source })).output).toBe(`${expected}\n0x045e/0x0b12\n16968485195965530112\nXbox mapping\n`);
  expect(source).toEqual(before);
  const other = await prepareGameWrapper(wine, undefined, path.join(root,'other'), source);
  expect(other.command).toBe(wine);
  expect((await run(other.command, [], { env:source })).output).toBe(`${disabled ?? ''}\n0x045e/0x0b12\n16968485195965530112\nXbox mapping\n`);
  await wrapper.cleanup();
});
it('combines DualSense compatibility with explicit game-only exclusions, keeping the custom wrapper and arguments', async () => {
  const { root, wine, env, tool } = await setup();
  await writeFile(wine, '#!/bin/sh\nprintf "%s\\n" "$PROTON_DISABLE_HIDRAW" "$@"\n');
  await tool('custom-wrap', 'exec "$@"');
  const wrapper = await prepareGameWrapper(wine, { ...defaultLaunchTools, dualSenseCompatibility:true,
    launchOptions:'PROTON_DISABLE_HIDRAW=0x1234/0xabcd custom-wrap %command% "two words"' }, path.join(root,'wrappers'), { ...env, PROTON_DISABLE_HIDRAW:'1' });
  expect((await run(wrapper.command, ['game.exe'], { env })).output).toBe('0x1234/0xabcd,0x054c/0x0ce6\ngame.exe\ntwo words\n');
});
it('supports MangoHud directly and gamescope with mangoapp, never wrapping a launcher process',async()=>{
  const {root,bin,wine,env:baseEnv,tool}=await setup();
  const env={...baseEnv,PATH:bin};
  await tool('mangohud',`echo MANGO; exec "$@"`);
  await tool('gamemoderun',`echo GAMEMODE; exec "$@"`);
  await tool('gamescope',`echo GAMESCOPE; while [ "$1" != -- ]; do printf '%s\\n' "$1"; shift; done; shift; exec "$@"`);
  const dir=path.join(root,'wrappers');
  const mango=await prepareGameWrapper(wine,{...defaultLaunchTools,mangoHud:true},dir,env);
  expect((await run(mango.command,['game.exe'],{env})).output).toContain('MANGO');
  await expect(prepareGameWrapper(wine,{...defaultLaunchTools,mangoHud:true,gamescope:true},dir,env)).rejects.toThrow('mangoapp');
  await tool('mangoapp','exit 99'); // Presence check only, gamescope owns its launch.
  const scope=await prepareGameWrapper(wine,{...defaultLaunchTools,mangoHud:true,gamescope:true,gamescopeArgs:'-W 1920 -f',launchOptions:'gamemoderun %command%'},dir,env);
  const result=await run(scope.command,['game.exe'],{env});
  expect(result.output).toContain('GAMEMODE\nGAMESCOPE\n-W\n1920\n-f\n--mangoapp');
  expect(result.output).not.toContain('\nMANGO\n'); expect(result.code).toBe(7);
  expect(await readFile(scope.command,'utf8')).not.toContain('xodus-cli');
});
it('passes a Proton compat-config launch option as literal data and never evaluates it', async () => {
  const { root, wine, env } = await setup();
  const marker = path.join(root, 'executed-by-a-shell');
  await writeFile(wine, '#!/bin/sh\nprintf "config=<%s>\\n" "$STEAM_COMPAT_CONFIG"\nprintf "arg=<%s>\\n" "$@"; exit 7');
  const value = `cmdlineappend:--flag=$(touch ${marker}) \`touch ${marker}\`;x,wined3d`;
  const wrapper = await prepareGameWrapper(wine, { ...defaultLaunchTools,
    launchOptions: `STEAM_COMPAT_CONFIG="${value}" %command%` }, path.join(root, 'wrappers'), env);
  const result = await run(wrapper.command, ['game.exe'], { env });
  expect(result.code).toBe(7);
  expect(result.output).toContain(`config=<${value}>`);
  expect(result.output).toContain('arg=<game.exe>');
  // The assignment was not interpreted by a shell: only the literal value
  // reached the command environment and no attempt was made to run its content.
  expect(await readFile(wrapper.command, 'utf8')).toContain("'STEAM_COMPAT_CONFIG=");
  await expect(stat(marker)).rejects.toThrow();
  // The same rule holds for a value that itself contains a single quote.
  const quoted = "cmdlineappend:it's,localshadercache";
  const second = await prepareGameWrapper(wine, { ...defaultLaunchTools,
    launchOptions: `STEAM_COMPAT_CONFIG="${quoted}" %command%` }, path.join(root, 'other'), env);
  expect((await run(second.command, ['game.exe'], { env })).output).toContain(`config=<${quoted}>`);
  await wrapper.cleanup(); await second.cleanup();
});

it('fails clearly before starting a configured missing tool',async()=>{
  const {root,wine}=await setup();
  await expect(prepareGameWrapper(wine,{...defaultLaunchTools,mangoHud:true},path.join(root,'wrappers'),{PATH:root})).rejects.toThrow('mangohud');
});


it.each([false,true])('uses SDL fallback only for selected PlayStation controllers and retains Steam mappings (both: %s)',async(both)=>{
  const {root,wine,env}=await setup();
  await writeFile(wine,'#!/bin/sh\nprintf "%s\\n" "$PROTON_DISABLE_HIDRAW" "$SDL_GAMECONTROLLERCONFIG" "$SteamGameId"\n');
  const source={...env,PROTON_DISABLE_HIDRAW:'0x045e/0x0b12,0x054C/0x09CC',SDL_GAMECONTROLLERCONFIG:'user mapping',SteamGameId:'123'};
  const before={...source};
  const wrapper=await prepareGameWrapper(wine,{...defaultLaunchTools,dualShock4Compatibility:true,dualSenseCompatibility:both},path.join(root,'wrappers'),source);
  const result=await run(wrapper.command,[],{env:source});
  expect(result.output.split('\n')).toEqual([
    '0x045e/0x0b12,0x054C/0x09CC,'+(both?'0x054c/0x0ce6,':'')+'0x054c/0x05c4,0x054c/0x0ba0',
    'user mapping','123','',
  ]);
  expect(source).toEqual(before);await wrapper.cleanup();
});

// The Steam overlay is restored only for the game's own Wine entry, from
// libraries the launcher resolved in the trusted Steam installation.
const sharedObject = (): string => (process.report?.getReport?.() as { sharedObjects?: string[] } | undefined)
  ?.sharedObjects?.find(file => file.endsWith('/libc.so.6'))
  ?? ['/lib/x86_64-linux-gnu/libc.so.6', '/usr/lib/x86_64-linux-gnu/libc.so.6', '/lib64/libc.so.6']
    .find(file => existsSync(file)) ?? '';

it('restores the Steam overlay only around the game command, after launch tools', async () => {
  const { root, wine, env } = await setup();
  // A real executable launch tool that forwards its arguments unchanged.
  const tool = path.join(root, "tool's bin", 'custom-wrap');
  await writeFile(tool, '#!/bin/sh\nprintf "tool=<%s>\\n" "$LD_PRELOAD"\nexec "$@"'); await chmod(tool, 0o700);
  await writeFile(wine, '#!/bin/sh\nprintf "wine=<%s>\\n" "$LD_PRELOAD"\nprintf "arg=<%s>\\n" "$@"\nexit 7');
  const overlay = [path.join(root, 'steamrt64', 'gameoverlayrenderer.so'), path.join(root, 'steamrt32', 'gameoverlayrenderer.so')];
  for (const library of overlay) { await mkdir(path.dirname(library), { recursive: true }); copyFileSync(sharedObject(), library); }
  const source = { ...env, SteamGameId: '456' };
  const before = { ...source };
  const wrapper = await prepareGameWrapper(wine, { ...defaultLaunchTools, launchOptions: 'custom-wrap %command% "two words"' },
    path.join(root, 'wrappers'), source, root, { steamOverlayLibraries: overlay });
  const result = await run(wrapper.command, ['game.exe'], { env: source });
  // The launch tool never receives the overlay, Wine does; identity, arguments
  // and exit status are the game's own.
  expect(result.code).toBe(7);
  expect(result.output).toBe(`tool=<>\nwine=<${overlay.join(':')}>\narg=<game.exe>\narg=<two words>\n`);
  expect(source).toEqual(before);
  await wrapper.cleanup();
});

it('preserves preloads added by a forwarding game tool at execution time', async () => {
  const { root, wine, env } = await setup();
  const keep = path.join(root, 'tool-preload.so'); copyFileSync(sharedObject(), keep);
  const overlay = [path.join(root, 'overlay64.so'), path.join(root, 'overlay32.so')];
  for (const library of overlay) copyFileSync(sharedObject(), library);
  const tool = path.join(root, "tool's bin", 'dynamic-wrap');
  await writeFile(tool, '#!/bin/sh\nexport LD_PRELOAD="${TOOL_PRELOAD}${LD_PRELOAD:+:$LD_PRELOAD}"\nexec "$@"'); await chmod(tool, 0o700);
  await writeFile(wine, '#!/bin/sh\nprintf "%s\\n" "$LD_PRELOAD" "$@"\nexit 7');
  const source = { ...env, TOOL_PRELOAD: keep };
  const wrapper = await prepareGameWrapper(wine, { ...defaultLaunchTools, launchOptions: 'dynamic-wrap %command% "two words"' },
    path.join(root, 'dynamic'), source, root, { steamOverlayLibraries: overlay });
  try {
    const result = await run(wrapper.command, ['game.exe'], { env: source });
    expect(result.code).toBe(7);
    expect(result.output).toBe(`${keep}:${overlay.join(':')}\ngame.exe\ntwo words\n`);
    expect(source).not.toHaveProperty('LD_PRELOAD');
  } finally { await wrapper.cleanup(); }
});

it('honours an explicit game LD_PRELOAD, including the empty opt-out, over the restored overlay', async () => {
  const { root, wine, env } = await setup();
  const overlay = [path.join(root, 'steamrt64', 'gameoverlayrenderer.so')];
  await mkdir(path.dirname(overlay[0]), { recursive: true }); copyFileSync(sharedObject(), overlay[0]);
  // The fixture reports its view of the environment, so a preload value never
  // has to be a real loadable object here.
  await writeFile(wine, '#!/bin/sh\nprintf "%s\\n" "$LD_PRELOAD" "$@"; exit 3');
  const before = { ...env };
  for (const value of ['', '/custom/keep.so', overlay[0]]) {
    const wrapper = await prepareGameWrapper(wine, { ...defaultLaunchTools, launchOptions: `LD_PRELOAD="${value}" %command%` },
      path.join(root, `wrappers-${value.length}`), env, root, { steamOverlayLibraries: overlay });
    // The game's own value wins, as one literal word for the game command only.
    expect(await readFile(wrapper.command, 'utf8')).toContain(`'LD_PRELOAD=${value}'`);
    expect(await readFile(wrapper.command, 'utf8')).not.toContain(`'${overlay[0]}'`);
    const result = await run(wrapper.command, ['game.exe'], { env });
    expect(result.code).toBe(3);
    // A nonexistent custom value is reported by the loader, never replaced.
    expect(result.output).toContain(`${value}\ngame.exe\n`);
    // The trusted pair is used only when the game did not choose a value.
    if (value !== overlay[0]) expect(await readFile(wrapper.command, 'utf8')).not.toContain(`${overlay[0]}:`);
    expect(env).toEqual(before);
    await wrapper.cleanup();
  }
});

it('extends an inherited launcher preload instead of skipping the restoration', async () => {
  const { root, wine, env } = await setup();
  await writeFile(wine, '#!/bin/sh\nprintf "%s\\n" "$LD_PRELOAD"');
  const overlay = [path.join(root, 'steamrt64', 'gameoverlayrenderer.so'), path.join(root, 'steamrt32', 'gameoverlayrenderer.so')];
  for (const library of overlay) { await mkdir(path.dirname(library), { recursive: true }); copyFileSync(sharedObject(), library); }
  const keep = path.join(root, 'keep.so'); copyFileSync(sharedObject(), keep);
  for (const [inherited, expected] of [
    ['', overlay.join(':')],
    [keep, `${keep}:${overlay.join(':')}`],
    [`${overlay[0]} ${keep}`, `${overlay[0]} ${keep}:${overlay[1]}`],
    [overlay.join(':'), overlay.join(':')],
  ]) {
    const source = { ...env, LD_PRELOAD: inherited };
    const before = { ...source };
    const wrapper = await prepareGameWrapper(wine, undefined, path.join(root, `inherited-${inherited.length}`), source, root,
      { steamOverlayLibraries: overlay });
    try {
      const result = await run(wrapper.command, [], { env: source });
      expect(result.code).toBe(0);
      expect(result.output).toBe(`${expected}\n`);
      expect(source).toEqual(before);
    } finally { await wrapper.cleanup(); }
  }
});

it('keeps the default fast path and creates nothing when no overlay applies', async () => {
  const { root, wine } = await setup();
  const dir = path.join(root, 'wrappers');
  expect((await prepareGameWrapper(wine, undefined, dir, process.env, root, {})).command).toBe(wine);
  expect((await prepareGameWrapper(wine, undefined, dir, process.env, root, { steamOverlayLibraries: [] })).command).toBe(wine);
  await expect(stat(dir)).rejects.toThrow();
});
