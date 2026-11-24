import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as realFs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * ARM64 managed-family contract against production code, on any host.
 *
 * Every fixture is inert: synthetic text files plus minimal 64-byte ELF headers
 * with an explicit e_machine, so nothing depends on the host architecture and
 * nothing is executed. There is no native ARM64 toolchain, package or hardware
 * here, so nothing is synthesised as a "working" ARM64 runtime and no native ARM
 * or game readiness is claimed. It covers payload verification and rejection, the
 * architecture-bound template link, archive extraction, mixed-architecture
 * release selection, and installer update/failure behaviour with preserved state.
 */

const family = 'nexus', sourceCommit = 'a'.repeat(40), sourceRepository = 'domsvoboda/nexus-runtime', buildId = 'b'.repeat(64);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const arm64Inventory = [
  'proton', 'files/bin-arm64/wine', 'files/bin-arm64/wineserver', 'files/bin-arm64/wine.nexus-original',
  'files/share/xodus-nexus/compat/PlayFabGameSave.dll',
  'files/share/xodus-nexus/compat/gaming-services-version.exe',
  'files/share/xodus-nexus/compat/package-registration.exe',
  ...['aarch64', 'x86_64', 'i386'].flatMap(cpu => ['xgameruntime.dll', 'winhttp.dll', 'libnghttp2.dll'].map(name => `files/lib/wine/${cpu}-windows/${name}`)),
];
const zMapping = 'files/share/default_pfx_arm64/dosdevices/z:';
/** Minimal inert 64-bit ELF identification block; no code and not executable.
 * The machine is explicit, so these fixtures behave identically on any host. */
const elfHeader = (machine: number) => { const bytes = Buffer.alloc(64); bytes[0] = 0x7f; bytes[1] = 0x45; bytes[2] = 0x4c; bytes[3] = 0x46; bytes[4] = 2; bytes[5] = 1; bytes[6] = 1; bytes.writeUInt16LE(machine, 18); return bytes; };
const arm64Header = elfHeader(183), x64Header = elfHeader(62);
const isArm64Loader = (name: string) => /^files\/bin-arm64\/(wine|wineserver|wine\.nexus-original)$/.test(name);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await realFs.rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await realFs.mkdtemp(path.join(os.tmpdir(), 'arm64-feasibility-'));
  roots.push(root);
  const files: Record<string, string> = {};
  for (const name of arm64Inventory) {
    const file = path.join(root, name);
    await realFs.mkdir(path.dirname(file), { recursive: true });
    const bytes = isArm64Loader(name) ? arm64Header : Buffer.from('synthetic inert ' + name);
    await realFs.writeFile(file, bytes, { mode: 0o755 });
    files[name] = hash(bytes);
  }
  await realFs.mkdir(path.join(root, 'files/share/default_pfx_arm64'), { recursive: true });
  await realFs.mkdir(path.dirname(path.join(root, zMapping)), { recursive: true });
  await realFs.symlink('/', path.join(root, zMapping));
  const metadata = JSON.stringify({
    schema: 1, sourceLockSha256: 'c'.repeat(64), sourceGraph: { proton: sourceCommit },
    targetArchitecture: 'arm64', binDirectory: 'bin-arm64', defaultPrefix: 'default_pfx_arm64',
    componentsByArch: { 'aarch64-windows': { 'xgameruntime.dll': files['files/lib/wine/aarch64-windows/xgameruntime.dll'] } },
  });
  await realFs.writeFile(path.join(root, 'XODUS_NEXUS_PATCH.json'), metadata);
  files['XODUS_NEXUS_PATCH.json'] = hash(metadata);
  const manifest = JSON.stringify({ schema: 1, family, buildId, sourceRepository, sourceCommit, arch: 'arm64', prefixSchema: 1, sourceLockSha256: 'c'.repeat(64), files, symlinks: { [zMapping]: '/' } });
  await realFs.writeFile(path.join(root, 'nexus-family.json'), manifest);
  return { root, pointer: { schema: 1 as const, family, sourceRepository, sourceCommit, manifestSha256: hash(manifest), buildId } };
}

it('rejects a relabelled x86_64 loader and wrong-host requests before any payload is adopted', async () => {
  const { verifyRuntimeFamilyPayload } = await import('./runtime-families');
  const { root, pointer } = await fixture();
  // Deterministic x86_64 ELF header (e_machine 62): claiming those bytes as the
  // ARM64 loader must fail on any host, including a real ARM64 machine.
  const loader = path.join(root, 'files/bin-arm64/wine');
  await realFs.writeFile(loader, x64Header);
  const file = path.join(root, 'nexus-family.json'), manifest = JSON.parse(await realFs.readFile(file, 'utf8'));
  manifest.files['files/bin-arm64/wine'] = hash(x64Header);
  const bytes = JSON.stringify(manifest);
  await realFs.writeFile(file, bytes);
  await expect(verifyRuntimeFamilyPayload(root, { ...pointer, manifestSha256: hash(bytes) }, 'arm64')).rejects.toThrow('not a native aarch64 executable');
  // A 64-byte non-ELF blob with the right length is rejected as well.
  const blob = Buffer.alloc(64, 0x41);
  await realFs.writeFile(loader, blob);
  manifest.files['files/bin-arm64/wine'] = hash(blob);
  const blobBytes = JSON.stringify(manifest);
  await realFs.writeFile(file, blobBytes);
  await expect(verifyRuntimeFamilyPayload(root, { ...pointer, manifestSha256: hash(blobBytes) }, 'arm64')).rejects.toThrow('not a native aarch64 executable');
  // A minimal inert aarch64 header satisfies the native-header contract.
  const arm = arm64Header;
  await realFs.writeFile(loader, arm);
  manifest.files['files/bin-arm64/wine'] = hash(arm);
  const armBytes = JSON.stringify(manifest);
  await realFs.writeFile(file, armBytes);
  await expect(verifyRuntimeFamilyPayload(root, { ...pointer, manifestSha256: hash(armBytes) }, 'arm64')).resolves.toMatchObject({ arch: 'arm64' });
  // The same inventory claimed as an x64 payload is a different identity.
  const x64Bytes = JSON.stringify({ ...manifest, arch: 'x64' });
  await realFs.writeFile(file, x64Bytes);
  await expect(verifyRuntimeFamilyPayload(root, { ...pointer, manifestSha256: hash(x64Bytes) }, 'x64')).rejects.toThrow('Runtime launch file missing');
  // Unsupported hosts never resolve a managed family payload.
  await expect(verifyRuntimeFamilyPayload(root, pointer, 'ia32')).rejects.toThrow('not built for ia32');
});


/**
 * ARM64 install/update/failure behaviour through the production installer.
 * Payload files are inert synthetic text except the three loader entry points,
 * which carry a minimal aarch64 ELF header (no code). Nothing is executed and no
 * network is used; the ARM64 release/archive/candidate metadata is synthetic.
 * This is not native ARM64 or game evidence.
 */
async function arm64Release(root: string, letter: string) {
  const commit = letter.repeat(40), repository = 'domsvoboda/nexus-runtime', name = 'nexus-runtime-11.0-experimental-arm64-g' + commit.slice(0, 8);
  const directory = path.join(root, 'remote-' + letter, name), files: Record<string, string> = {};
  const graph = { proton: commit, wine: 'c'.repeat(40), xgameruntime: 'd'.repeat(40) };
  for (const file of arm64Inventory) {
    await realFs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    const bytes = isArm64Loader(file) ? arm64Header : Buffer.from('inert arm64 ' + letter + ' ' + file);
    await realFs.writeFile(path.join(directory, file), bytes, { mode: 0o755 });
    files[file] = hash(bytes);
  }
  await realFs.mkdir(path.dirname(path.join(directory, zMapping)), { recursive: true });
  await realFs.symlink('/', path.join(directory, zMapping));
  const metadata = JSON.stringify({ schema: 1, sourceLockSha256: '1'.repeat(64), sourceGraph: graph, requiresBackendVersion: '0.2.13', requiresLauncherVersion: '0.4.1',
    targetArchitecture: 'arm64', binDirectory: 'bin-arm64', defaultPrefix: 'default_pfx_arm64',
    componentsByArch: { 'aarch64-windows': { 'xgameruntime.dll': files['files/lib/wine/aarch64-windows/xgameruntime.dll'] } } });
  await realFs.writeFile(path.join(directory, 'XODUS_NEXUS_PATCH.json'), metadata);
  files['XODUS_NEXUS_PATCH.json'] = hash(metadata);
  const identity = { schema: 1, family, sourceRepository, sourceCommit: commit, arch: 'arm64', prefixSchema: 1, sourceLockSha256: '1'.repeat(64), files, symlinks: { [zMapping]: '/' } };
  const buildId = hash(JSON.stringify(identity));
  await realFs.writeFile(path.join(directory, 'nexus-family.json'), JSON.stringify({ ...identity, buildId }));
  const archiveName = name + '-aarch64.tar.xz', archiveFile = path.join(root, 'remote-' + letter, archiveName);
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  await promisify(execFile)('tar', ['-cJf', archiveFile, '-C', path.dirname(directory), name]);
  const archive = await realFs.readFile(archiveFile), sourceName = name + '-source.tar.xz';
  const assets = new Map<string, Buffer>([[archiveName, archive], [name + '-aarch64.sha512sum', Buffer.from(createHash('sha512').update(archive).digest('hex') + '  ' + archiveName + '\n')],
    [sourceName, Buffer.from('inert arm64 source')], [sourceName.replace(/\.tar\.xz$/, '.sha512sum'), Buffer.from(createHash('sha512').update('inert arm64 source').digest('hex') + '  ' + sourceName + '\n')]]);
  const candidate = { schema: 1, kind: 'runtime', arch: 'arm64', repository, commit, ref: 'refs/heads/main', runId: '789',
    files: [...assets].map(([file, bytes]) => ({ name: file, sha256: hash(bytes), size: bytes.length })), sourceGraph: graph,
    requiresBackendVersion: '0.2.13', requiresLauncherVersion: '0.4.1',
    validation: { nativeGateCount: 16, treeSha256: '2'.repeat(64), resultsSha256: '3'.repeat(64), realGameTest: false, stableApproved: false } };
  const bytes = Buffer.from(JSON.stringify(candidate));
  assets.set('candidate.json', bytes);
  const tag = 'runtime-11.0-arm64-20261103-g' + commit.slice(0, 8);
  const release = { tag_name: tag, target_commitish: commit, draft: false, prerelease: true, published_at: '2026-11-03T12:43:55Z',
    assets: [...assets].map(([file, data]) => ({ name: file, size: data.length, browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${file}` })) };
  return { buildId, archiveName, assets, release };
}
const armPolicy = { allowCachyos: false, allowPrerelease: true };

it('installs and updates the ARM64 Standard family while preserving save, legacy pointer and retained build', async () => {
  const { ManagedRuntimeManager } = await import('./managed-runtime');
  const root = await realFs.mkdtemp(path.join(os.tmpdir(), 'arm64-install-')); roots.push(root);
  const runtimeRoot = path.join(root, 'runtime'), save = path.join(root, 'compatdata/game/pfx/save.dat');
  await realFs.mkdir(path.dirname(save), { recursive: true }); await realFs.writeFile(save, 'preserve progress');
  const before = await realFs.stat(save);
  await realFs.mkdir(runtimeRoot, { recursive: true });
  const legacy = path.join(runtimeRoot, 'current.json'); await realFs.writeFile(legacy, 'legacy default untouched');
  let remote = await arm64Release(root, 'a');
  const fetcher = (async (input: URL | RequestInfo) => {
    const url = String(input), file = url.split('/').pop()!;
    if (url.includes('/releases?')) return new Response(JSON.stringify([remote.release]));
    const bytes = remote.assets.get(file); if (!bytes) throw Error('Unexpected request ' + url);
    return new Response(bytes);
  }) as typeof fetch;
  const { RuntimeManager } = await import('./runtime');
  const manager = new RuntimeManager(runtimeRoot, () => {}, () => false, fetcher, 'arm64', () => ({ launcher: '0.5.1', backend: '0.2.14' }));
  const install = async () => {
    const status = await manager.checkManagedRuntime('nexus', armPolicy);
    expect(status.error).toBeUndefined();
    return manager.installManagedRuntime('nexus', status.available!.candidateSha256, armPolicy);
  };
  expect(await install()).toMatchObject({ family: 'nexus', success: true, committed: true });
  const { resolveRuntimeFamily, resolveRuntimeFamilyBuild } = await import('./runtime-families');
  const a = await resolveRuntimeFamily(runtimeRoot, 'nexus', 'arm64');
  expect(a.arch).toBe('arm64');
  expect(a.winePath).toBe(path.join(a.root, 'files/bin-arm64/wine'));
  remote = await arm64Release(root, 'b');
  const status = await manager.checkManagedRuntime('nexus', armPolicy);
  expect(status.updateAvailable).toBe(true);
  expect(status.available!.archiveName).toMatch(/-arm64-g[0-9a-f]{8}-aarch64\.tar\.xz$/);
  expect((await manager.installManagedRuntime('nexus', status.available!.candidateSha256, armPolicy)).success).toBe(true);
  const b = await resolveRuntimeFamily(runtimeRoot, 'nexus', 'arm64');
  expect(b.buildId).toBe(remote.buildId); expect(b.buildId).not.toBe(a.buildId);
  expect((await resolveRuntimeFamilyBuild(runtimeRoot, 'nexus', a, 'arm64')).buildId).toBe(a.buildId);
  expect(await realFs.readFile(save, 'utf8')).toBe('preserve progress');
  expect((await realFs.stat(save)).ino).toBe(before.ino);
  expect(await realFs.readFile(legacy, 'utf8')).toBe('legacy default untouched');
});

it('rejects an ARM64 payload containing an x64 loader and keeps pointer, save and staging clean', async () => {
  const root = await realFs.mkdtemp(path.join(os.tmpdir(), 'arm64-mismatch-')); roots.push(root);
  const runtimeRoot = path.join(root, 'runtime'), save = path.join(root, 'compatdata/game/pfx/save.dat');
  await realFs.mkdir(path.dirname(save), { recursive: true }); await realFs.writeFile(save, 'preserve progress');
  const remote = await arm64Release(root, 'a');
  // Swap the published archive's loader for an inert x86_64 ELF header, resealing
  // the inner manifest, archive checksum, candidate and release so that only the
  // ARM64 native-header rule can reject the install.
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  const directory = path.join(root, 'remote-a', 'nexus-runtime-11.0-experimental-arm64-g' + 'a'.repeat(8));
  const loaderFile = path.join(directory, 'files/bin-arm64/wine');
  await realFs.writeFile(loaderFile, x64Header);
  // Re-seal the inner family manifest so the payload inventory, checksums and the
  // derived buildId all still hold; only the ARM64 native-header rule can then fail.
  const manifestFile = path.join(directory, 'nexus-family.json');
  const manifest = JSON.parse(await realFs.readFile(manifestFile, 'utf8'));
  manifest.files['files/bin-arm64/wine'] = hash(x64Header);
  const { buildId: previousBuildId, ...identity } = manifest;
  const buildId = hash(JSON.stringify(identity));
  await realFs.writeFile(manifestFile, JSON.stringify({ ...identity, buildId }));
  expect(buildId).not.toBe(previousBuildId);
  const name = path.basename(directory), archiveFile = path.join(root, 'remote-a', remote.archiveName);
  await promisify(execFile)('tar', ['-cJf', archiveFile, '-C', path.dirname(directory), name]);
  const archive = await realFs.readFile(archiveFile);
  remote.assets.set(remote.archiveName, archive);
  const sumName = name + '-aarch64.sha512sum';
  remote.assets.set(sumName, Buffer.from(createHash('sha512').update(archive).digest('hex') + '  ' + remote.archiveName + '\n'));
  const candidate = JSON.parse(remote.assets.get('candidate.json')!.toString('utf8'));
  // Bind exactly the four selected assets; the archive icon's digest/size change.
  candidate.files = candidate.files.map((item: { name: string; sha256: string; size: number }) =>
    remote.assets.has(item.name) ? { ...item, sha256: hash(remote.assets.get(item.name)!), size: remote.assets.get(item.name)!.length } : item);
  const bytes = Buffer.from(JSON.stringify(candidate)); remote.assets.set('candidate.json', bytes);
  const tag = remote.release.tag_name;
  remote.release.assets = [...remote.assets].map(([file, data]) => ({ name: file, size: data.length, browser_download_url: `https://github.com/domsvoboda/nexus-runtime/releases/download/${tag}/${file}` }));
  const fetcher = (async (input: URL | RequestInfo) => {
    const url = String(input), file = url.split('/').pop()!;
    if (url.includes('/releases?')) return new Response(JSON.stringify([remote.release]));
    const data = remote.assets.get(file); if (!data) throw Error('Unexpected request ' + url);
    return new Response(data);
  }) as typeof fetch;
  const { RuntimeManager } = await import('./runtime');
  const manager = new RuntimeManager(runtimeRoot, () => {}, () => false, fetcher, 'arm64', () => ({ launcher: '0.5.1', backend: '0.2.14' }));
  const status = await manager.checkManagedRuntime('nexus', armPolicy);
  expect(status.available).toBeDefined();
  const result = await manager.installManagedRuntime('nexus', status.available!.candidateSha256, armPolicy);
  expect(result).toMatchObject({ success: false, committed: false });
  // The failure is the ARM64 native-header rule, not an earlier checksum check.
  expect(result.error).toContain('not a native aarch64 executable');
  await expect(realFs.access(path.join(runtimeRoot, 'variants/nexus/current.json'))).rejects.toThrow();
  expect(await realFs.readFile(save, 'utf8')).toBe('preserve progress');
  expect(await realFs.readdir(runtimeRoot).then(entries => entries.filter(entry => entry.startsWith('.staging-')))).toEqual([]);
});

it('refuses ARM64 CachyOS at check and never resolves it, while the ARM64 Standard offer stays selectable', async () => {
  const root = await realFs.mkdtemp(path.join(os.tmpdir(), 'arm64-cachy-')); roots.push(root);
  const remote = await arm64Release(root, 'a');
  const fetcher = (async (input: URL | RequestInfo) => {
    const url = String(input), file = url.split('/').pop()!;
    if (url.includes('/releases?')) return new Response(JSON.stringify([remote.release]));
    const bytes = remote.assets.get(file); if (!bytes) throw Error('Unexpected request ' + url);
    return new Response(bytes);
  }) as typeof fetch;
  const { RuntimeManager } = await import('./runtime');
  const manager = new RuntimeManager(path.join(root, 'runtime'), () => {}, () => false, fetcher, 'arm64', () => ({ launcher: '0.5.1', backend: '0.2.14' }));
  const refused = await manager.checkManagedRuntime('nexus-cachyos', { allowCachyos: true, allowPrerelease: true });
  expect(refused.available).toBeUndefined();
  expect(refused.error).toContain('Standard runtime only');
  expect((await manager.installManagedRuntime('nexus-cachyos', '0'.repeat(64), { allowCachyos: true, allowPrerelease: true })).committed).toBe(false);
  const { resolveRuntimeFamily } = await import('./runtime-families');
  await expect(resolveRuntimeFamily(path.join(root, 'runtime'), 'nexus-cachyos', 'arm64')).rejects.toThrow();
  expect((await manager.checkManagedRuntime('nexus', armPolicy)).available?.archiveName).toContain('-aarch64.tar.xz');
});

/**
 * Cross-architecture template-link negatives and extraction positives. The
 * extractor must exempt only the requested architecture's own default-prefix Z:
 * mapping, and must reject the other architecture's mapping before any write.
 */
it('rejects the wrong architecture z: mapping in the verifier and in extraction, and accepts its own', async () => {
  const { verifyRuntimeFamilyPayload } = await import('./runtime-families');
  const { materializeRuntimeArchive } = await import('./runtime-family-archive');
  // Verifier: an ARM64 payload carrying the x64 default_pfx z: mapping is unsafe.
  {
    const { root, pointer } = await fixture();
    const file = path.join(root, 'nexus-family.json'), manifest = JSON.parse(await realFs.readFile(file, 'utf8'));
    await realFs.unlink(path.join(root, zMapping));
    const foreign = 'files/share/default_pfx/dosdevices/z:';
    await realFs.mkdir(path.dirname(path.join(root, foreign)), { recursive: true });
    await realFs.symlink('/', path.join(root, foreign));
    manifest.symlinks = { [foreign]: '/' };
    let bytes = JSON.stringify(manifest);
    await realFs.writeFile(file, bytes);
    await expect(verifyRuntimeFamilyPayload(root, { ...pointer, manifestSha256: hash(bytes) }, 'arm64')).rejects.toThrow();
    // The same payload with its own ARM64 mapping is accepted.
    await realFs.unlink(path.join(root, foreign));
    await realFs.mkdir(path.dirname(path.join(root, zMapping)), { recursive: true });
    await realFs.symlink('/', path.join(root, zMapping));
    manifest.symlinks = { [zMapping]: '/' };
    bytes = JSON.stringify(manifest);
    await realFs.writeFile(file, bytes);
    await expect(verifyRuntimeFamilyPayload(root, { ...pointer, manifestSha256: hash(bytes) }, 'arm64')).resolves.toMatchObject({ arch: 'arm64' });
  }
  // Extractor: same archive, opposite requested template prefix.
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  const build = async (mapping: string) => {
    const root = await realFs.mkdtemp(path.join(os.tmpdir(), 'z-template-')); roots.push(root);
    const top = 'nexus-runtime-11.0-experimental-arm64-gaaaaaaaa', directory = path.join(root, 'src', top);
    await realFs.mkdir(path.dirname(path.join(directory, mapping)), { recursive: true });
    await realFs.writeFile(path.join(directory, 'proton'), 'inert');
    await realFs.symlink('/', path.join(directory, mapping));
    const archive = path.join(root, 'archive.tar.xz'), stage = path.join(root, 'stage');
    await promisify(execFile)('tar', ['-cJf', archive, '-C', path.join(root, 'src'), top]);
    await realFs.mkdir(stage, { mode: 0o700 });
    return { archive, stage, top };
  };
  const armArchive = await build(zMapping);
  // ARM64's own mapping is materialized literally, without following it.
  const materialized = await materializeRuntimeArchive(armArchive.archive, armArchive.stage, armArchive.top, undefined, 'default_pfx_arm64');
  expect(await realFs.readlink(path.join(materialized, zMapping))).toBe('/');
  // The same archive requested as x64 must fail before writing anything.
  const x64Stage = await realFs.mkdtemp(path.join(os.tmpdir(), 'z-stage-')); roots.push(x64Stage);
  const x64StageDir = path.join(x64Stage, 'stage'); await realFs.mkdir(x64StageDir, { mode: 0o700 });
  await expect(materializeRuntimeArchive(armArchive.archive, x64StageDir, armArchive.top, undefined, 'default_pfx')).rejects.toThrow();
  expect(await realFs.readdir(x64StageDir)).toEqual([]);
  // And an x64 archive carrying the ARM64 mapping is rejected for x64.
  const x64Mapped = await build(zMapping);
  const armStage = await realFs.mkdtemp(path.join(os.tmpdir(), 'z-stage-arm-')); roots.push(armStage);
  const armStageDir = path.join(armStage, 'stage'); await realFs.mkdir(armStageDir, { mode: 0o700 });
  await expect(materializeRuntimeArchive(x64Mapped.archive, armStageDir, x64Mapped.top, undefined, 'default_pfx')).rejects.toThrow();
  expect(await realFs.readdir(armStageDir)).toEqual([]);
});

/**
 * Two architectures publish independent tags and asset sets. The newer release of
 * one host must never block the other host, and a malformed newest candidate of
 * the *same* architecture must still fail closed instead of downgrading.
 */
/** One inert x64 Standard release of the same family, for mixed-architecture lists. */
async function x64Release(root: string, letter: string) {
  const commit = letter.repeat(40), repository = 'domsvoboda/nexus-runtime', name = 'nexus-runtime-11.0-experimental-g' + commit.slice(0, 8);
  const directory = path.join(root, 'remote-x64-' + letter, name), files: Record<string, string> = {};
  const graph = { proton: commit, wine: 'c'.repeat(40), xgameruntime: 'd'.repeat(40) };
  const x64Z = 'files/share/default_pfx/dosdevices/z:';
  for (const file of ['proton', 'files/bin/wine', 'files/bin/wineserver', 'files/bin/wine.nexus-original',
    ...['PlayFabGameSave.dll', 'gaming-services-version.exe', 'package-registration.exe'].map(n => 'files/share/xodus-nexus/compat/' + n),
    ...['x86_64', 'i386'].flatMap(cpu => ['xgameruntime.dll', 'winhttp.dll', 'libnghttp2.dll'].map(n => `files/lib/wine/${cpu}-windows/${n}`))]) {
    await realFs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    const bytes = Buffer.from('inert x64 ' + letter + ' ' + file);
    await realFs.writeFile(path.join(directory, file), bytes, { mode: 0o755 });
    files[file] = hash(bytes);
  }
  await realFs.mkdir(path.dirname(path.join(directory, x64Z)), { recursive: true });
  await realFs.symlink('/', path.join(directory, x64Z));
  const metadata = JSON.stringify({ schema: 1, sourceLockSha256: '1'.repeat(64), sourceGraph: graph, requiresBackendVersion: '0.2.13', requiresLauncherVersion: '0.4.1' });
  await realFs.writeFile(path.join(directory, 'XODUS_NEXUS_PATCH.json'), metadata);
  files['XODUS_NEXUS_PATCH.json'] = hash(metadata);
  const identity = { schema: 1, family, sourceRepository, sourceCommit: commit, arch: 'x64', prefixSchema: 1, sourceLockSha256: '1'.repeat(64), files, symlinks: { [x64Z]: '/' } };
  const buildId = hash(JSON.stringify(identity));
  await realFs.writeFile(path.join(directory, 'nexus-family.json'), JSON.stringify({ ...identity, buildId }));
  const archiveName = name + '-x86_64.tar.xz', archiveFile = path.join(root, 'remote-x64-' + letter, archiveName);
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  await promisify(execFile)('tar', ['-cJf', archiveFile, '-C', path.dirname(directory), name]);
  const archive = await realFs.readFile(archiveFile), sourceName = name + '-source.tar.xz';
  const assets = new Map<string, Buffer>([[archiveName, archive], [name + '-x86_64.sha512sum', Buffer.from(createHash('sha512').update(archive).digest('hex') + '  ' + archiveName + '\n')],
    [sourceName, Buffer.from('inert x64 source')], [sourceName.replace(/\.tar\.xz$/, '.sha512sum'), Buffer.from(createHash('sha512').update('inert x64 source').digest('hex') + '  ' + sourceName + '\n')]]);
  const selected = [...assets];
  const candidate = { schema: 1, kind: 'runtime', repository, commit, ref: 'refs/heads/main', runId: '790',
    files: selected.map(([file, data]) => ({ name: file, sha256: hash(data), size: data.length })), sourceGraph: graph,
    requiresBackendVersion: '0.2.13', requiresLauncherVersion: '0.4.1',
    validation: { nativeGateCount: 12, treeSha256: '2'.repeat(64), resultsSha256: '3'.repeat(64), realGameTest: false, stableApproved: false } };
  const bytes = Buffer.from(JSON.stringify(candidate));
  assets.set('candidate.json', bytes);
  const tag = 'runtime-11.0-20261103-g' + commit.slice(0, 8);
  const release = { tag_name: tag, target_commitish: commit, draft: false, prerelease: true, published_at: '2026-11-03T12:43:55Z',
    assets: [...assets].map(([file, data]) => ({ name: file, size: data.length, browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${file}` })) };
  return { buildId, archiveName, assets, release };
}

it('selects the newest matching-architecture release in both mixed-date directions', async () => {
  const { RuntimeManager } = await import('./runtime');
  const run = async (hostArch: 'x64' | 'arm64', armDate: string, x64Date: string) => {
    const root = await realFs.mkdtemp(path.join(os.tmpdir(), 'mixed-arch-')); roots.push(root);
    const arm = await arm64Release(root, 'a'), x64 = await x64Release(root, 'b');
    arm.release.published_at = armDate; x64.release.published_at = x64Date;
    // Asset names (candidate.json, source checksums) are shared between the two
    // releases, so each payload is served by the release its tag belongs to.
    const byTag = new Map([[arm.release.tag_name, arm.assets], [x64.release.tag_name, x64.assets]]);
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = String(input), file = url.split('/').pop()!;
      if (url.includes('/releases?')) return new Response(JSON.stringify([arm.release, x64.release]));
      const tag = url.split('/download/')[1]?.split('/')[0] ?? '';
      const bytes = byTag.get(tag)?.get(file); if (!bytes) throw Error('Unexpected request ' + url);
      return new Response(bytes);
    }) as typeof fetch;
    const manager = new RuntimeManager(path.join(root, 'runtime'), () => {}, () => false, fetcher, hostArch, () => ({ launcher: '0.5.1', backend: '0.2.14' }));
    return { root, manager, arm, x64 };
  };
  // Newer ARM64 release must not hide the matching x64 release.
  const onX64 = await run('x64', '2026-11-10T00:00:00Z', '2026-11-01T00:00:00Z');
  const x64Status = await onX64.manager.checkManagedRuntime('nexus', armPolicy);
  expect(x64Status.error).toBeUndefined();
  expect(x64Status.available!.archiveName).toBe(onX64.x64.archiveName);
  expect(x64Status.available!.archiveName).toMatch(/-x86_64\.tar\.xz$/);
  // Newer x64 release must not hide the matching ARM64 release.
  const onArm = await run('arm64', '2026-11-01T00:00:00Z', '2026-11-10T00:00:00Z');
  const armStatus = await onArm.manager.checkManagedRuntime('nexus', armPolicy);
  expect(armStatus.error).toBeUndefined();
  expect(armStatus.available!.archiveName).toBe(onArm.arm.archiveName);
  expect(armStatus.available!.archiveName).toMatch(/-aarch64\.tar\.xz$/);
});

it.each(['x64', 'arm64'] as const)('keeps %s selection order-independent and never downgrades a malformed or conflicting newest host release', async hostArch => {
  const root = await realFs.mkdtemp(path.join(os.tmpdir(), 'arch-selection-')); roots.push(root);
  const arm = await arm64Release(root, 'a'), x64 = await x64Release(root, 'b');
  const own = hostArch === 'arm64' ? arm : x64, other = hostArch === 'arm64' ? x64 : arm;
  const older = hostArch === 'arm64' ? await arm64Release(root, 'c') : await x64Release(root, 'c');
  own.release.published_at = '2026-11-20T00:00:00Z';
  other.release.published_at = '2026-11-30T00:00:00Z';
  older.release.published_at = '2026-11-01T00:00:00Z';
  const remotes = [other, older, own];
  const fetcher = (async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.includes('/releases?')) return new Response(JSON.stringify(remotes.map(remote => remote.release)));
    const tag = url.split('/download/')[1]?.split('/')[0], name = url.split('/').pop()!;
    const bytes = remotes.find(remote => remote.release.tag_name === tag)?.assets.get(name);
    if (!bytes) throw Error('Unexpected request ' + url);
    return new Response(bytes);
  }) as typeof fetch;
  const { RuntimeManager } = await import('./runtime');
  let attempt = 0;
  const check = () => new RuntimeManager(path.join(root, 'runtime-' + attempt++), () => {}, () => false, fetcher, hostArch,
    () => ({ launcher: '0.5.1', backend: '0.2.14' })).checkManagedRuntime('nexus', armPolicy);
  // GitHub may list the corresponding-source archive before the binary.
  for (const remote of remotes) remote.release.assets.sort((a, b) => Number(b.name.endsWith('-source.tar.xz')) - Number(a.name.endsWith('-source.tar.xz')));
  expect((await check()).available?.archiveName).toBe(own.archiveName);
  const binary = own.release.assets.find(asset => asset.name === own.archiveName)!;
  const binaryUrl = binary.browser_download_url;
  binary.browser_download_url = 'https://untrusted.invalid/' + binary.name;
  const invalidUrl = await check();
  expect(invalidUrl.available).toBeUndefined(); expect(invalidUrl.error).toContain('Release asset URL');
  binary.browser_download_url = binaryUrl;
  const savedAssets = structuredClone(own.release.assets);
  own.release.assets = own.release.assets.filter(asset => asset.name !== own.archiveName);
  const missingBinary = await check();
  expect(missingBinary.available).toBeUndefined(); expect(missingBinary.error).toContain('Expected unique candidate, binary and corresponding-source assets');
  own.release.assets = structuredClone(savedAssets);
  // A tag contradicting a valid host binary must fail, not select older's archive.
  const savedTag = own.release.tag_name;
  own.release.tag_name = savedTag.replace(/^runtime-/, 'runtime-' + (hostArch === 'x64' ? 'aarch64' : 'x86_64') + '-');
  own.release.assets = own.release.assets.map(asset => ({ ...asset, browser_download_url: asset.browser_download_url.replace('/' + savedTag + '/', '/' + own.release.tag_name + '/') }));
  const contradictoryTag = await check();
  expect(contradictoryTag.available).toBeUndefined(); expect(contradictoryTag.error).toContain('Conflicting managed runtime release architecture');
  own.release.tag_name = savedTag; own.release.assets = structuredClone(savedAssets);
  // Two architecture binaries stay contradictory whichever one is listed first.
  const oppositeBinary = other.release.assets.find(asset => asset.name === other.archiveName)!;
  const extra = { ...oppositeBinary, browser_download_url: binaryUrl.replace(/\/[^/]+$/, '/' + oppositeBinary.name) };
  for (const assets of [[extra, ...savedAssets], [...savedAssets, extra]]) {
    own.release.assets = structuredClone(assets);
    const conflict = await check();
    expect(conflict.available).toBeUndefined(); expect(conflict.error).toContain('Conflicting managed runtime release architecture');
  }
});
