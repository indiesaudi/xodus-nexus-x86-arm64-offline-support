import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync, spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const installScript = fileURLToPath(new URL('../install.sh', import.meta.url));
const uninstallScript = fileURLToPath(new URL('../uninstall.sh', import.meta.url));
const temporaryRoot = process.env.TMPDIR || os.tmpdir();
const hostArch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
const realMv = execFileSync('sh', ['-c', 'command -v mv'], {encoding: 'utf8'}).trim();

function commandPath(name) {
  try {
    return execFileSync('sh', ['-c', `command -v ${name}`], {encoding: 'utf8'}).trim();
  } catch {
    return undefined;
  }
}
const scriptCommand = commandPath('script');
const setsidCommand = commandPath('setsid');
const gioCommand = commandPath('gio');
const desktopValidateCommand = commandPath('desktop-file-validate');
let pythonGiAvailable = false;
try {
  execFileSync('python3', ['-c', 'import gi'], {stdio: 'ignore'});
  pythonGiAvailable = true;
} catch {
  pythonGiAvailable = false;
}

function sha512(bytes) {
  return createHash('sha512').update(bytes).digest('hex');
}

function desktopQuote(value) {
  return `"${value.replaceAll('\\', '\\\\\\\\').replaceAll('"', '\\\\"').replaceAll('`', '\\\\`')
    .replaceAll('$', '\\\\$').replaceAll('%', '%%')}"`;
}

function desktopValue(value) {
  return value.replaceAll('\\', '\\\\');
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function writeExecutable(file, body) {
  await fs.writeFile(file, body, {mode: 0o755});
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'nexus-install-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const home = path.join(root, 'home');
  const prefix = path.join(root, options.prefix ?? 'prefix with spaces');
  const data = path.join(root, options.data ?? 'data with spaces');
  const tools = path.join(root, 'tools');
  const server = path.join(root, 'server');
  const temporary = path.join(root, 'tmp');
  const binDir = path.join(prefix, 'bin');
  const app = path.join(prefix, 'opt/xodus-nexus');
  const target = path.join(app, 'Nexus-Launcher.AppImage');
  const legacyTarget = path.join(app, 'Xodus-Nexus.AppImage');
  const icon = path.join(app, 'icon.png');
  const command = path.join(binDir, 'xodus-nexus');
  const desktopDir = path.join(data, 'applications');
  const desktop = path.join(desktopDir, 'xodus-nexus.desktop');
  const routesFile = path.join(root, 'routes');
  const logFile = path.join(root, 'curl.log');
  for (const directory of [home, tools, server, temporary, app, binDir, desktopDir]) {
    await fs.mkdir(directory, {recursive: true});
  }
  await fs.writeFile(routesFile, '');
  await fs.writeFile(logFile, '');
  await writeExecutable(path.join(tools, 'curl'), `#!/bin/sh
set -eu
output=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    --max-time|--retry) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
printf '%s\\n' "$url" >> "$MOCK_LOG"
action=''
while IFS="$(printf '\\t')" read -r route value; do
  if [ "$route" = "$url" ]; then action=$value; fi
done < "$MOCK_ROUTES"
[ -n "$action" ] || exit 22
case "$action" in
  fail) exit 22 ;;
  wait)
    [ -n "$output" ] || exit 22
    : > "$MOCK_WAIT_READY"
    while [ ! -e "$MOCK_WAIT_RELEASE" ]; do sleep 0.05; done
    cp -- "$MOCK_WAIT_FILE" "$output"
    ;;
  partial:*)
    [ -n "$output" ] || exit 22
    head -c 32 "\${action#partial:}" > "$output"
    exit 22
    ;;
  *)
    if [ -n "$output" ]; then cp -- "$action" "$output"; else cat -- "$action"; fi
    ;;
esac
`);
  await writeExecutable(path.join(tools, 'update-desktop-database'), '#!/bin/sh\nexit 0\n');
  await writeExecutable(path.join(tools, 'mv'), `#!/bin/sh
previous=''
last=''
for argument in "$@"; do previous=$last; last=$argument; done
if [ -n "\${FAIL_MV_SOURCE:-}" ] && [ "\${previous##*/}" = "$FAIL_MV_SOURCE" ]; then
  exit 1
fi
if [ -n "\${FAIL_MV_DEST:-}" ] && [ "$last" = "$FAIL_MV_DEST" ] && [ ! -e "\${FAIL_MV_ONCE:-}" ]; then
  : > "$FAIL_MV_ONCE"
  exit 1
fi
exec ${shellQuote(realMv)} "$@"
`);
  const environment = extra => ({
    HOME: home,
    PATH: `${tools}:/usr/bin:/bin`,
    XODUS_NEXUS_PREFIX: prefix,
    XDG_DATA_HOME: data,
    XODUS_NEXUS_SKIP_DEPS: '1',
    MOCK_ROUTES: routesFile,
    MOCK_LOG: logFile,
    TMPDIR: temporary,
    SHELL: '/bin/sh',
    ...extra,
  });
  return {
    root, home, prefix, data, tools, server, temporary, binDir, app, target, legacyTarget, icon, command,
    desktopDir, desktop, routesFile, logFile, environment,
  };
}

async function addRoute(f, url, value) {
  await fs.appendFile(f.routesFile, `${url}\t${value}\n`);
}

async function addIconRoute(f, repository = 'domsvoboda/nexus-launcher') {
  const file = path.join(f.server, 'icon.png');
  await fs.writeFile(file, 'synthetic icon\n');
  await addRoute(f, `https://raw.githubusercontent.com/${repository}/main/assets/icon.png`, file);
}

async function addRelease(f, {
  version = '0.5.0', repository = 'domsvoboda/nexus-launcher', family = 'Nexus-Launcher',
  arch = hostArch, image = Buffer.from(`synthetic launcher ${version}\n`),
  checksum, omitChecksum = false, omitImageAsset = false, apiFailure = false,
  body, apiTag, urlTag, corruptChecksum = false,
} = {}) {
  const name = `${family}-${version}-${arch}.AppImage`;
  const releaseTag = apiTag ?? `v${version}`;
  const assetTag = urlTag ?? releaseTag;
  const imageUrl = `https://github.com/${repository}/releases/download/${assetTag}/${name}`;
  const checksumUrl = `${imageUrl}.sha512sum`;
  const imageFile = path.join(f.server, `${version}-${family}-${arch}.AppImage`);
  const checksumFile = path.join(f.server, `${version}-${family}-${arch}.AppImage.sha512sum`);
  await fs.writeFile(imageFile, image);
  const checksumText = corruptChecksum ? `${'0'.repeat(128)}  ${name}\n` : checksum ?? `${sha512(image)}  ${name}\n`;
  await fs.writeFile(checksumFile, checksumText);
  const assets = [];
  if (!omitImageAsset) {
    assets.push({name, browser_download_url: imageUrl});
  }
  assets.push({name: `${name}.sha512sum`, browser_download_url: checksumUrl});
  const releaseFile = path.join(f.server, `release-${version}-${repository.replaceAll('/', '_')}-${releaseTag.replaceAll('/', '_')}.json`);
  const release = {tag_name: releaseTag, assets};
  if (body !== undefined) release.body = body;
  await fs.writeFile(releaseFile, JSON.stringify(release));
  const apiUrl = `https://api.github.com/repos/${repository}/releases/latest`;
  if (apiFailure) {
    await addRoute(f, apiUrl, 'fail');
  } else {
    await addRoute(f, apiUrl, releaseFile);
    if (!omitImageAsset) await addRoute(f, imageUrl, imageFile);
    if (!omitChecksum) await addRoute(f, checksumUrl, checksumFile);
  }
  await addIconRoute(f, repository);
  return {name, imageUrl, checksumUrl, image};
}

async function addMultiFamilyRelease(f, {
  version = '0.5.1', repository = 'domsvoboda/nexus-launcher', arch = hostArch,
  families = ['Xodus-Nexus', 'Nexus-Launcher'],
} = {}) {
  const releaseTag = `v${version}`;
  const assets = [];
  const images = {};
  for (const family of families) {
    const name = `${family}-${version}-${arch}.AppImage`;
    const image = Buffer.from(`synthetic ${family} launcher ${version}\n`);
    const imageUrl = `https://github.com/${repository}/releases/download/${releaseTag}/${name}`;
    const checksumUrl = `${imageUrl}.sha512sum`;
    const imageFile = path.join(f.server, `${version}-${family}-${arch}.AppImage`);
    const checksumFile = `${imageFile}.sha512sum`;
    await fs.writeFile(imageFile, image);
    await fs.writeFile(checksumFile, `${sha512(image)}  ${name}\n`);
    await addRoute(f, imageUrl, imageFile);
    await addRoute(f, checksumUrl, checksumFile);
    assets.push({name, browser_download_url: imageUrl});
    assets.push({name: `${name}.sha512sum`, browser_download_url: checksumUrl});
    images[family] = {name, imageUrl, checksumUrl, image};
  }
  const releaseFile = path.join(f.server, `release-${version}-multi.json`);
  await fs.writeFile(releaseFile, JSON.stringify({tag_name: releaseTag, assets}));
  await addRoute(f, `https://api.github.com/repos/${repository}/releases/latest`, releaseFile);
  await addIconRoute(f, repository);
  return images;
}

async function setupLegacy(f, {
  desktopName = 'Xodus Nexus', quotedExec = false, targetContent, execPath, iconPath,
} = {}) {
  f.target = f.legacyTarget;
  await fs.writeFile(f.target, targetContent ?? 'old launcher bytes\n', {mode: 0o755});
  await fs.writeFile(f.icon, 'old icon bytes\n');
  await fs.symlink(f.target, f.command);
  const execCommand = execPath ?? f.command;
  const exec = `${quotedExec ? desktopQuote(execCommand) : execCommand} %U`;
  await fs.writeFile(f.desktop, [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${desktopName}`,
    'Comment=Open-source Xbox-inspired game launcher',
    `Exec=${exec}`,
    `Icon=${iconPath ?? f.icon}`,
    'Terminal=false',
    'Categories=Game;',
    'StartupWMClass=xodus-nexus',
    '',
  ].join('\n'));
}

async function setupSentinels(f) {
  const files = {
    settings: path.join(f.home, '.config/xodus-nexus/launcher-state.json'),
    account: path.join(f.home, '.config/xodus-nexus/xbox-profile.json'),
    runtime: path.join(f.data, 'xodus-nexus/runtimes/current.json'),
    save: path.join(f.home, 'Games/Xodus Nexus/Existing/save.dat'),
    appExtra: path.join(f.app, 'installed-game-data.dat'),
    prefixExtra: path.join(f.prefix, 'prefix-marker.txt'),
  };
  for (const [name, file] of Object.entries(files)) {
    await fs.mkdir(path.dirname(file), {recursive: true});
    await fs.writeFile(file, `keep ${name}\n`);
  }
  return files;
}

async function snapshot(files) {
  const result = {};
  for (const [name, file] of Object.entries(files)) {
    const stat = await fs.stat(file);
    result[name] = {bytes: await fs.readFile(file), mtimeMs: stat.mtimeMs, ino: stat.ino, size: stat.size};
  }
  return result;
}

function assertUnchanged(actual, expected) {
  for (const [name, before] of Object.entries(expected)) {
    const after = actual[name];
    assert.ok(after, `missing ${name}`);
    assert.deepEqual(after.bytes, before.bytes, `${name} bytes changed`);
    assert.equal(after.ino, before.ino, `${name} inode changed`);
    assert.equal(after.mtimeMs, before.mtimeMs, `${name} modification time changed`);
  }
}

function runInstaller(f, args = [], extraEnvironment = {}) {
  assert.ok(setsidCommand, 'setsid is required for deterministic noninteractive tests');
  return spawnSync(setsidCommand, ['-w', '/bin/bash', installScript, ...args], {
    env: f.environment(extraEnvironment), encoding: 'utf8', timeout: 60_000, input: '',
  });
}

function runInteractive(f, input) {
  if (!scriptCommand) return undefined;
  const wrapper = path.join(f.root, 'interactive-install.sh');
  return {wrapper, run: async () => {
    await fs.writeFile(wrapper, `#!/bin/sh\nexec /bin/bash ${shellQuote(installScript)} "$@"\n`, {mode: 0o755});
    return spawnSync(scriptCommand, ['-q', '-e', '-c', shellQuote(wrapper), '/dev/null'], {
      env: f.environment(), encoding: 'utf8', timeout: 60_000, input,
    });
  }};
}

async function runUninstall(f, args = [], extraEnvironment = {}) {
  return spawnSync('/bin/bash', [uninstallScript, ...args], {
    env: {
      HOME: f.home,
      PATH: `${f.tools}:/usr/bin:/bin`,
      XODUS_NEXUS_PREFIX: f.prefix,
      XDG_DATA_HOME: f.data,
      TMPDIR: f.temporary,
      ...extraEnvironment,
    },
    encoding: 'utf8', timeout: 60_000,
  });
}

async function logLines(f) {
  return (await fs.readFile(f.logFile, 'utf8')).split('\n').filter(Boolean);
}

async function stageDirs(f) {
  return (await fs.readdir(f.app)).filter(name => name.startsWith('.nexus-install.'));
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

function waitForExit(child) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.on('close', (code, signal) => resolve({code, signal, stdout, stderr}));
  });
}

async function assertNoTemporaryArtifacts(f) {
  for (const [directory, prefix] of [
    [f.app, '.nexus-install.'],
    [f.binDir, '.nexus-link.'],
    [f.desktopDir, '.xodus-nexus.desktop.'],
    [f.app, '.nexus-lock.'],
  ]) {
    const names = await fs.readdir(directory).catch(() => []);
    assert.deepEqual(names.filter(name => name.startsWith(prefix)), [], `temporary files left in ${directory}`);
  }
}

async function assertDesktop(f, {name = 'Nexus Launcher'} = {}) {
  const entry = await fs.readFile(f.desktop, 'utf8');
  const lines = entry.split('\n');
  assert.ok(lines.includes(`Name=${name}`));
  assert.ok(lines.includes(`Exec=/usr/bin/env -- ${desktopQuote(f.command)} %U`));
  assert.ok(lines.includes(`Icon=${desktopValue(f.icon)}`));
  assert.ok(lines.includes('StartupWMClass=xodus-nexus'));
  assert.deepEqual((await fs.readdir(f.desktopDir)).filter(file => file.endsWith('.desktop')), ['xodus-nexus.desktop']);
}

async function assertNoProfileMigration(f) {
  await assert.rejects(fs.stat(path.join(f.home, '.config/Nexus Launcher')), {code: 'ENOENT'});
}

async function assertInstalled(f, expectedImage) {
  assert.deepEqual(await fs.readFile(f.target), expectedImage);
  assert.equal(await fs.readlink(f.command), f.target);
  await assertDesktop(f);
  await assertNoTemporaryArtifacts(f);
  await assert.rejects(fs.stat(`${f.target}.nexus-update.lock`), {code: 'ENOENT'});
}

test('bash syntax of the installer and uninstaller is valid', () => {
  for (const script of [installScript, uninstallScript]) {
    const result = spawnSync('/bin/bash', ['-n', script], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  }
});

test('fresh install uses the latest release, verifies SHA-512 and creates only installer-owned files', async t => {
  const f = await fixture(t);
  const release = await addRelease(f, {version: '0.5.0'});
  const result = runInstaller(f, ['--install']);
  assert.equal(result.status, 0, result.stderr);
  await assertInstalled(f, release.image);
  const lines = await logLines(f);
  assert.ok(lines.includes(release.imageUrl));
  assert.ok(lines.includes(release.checksumUrl));
  assert.equal(lines.filter(line => line.endsWith('.AppImage')).length, 1);
  assert.ok(lines.every(line => !line.includes('0.4.3')));
  assert.deepEqual((await fs.readdir(f.app)).sort(), ['Nexus-Launcher.AppImage', 'icon.png']);
  assert.match(result.stdout, /Nexus Launcher installed \(0\.5\.0\)/);
  await assertNoProfileMigration(f);
});

test('direct upgrade of a real 0.4.2 layout skips intermediate releases and keeps user state', async t => {
  const f = await fixture(t);
  const sentinels = await setupSentinels(f);
  const marker = path.join(f.root, 'OLD_LAUNCHER_EXECUTED');
  await setupLegacy(f, {targetContent: `#!/bin/sh\ntouch ${shellQuote(marker)}\n`});
  const oldDesktop = await fs.readFile(f.desktop, 'utf8');
  const oldIcon = await fs.readFile(f.icon);
  const before = await snapshot(sentinels);
  const release = await addRelease(f, {version: '0.5.0'});
  const result = runInstaller(f, ['--upgrade']);
  assert.equal(result.status, 0, result.stderr);
  await assertInstalled(f, release.image);
  await assertDesktop(f);
  assert.equal(await fs.readFile(f.desktop, 'utf8') === oldDesktop, false);
  assert.deepEqual(await fs.readFile(f.icon), Buffer.from('synthetic icon\n'));
  assert.ok(oldIcon.length > 0);
  await assert.rejects(fs.stat(marker), {code: 'ENOENT'});
  assertUnchanged(await snapshot(sentinels), before);
  await assertNoProfileMigration(f);
  const lines = await logLines(f);
  assert.ok(lines.includes(release.imageUrl));
  assert.equal(lines.filter(line => line.endsWith('.AppImage')).length, 1);
  assert.ok(lines.every(line => !line.includes('0.4.3')));
  assert.match(result.stdout, /upgrade complete \(0\.5\.0\)/);
});

test('upgrading an existing 0.4.3 layout and repeating the upgrade are safe', async t => {
  const f = await fixture(t);
  const sentinels = await setupSentinels(f);
  await setupLegacy(f, {desktopName: 'Xodus Nexus'});
  const before = await snapshot(sentinels);
  const release = await addRelease(f, {version: '0.5.1'});
  const first = runInstaller(f, ['--upgrade']);
  assert.equal(first.status, 0, first.stderr);
  await assertInstalled(f, release.image);
  const firstDesktop = await fs.readFile(f.desktop, 'utf8');
  const second = runInstaller(f, ['--upgrade']);
  assert.equal(second.status, 0, second.stderr);
  await assertInstalled(f, release.image);
  assert.equal(await fs.readFile(f.desktop, 'utf8'), firstDesktop);
  assertUnchanged(await snapshot(sentinels), before);
  await assertNoProfileMigration(f);
  const lines = await logLines(f);
  assert.equal(lines.filter(line => line.endsWith('.AppImage')).length, 2);
});

test('existing installations refuse --install before any network or file change', async t => {
  const f = await fixture(t);
  const sentinels = await setupSentinels(f);
  await setupLegacy(f);
  const before = await snapshot(sentinels);
  const targetBefore = await fs.readFile(f.target);
  const desktopBefore = await fs.readFile(f.desktop);
  const result = runInstaller(f, ['--install']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--upgrade/);
  assert.deepEqual(await fs.readFile(f.target), targetBefore);
  assert.deepEqual(await fs.readFile(f.desktop), desktopBefore);
  assertUnchanged(await snapshot(sentinels), before);
  assert.deepEqual(await logLines(f), []);
  await assertNoTemporaryArtifacts(f);
});

test('--upgrade without an installed launcher fails before mutation or network', async t => {
  const f = await fixture(t);
  const result = runInstaller(f, ['--upgrade']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--install/);
  assert.deepEqual(await logLines(f), []);
  await assert.rejects(fs.stat(f.target), {code: 'ENOENT'});
  await assert.rejects(fs.stat(f.desktop), {code: 'ENOENT'});
  await assert.rejects(fs.stat(f.command), {code: 'ENOENT'});
});

test('checksum, network, partial download and missing asset failures preserve the old installation', async t => {
  const cases = [
    ['corrupt checksum', {checksum: `${'0'.repeat(128)}  Nexus-Launcher-0.5.0-${hostArch}.AppImage\n`}],
    ['missing checksum', {omitChecksum: true}],
    ['missing image asset', {omitImageAsset: true}],
    ['API failure', {apiFailure: true}],
    ['partial image download', {partialImage: true}],
  ];
  for (const [name, options] of cases) {
    await t.test(name, async t => {
      const f = await fixture(t);
      const sentinels = await setupSentinels(f);
      await setupLegacy(f);
      const before = await snapshot(sentinels);
      const targetBefore = await fs.readFile(f.target);
      const desktopBefore = await fs.readFile(f.desktop);
      const iconBefore = await fs.readFile(f.icon);
      const linkBefore = await fs.readlink(f.command);
      const release = await addRelease(f, {version: '0.5.0', ...options});
      if (options.partialImage) {
        const partialFile = path.join(f.server, 'partial.AppImage');
        await fs.writeFile(partialFile, release.image);
        await addRoute(f, release.imageUrl, `partial:${partialFile}`);
      }
      const result = runInstaller(f, ['--upgrade']);
      assert.notEqual(result.status, 0, `${name} unexpectedly succeeded`);
      assert.deepEqual(await fs.readFile(f.target), targetBefore, `${name} changed the launcher`);
      assert.deepEqual(await fs.readFile(f.desktop), desktopBefore, `${name} changed the desktop entry`);
      assert.deepEqual(await fs.readFile(f.icon), iconBefore, `${name} changed the icon`);
      assert.equal(await fs.readlink(f.command), linkBefore, `${name} changed the command link`);
      assertUnchanged(await snapshot(sentinels), before);
      await assertNoTemporaryArtifacts(f);
      await assert.rejects(fs.stat(`${f.target}.nexus-update.lock`), {code: 'ENOENT'});
    });
  }
});

test('latest release selection is dynamic across versions, artifact families and repositories', async t => {
  const f = await fixture(t);
  const primary = await addRelease(f, {version: '0.6.2', repository: 'domsvoboda/xodus-nexus'});
  const fallback = await addRelease(f, {
    version: '1.4.0', repository: 'domsvoboda/nexus-launcher', family: 'Nexus-Launcher',
  });
  const result = runInstaller(f, ['--install']);
  assert.equal(result.status, 0, result.stderr);
  await assertInstalled(f, fallback.image);
  const lines = await logLines(f);
  assert.ok(lines.includes(fallback.imageUrl));
  assert.ok(lines.includes(fallback.checksumUrl));
  assert.ok(!lines.includes(primary.imageUrl));
  assert.match(result.stdout, /\(1\.4\.0\)/);
});

test('upgrades a legacy Xodus-Nexus installation in place without moving saved state', async t => {
  const f = await fixture(t);
  const sentinels = await setupSentinels(f);
  await setupLegacy(f);
  const before = await snapshot(sentinels);
  const release = await addRelease(f, {version: '0.5.1'});
  const result = runInstaller(f, ['--upgrade']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await fs.readFile(f.legacyTarget), release.image);
  await assert.rejects(fs.stat(path.join(f.app, 'Nexus-Launcher.AppImage')), {code: 'ENOENT'});
  assert.equal(await fs.readlink(f.command), f.legacyTarget);
  await assertDesktop(f);
  assertUnchanged(await snapshot(sentinels), before);
});

test('fresh installation uses the canonical Nexus-Launcher path', async t => {
  const f = await fixture(t);
  const release = await addRelease(f, {version: '0.5.1'});
  const result = runInstaller(f, ['--install']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await fs.readFile(path.join(f.app, 'Nexus-Launcher.AppImage')), release.image);
  await assert.rejects(fs.stat(f.legacyTarget), {code: 'ENOENT'});
  assert.equal(await fs.readlink(f.command), path.join(f.app, 'Nexus-Launcher.AppImage'));
  await assertDesktop(f);
});

test('download selects the canonical asset when a release also carries the legacy family', async t => {
  const f = await fixture(t);
  const images = await addMultiFamilyRelease(f, {version: '0.5.1'});
  const result = runInstaller(f, ['--install']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await fs.readFile(f.target), images['Nexus-Launcher'].image);
  const lines = await logLines(f);
  assert.ok(lines.includes(images['Nexus-Launcher'].imageUrl));
  assert.ok(!lines.includes(images['Xodus-Nexus'].imageUrl));
});

test('download falls back to a legacy-only release and still installs', async t => {
  const f = await fixture(t);
  const legacy = await addRelease(f, {version: '0.5.1', family: 'Xodus-Nexus'});
  const result = runInstaller(f, ['--install']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await fs.readFile(f.target), legacy.image);
  assert.ok((await logLines(f)).includes(legacy.imageUrl));
});

test('release body URLs and mismatched tags cannot override the selected asset', async t => {
  await t.test('body URL is ignored', async t => {
    const f = await fixture(t);
    const release = await addRelease(f, {
      version: '0.5.0',
      body: 'Historical note: https://github.com/domsvoboda/xodus-nexus/releases/download/v9.9.9/Xodus-Nexus-9.9.9-x86_64.AppImage',
    });
    const result = runInstaller(f, ['--install']);
    assert.equal(result.status, 0, result.stderr);
    await assertInstalled(f, release.image);
    assert.ok(!(await logLines(f)).some(line => line.includes('9.9.9')));
  });
  await t.test('asset URL tag disagreeing with JSON tag is skipped', async t => {
    const f = await fixture(t);
    await addRelease(f, {version: '0.5.0', apiTag: 'v0.5.0', urlTag: 'v9.9.9'});
    const result = runInstaller(f, ['--install']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No matching AppImage|does not match/);
    await assert.rejects(fs.stat(f.target), {code: 'ENOENT'});
    assert.ok(!(await logLines(f)).some(line => line.endsWith('.AppImage')));
  });
  await t.test('asset filename disagreeing with URL tag is rejected before download', async t => {
    const f = await fixture(t);
    await addRelease(f, {version: '0.5.0', apiTag: 'v9.9.9', urlTag: 'v9.9.9'});
    const result = runInstaller(f, ['--install']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match its version/);
    await assert.rejects(fs.stat(f.target), {code: 'ENOENT'});
    assert.ok(!(await logLines(f)).some(line => line.endsWith('.AppImage')));
  });
});

test('paths with spaces work for downloaded, local and same-destination AppImages', async t => {
  await t.test('downloaded upgrade with spaces in prefix and XDG data home', async t => {
    const f = await fixture(t, {prefix: 'prefix with spaces $literal', data: 'data with spaces'});
    const sentinels = await setupSentinels(f);
    await setupLegacy(f);
    const before = await snapshot(sentinels);
    const release = await addRelease(f, {version: '0.5.0'});
    const result = runInstaller(f, ['--upgrade']);
    assert.equal(result.status, 0, result.stderr);
    await assertInstalled(f, release.image);
    assertUnchanged(await snapshot(sentinels), before);
  });

  await t.test('local AppImage path with spaces and a verified checksum', async t => {
    const f = await fixture(t, {prefix: 'local prefix % with spaces', data: 'local data % with spaces'});
    const image = Buffer.from('local launcher bytes\n');
    const local = path.join(f.root, 'local build with spaces.AppImage');
    await fs.writeFile(local, image, {mode: 0o755});
    await addIconRoute(f);
    const result = runInstaller(f, ['--install'], {
      XODUS_NEXUS_APPIMAGE: local, XODUS_NEXUS_APPIMAGE_SHA512: sha512(image),
    });
    assert.equal(result.status, 0, result.stderr);
    await assertInstalled(f, image);
  });

  await t.test('local AppImage at the destination path upgrades in place', async t => {
    const f = await fixture(t);
    const sentinels = await setupSentinels(f);
    await setupLegacy(f, {targetContent: 'same destination bytes\n'});
    const before = await snapshot(sentinels);
    const image = await fs.readFile(f.target);
    await addIconRoute(f);
    const result = runInstaller(f, ['--upgrade'], {
      XODUS_NEXUS_APPIMAGE: f.target, XODUS_NEXUS_APPIMAGE_SHA512: sha512(image),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await fs.readFile(f.target), image);
    assert.equal(await fs.readlink(f.command), f.target);
    await assertDesktop(f);
    assertUnchanged(await snapshot(sentinels), before);
    await assertNoTemporaryArtifacts(f);
  });
});

test('backslash prefixes verify SHA-512 for local and downloaded images', async t => {
  const specialPrefix = 'prefix with \\ backslash';
  await t.test('local image with checksum', async t => {
    const f = await fixture(t, {prefix: specialPrefix});
    const image = Buffer.from('local backslash image\n');
    const local = path.join(f.root, 'local file with spaces.AppImage');
    await fs.writeFile(local, image, {mode: 0o755});
    await addIconRoute(f);
    const result = runInstaller(f, ['--install'], {
      XODUS_NEXUS_APPIMAGE: local,
      XODUS_NEXUS_APPIMAGE_SHA512: sha512(image),
    });
    assert.equal(result.status, 0, result.stderr);
    await assertInstalled(f, image);
  });
  await t.test('downloaded image with checksum', async t => {
    const f = await fixture(t, {prefix: specialPrefix});
    const release = await addRelease(f, {version: '0.5.0'});
    const result = runInstaller(f, ['--install']);
    assert.equal(result.status, 0, result.stderr);
    await assertInstalled(f, release.image);
  });
  await t.test('corrupt checksum keeps the old launcher and releases the lock', async t => {
    const f = await fixture(t, {prefix: specialPrefix});
    const sentinels = await setupSentinels(f);
    await setupLegacy(f);
    const before = await snapshot(sentinels);
    const targetBefore = await fs.readFile(f.target);
    await addRelease(f, {version: '0.5.0', corruptChecksum: true});
    const result = runInstaller(f, ['--upgrade']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SHA-512/);
    assert.deepEqual(await fs.readFile(f.target), targetBefore);
    assertUnchanged(await snapshot(sentinels), before);
    await assert.rejects(fs.stat(`${f.target}.nexus-update.lock`), {code: 'ENOENT'});
  });
});

test('lexical prefix variants round-trip and legacy entries remain owned', async t => {
  await t.test('trailing slash install and dot-path uninstall', async t => {
    const f = await fixture(t);
    const sentinels = await setupSentinels(f);
    const before = await snapshot(sentinels);
    const release = await addRelease(f, {version: '0.5.0'});
    const install = runInstaller(f, ['--install'], {XODUS_NEXUS_PREFIX: f.prefix + '/'});
    assert.equal(install.status, 0, install.stderr);
    await assertInstalled(f, release.image);
    const uninstall = await runUninstall(f, [], {XODUS_NEXUS_PREFIX: f.root + '/./prefix with spaces/'});
    assert.equal(uninstall.status, 0, uninstall.stderr);
    for (const file of [f.target, f.command, f.desktop, f.icon]) {
      await assert.rejects(fs.stat(file), {code: 'ENOENT'});
    }
    assertUnchanged(await snapshot(sentinels), before);
  });
  await t.test('dot-path install and trailing slash uninstall', async t => {
    const f = await fixture(t);
    const sentinels = await setupSentinels(f);
    const before = await snapshot(sentinels);
    const release = await addRelease(f, {version: '0.5.0'});
    const install = runInstaller(f, ['--install'], {XODUS_NEXUS_PREFIX: f.root + '/./prefix with spaces/'});
    assert.equal(install.status, 0, install.stderr);
    await assertInstalled(f, release.image);
    const uninstall = await runUninstall(f, [], {XODUS_NEXUS_PREFIX: f.prefix + '/'});
    assert.equal(uninstall.status, 0, uninstall.stderr);
    for (const file of [f.target, f.command, f.desktop, f.icon]) {
      await assert.rejects(fs.stat(file), {code: 'ENOENT'});
    }
    assertUnchanged(await snapshot(sentinels), before);
  });
  await t.test('legacy raw Exec and Icon variants are recognized on upgrade', async t => {
    const f = await fixture(t);
    await setupSentinels(f);
    await setupLegacy(f, {
      execPath: f.prefix + '//bin/xodus-nexus',
      iconPath: f.prefix + '/./opt/xodus-nexus/icon.png',
    });
    const release = await addRelease(f, {version: '0.5.0'});
    const result = runInstaller(f, ['--upgrade']);
    assert.equal(result.status, 0, result.stderr);
    await assertInstalled(f, release.image);
  });
});

async function assertGioDesktop(f) {
  const validate = spawnSync(desktopValidateCommand, [f.desktop], {encoding: 'utf8'});
  assert.equal(validate.status, 0, validate.stderr);
  await fs.rm(f.command);
  await fs.writeFile(f.command, '#!/bin/sh\nprintf "%s\\n" "$0" "$@" > "$MARKER"\n', {mode: 0o755});
  const marker = path.join(f.root, 'gio-marker');
  const launched = spawnSync(gioCommand, ['launch', f.desktop], {
    env: {...process.env, XDG_DATA_HOME: f.data, HOME: f.home, MARKER: marker},
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(launched.status, 0, launched.stderr);
  assert.ok(await waitFor(async () => {
    try { await fs.stat(marker); return true; } catch { return false; }
  }), 'GIO did not launch the benign fake command');
  const argv = (await fs.readFile(marker, 'utf8')).trim().split('\n');
  assert.equal(argv[0], f.command);
  if (pythonGiAvailable) {
    const script = `import sys
from gi.repository import Gio
info = Gio.DesktopAppInfo.new_from_filename(sys.argv[1])
if info is None:
    raise SystemExit(2)
icon = info.get_icon()
print(icon.to_string() if icon else "")
`;
    const icon = spawnSync('python3', ['-c', script, f.desktop], {
      env: {...process.env, XDG_DATA_HOME: f.data, HOME: f.home}, encoding: 'utf8',
    });
    assert.equal(icon.status, 0, icon.stderr);
    assert.equal(icon.stdout.trim(), f.icon);
  }
}

test('desktop Exec and Icon parse and launch with GIO for special prefixes', {skip: !gioCommand || !desktopValidateCommand}, async t => {
  const cases = [
    ['spaces', 'prefix with spaces'],
    ['dollar', 'prefix$dollar'],
    ['percent', 'prefix%percent'],
    ['quote', 'prefix"quote'],
    ['backtick', 'prefix`tick`'],
    ['backslash', 'prefix\\backslash'],
    ['combined', 'prefix with spaces \\ "quote" $dollar %percent `tick`'],
  ];
  for (const [name, prefix] of cases) {
    await t.test(name, async t => {
      const f = await fixture(t, {prefix});
      const image = Buffer.from(`synthetic launcher ${name}\n`);
      const local = path.join(f.root, 'local file with spaces.AppImage');
      await fs.writeFile(local, image, {mode: 0o755});
      await addIconRoute(f);
      const result = runInstaller(f, ['--install'], {
        XODUS_NEXUS_APPIMAGE: local,
        XODUS_NEXUS_APPIMAGE_SHA512: sha512(image),
      });
      assert.equal(result.status, 0, result.stderr);
      await assertInstalled(f, image);
      const rerun = runInstaller(f, ['--upgrade'], {
        XODUS_NEXUS_APPIMAGE: local,
        XODUS_NEXUS_APPIMAGE_SHA512: sha512(image),
      });
      assert.equal(rerun.status, 0, rerun.stderr);
      await assertInstalled(f, image);
      await assertGioDesktop(f);
      await fs.rm(f.command);
      await fs.symlink(f.target, f.command);
      const uninstall = await runUninstall(f);
      assert.equal(uninstall.status, 0, uninstall.stderr);
      for (const file of [f.target, f.command, f.desktop, f.icon]) {
        await assert.rejects(fs.stat(file), {code: 'ENOENT'});
      }
    });
  }
});

test('symlink and foreign path collisions are refused without overwriting user files', async t => {
  await t.test('symlinked launcher target', async t => {
    const f = await fixture(t);
    await fs.rm(f.target, {force: true});
    const external = path.join(f.root, 'external.AppImage');
    await fs.writeFile(external, 'external bytes\n');
    await fs.symlink(external, f.target);
    const result = runInstaller(f, ['--upgrade']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlink/);
    assert.equal(await fs.readFile(external, 'utf8'), 'external bytes\n');
    assert.equal(await fs.readlink(f.target), external);
    assert.deepEqual(await logLines(f), []);
  });

  await t.test('foreign command file', async t => {
    const f = await fixture(t);
    await fs.writeFile(f.command, 'my command\n');
    const result = runInstaller(f, ['--install']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /command path/);
    assert.equal(await fs.readFile(f.command, 'utf8'), 'my command\n');
    await assert.rejects(fs.stat(f.target), {code: 'ENOENT'});
    assert.deepEqual(await logLines(f), []);
  });

  await t.test('foreign application-menu entry', async t => {
    const f = await fixture(t);
    await fs.writeFile(f.desktop, '[Desktop Entry]\nName=Another application\nExec=another %U\n');
    const result = runInstaller(f, ['--install']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /application-menu entry/);
    assert.equal(await fs.readFile(f.desktop, 'utf8'), '[Desktop Entry]\nName=Another application\nExec=another %U\n');
    await assert.rejects(fs.stat(f.target), {code: 'ENOENT'});
    assert.deepEqual(await logLines(f), []);
  });

  await t.test('symlinked application directory', async t => {
    const f = await fixture(t);
    const external = path.join(f.root, 'external-app');
    await fs.mkdir(external);
    await fs.rm(f.app, {recursive: true, force: true});
    await fs.symlink(external, f.app);
    const result = runInstaller(f, ['--install']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlinked application directory/);
    assert.deepEqual(await fs.readdir(external), []);
    assert.deepEqual(await logLines(f), []);
  });

  await t.test('symlinked icon file', async t => {
    const f = await fixture(t);
    const external = path.join(f.root, 'external-icon.png');
    await fs.writeFile(external, 'external icon\n');
    await fs.symlink(external, f.icon);
    const result = runInstaller(f, ['--install']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /icon path/);
    assert.equal(await fs.readFile(external, 'utf8'), 'external icon\n');
    assert.equal(await fs.readlink(f.icon), external);
    await assert.rejects(fs.stat(f.target), {code: 'ENOENT'});
    assert.deepEqual(await logLines(f), []);
  });
});

test('in-app updater lock coordination refuses live locks and removes only stale locks', async t => {
  await t.test('live lock', async t => {
    const f = await fixture(t);
    await setupLegacy(f);
    await fs.writeFile(`${f.target}.nexus-update.lock`, String(process.pid));
    const result = runInstaller(f, ['--upgrade']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /update is active/);
    assert.equal(await fs.readFile(f.target, 'utf8'), 'old launcher bytes\n');
    assert.equal(await fs.readFile(`${f.target}.nexus-update.lock`, 'utf8'), String(process.pid));
    assert.deepEqual(await logLines(f), []);
  });

  await t.test('invalid lock', async t => {
    const f = await fixture(t);
    await setupLegacy(f);
    await fs.writeFile(`${f.target}.nexus-update.lock`, 'not-a-pid');
    const result = runInstaller(f, ['--upgrade']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid launcher update lock/);
    assert.equal(await fs.readFile(f.target, 'utf8'), 'old launcher bytes\n');
    assert.deepEqual(await logLines(f), []);
  });

  await t.test('stale lock', async t => {
    const f = await fixture(t);
    await setupLegacy(f);
    await fs.writeFile(`${f.target}.nexus-update.lock`, '99999999');
    const release = await addRelease(f, {version: '0.5.0'});
    const result = runInstaller(f, ['--upgrade']);
    assert.equal(result.status, 0, result.stderr);
    await assertInstalled(f, release.image);
    await assert.rejects(fs.stat(`${f.target}.nexus-update.lock`), {code: 'ENOENT'});
  });
});

test('the installer holds an exclusive updater lock through download', {skip: !setsidCommand}, async t => {
  const f = await fixture(t);
  await setupLegacy(f);
  const release = await addRelease(f, {version: '0.5.0'});
  const ready = path.join(f.root, 'lock-ready');
  const releaseFile = path.join(f.root, 'lock-release');
  const imageFile = path.join(f.server, `0.5.0-Nexus-Launcher-${hostArch}.AppImage`);
  await fs.writeFile(imageFile, release.image);
  await addRoute(f, release.imageUrl, 'wait');
  const child = spawn(setsidCommand, ['-w', '/bin/bash', installScript, '--upgrade'], {
    env: f.environment({MOCK_WAIT_READY: ready, MOCK_WAIT_RELEASE: releaseFile, MOCK_WAIT_FILE: imageFile}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = waitForExit(child);
  t.after(async () => {
    await fs.writeFile(releaseFile, '', {flag: 'a'}).catch(() => {});
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  assert.ok(await waitFor(async () => {
    try { await fs.stat(ready); return true; } catch { return false; }
  }), 'download did not start');
  const lock = `${f.target}.nexus-update.lock`;
  await assert.rejects(fs.open(lock, 'wx', 0o600), {code: 'EEXIST'});
  const pid = Number((await fs.readFile(lock, 'utf8')).trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const lockStat = await fs.stat(lock);
  assert.equal(lockStat.mode & 0o777, 0o600);
  assert.equal(lockStat.uid, process.getuid());
  assert.doesNotThrow(() => process.kill(pid, 0));
  const competing = runInstaller(f, ['--upgrade']);
  assert.notEqual(competing.status, 0);
  assert.match(competing.stderr, /update is active/);
  assert.equal(await fs.readFile(f.target, 'utf8'), 'old launcher bytes\n');
  await fs.writeFile(releaseFile, '');
  const result = await exit;
  assert.equal(result.code, 0, result.stderr);
  await assertInstalled(f, release.image);
});

test('interactive menu reads /dev/tty and supports install, upgrade and retry', {skip: !scriptCommand}, async t => {
  await t.test('fresh install choice 1', async t => {
    const f = await fixture(t);
    const release = await addRelease(f, {version: '0.5.0'});
    const interactive = runInteractive(f, '1\n');
    const result = await interactive.run();
    assert.equal(result.status, 0, result.stderr);
    await assertInstalled(f, release.image);
  });

  await t.test('existing upgrade choice 2', async t => {
    const f = await fixture(t);
    const sentinels = await setupSentinels(f);
    await setupLegacy(f);
    const before = await snapshot(sentinels);
    const release = await addRelease(f, {version: '0.5.0'});
    const interactive = runInteractive(f, '2\n');
    const result = await interactive.run();
    assert.equal(result.status, 0, result.stderr);
    await assertInstalled(f, release.image);
    assertUnchanged(await snapshot(sentinels), before);
  });

  await t.test('existing install choice 1 is refused', async t => {
    const f = await fixture(t);
    await setupLegacy(f);
    const interactive = runInteractive(f, '1\n');
    const result = await interactive.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Upgrade/);
    assert.equal(await fs.readFile(f.target, 'utf8'), 'old launcher bytes\n');
    assert.deepEqual(await logLines(f), []);
  });

  await t.test('missing install choice 2 is refused', async t => {
    const f = await fixture(t);
    const interactive = runInteractive(f, '2\n');
    const result = await interactive.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Install/);
    assert.deepEqual(await logLines(f), []);
  });

  await t.test('invalid selection is retried', async t => {
    const f = await fixture(t);
    await setupLegacy(f);
    const release = await addRelease(f, {version: '0.5.0'});
    const interactive = runInteractive(f, '9\n2\n');
    const result = await interactive.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Invalid selection/);
    await assertInstalled(f, release.image);
  });

  await t.test('EOF fails without changing anything', async t => {
    const f = await fixture(t);
    await setupLegacy(f);
    const interactive = runInteractive(f, '\u0004');
    const result = await interactive.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /No selection/);
    assert.equal(await fs.readFile(f.target, 'utf8'), 'old launcher bytes\n');
    assert.deepEqual(await logLines(f), []);
  });

  await t.test('post-menu checksum failure is visible on the terminal', async t => {
    const f = await fixture(t);
    await setupLegacy(f);
    await addRelease(f, {version: '0.5.0', corruptChecksum: true});
    const interactive = runInteractive(f, '2\n');
    const result = await interactive.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /SHA-512 verification/);
    assert.equal(await fs.readFile(f.target, 'utf8'), 'old launcher bytes\n');
    await assert.rejects(fs.stat(`${f.target}.nexus-update.lock`), {code: 'ENOENT'});
  });
});

test('interactive menu works when the script itself is piped on stdin', {skip: !scriptCommand}, async t => {
  const f = await fixture(t);
  await setupLegacy(f);
  const release = await addRelease(f, {version: '0.5.0'});
  const wrapper = path.join(f.root, 'piped-install.sh');
  await fs.writeFile(wrapper, `#!/bin/sh\ncat ${shellQuote(installScript)} | /bin/bash\n`, {mode: 0o755});
  const result = spawnSync(scriptCommand, ['-q', '-e', '-c', shellQuote(wrapper), '/dev/null'], {
    env: f.environment(), encoding: 'utf8', timeout: 60_000, input: '2\n',
  });
  assert.equal(result.status, 0, result.stderr);
  await assertInstalled(f, release.image);
});

test('missing terminal without a mode fails clearly before network', {skip: !setsidCommand}, async t => {
  const f = await fixture(t);
  const result = runInstaller(f, []);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No interactive terminal/);
  assert.match(result.stderr, /--install/);
  assert.match(result.stderr, /--upgrade/);
  assert.deepEqual(await logLines(f), []);
});

test('help, noninteractive modes and contradictory options are handled before network', async t => {
  await t.test('help', async t => {
    const f = await fixture(t);
    const result = runInstaller(f, ['--skip-deps', '--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--install/);
    assert.match(result.stdout, /--upgrade/);
    assert.deepEqual(await logLines(f), []);
  });

  await t.test('contradictory modes', async t => {
    const f = await fixture(t);
    const result = runInstaller(f, ['--install', '--upgrade']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not both/);
    assert.deepEqual(await logLines(f), []);
  });

  await t.test('unknown option', async t => {
    const f = await fixture(t);
    const result = runInstaller(f, ['--nope']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown option/);
    assert.deepEqual(await logLines(f), []);
  });

  await t.test('invalid environment mode', async t => {
    const f = await fixture(t);
    const result = runInstaller(f, [], {XODUS_NEXUS_MODE: 'sideways'});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid XODUS_NEXUS_MODE/);
    assert.deepEqual(await logLines(f), []);
  });

  await t.test('invalid skip-deps value', async t => {
    const f = await fixture(t);
    const result = runInstaller(f, ['--install'], {XODUS_NEXUS_SKIP_DEPS: 'yes'});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /XODUS_NEXUS_SKIP_DEPS/);
    assert.deepEqual(await logLines(f), []);
  });

  await t.test('environment mode install matches flag mode', async t => {
    const f = await fixture(t);
    const release = await addRelease(f, {version: '0.5.0'});
    const result = runInstaller(f, [], {XODUS_NEXUS_MODE: 'install'});
    assert.equal(result.status, 0, result.stderr);
    await assertInstalled(f, release.image);
  });

  await t.test('environment and argument mode conflict', async t => {
    const f = await fixture(t);
    const result = runInstaller(f, ['--upgrade'], {XODUS_NEXUS_MODE: 'install'});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /conflicts/);
    assert.deepEqual(await logLines(f), []);
  });
});

test('unsupported or control characters in install paths fail before mutation', async t => {
  await t.test('equals in prefix', async t => {
    const f = await fixture(t);
    const bad = f.prefix + '=bad';
    const result = runInstaller(f, ['--install'], {XODUS_NEXUS_PREFIX: bad});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /'='/);
    assert.deepEqual(await logLines(f), []);
    await assert.rejects(fs.stat(bad), {code: 'ENOENT'});
  });
  await t.test('newline in prefix', async t => {
    const f = await fixture(t);
    const bad = f.prefix + '\nbad';
    const result = runInstaller(f, ['--install'], {XODUS_NEXUS_PREFIX: bad});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /control characters/);
    assert.deepEqual(await logLines(f), []);
    await assert.rejects(fs.stat(bad), {code: 'ENOENT'});
  });
  await t.test('newline in XDG_DATA_HOME', async t => {
    const f = await fixture(t);
    const bad = f.data + '\nbad';
    const result = runInstaller(f, ['--install'], {XDG_DATA_HOME: bad});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /control characters/);
    assert.deepEqual(await logLines(f), []);
  });
});

test('an activation failure restores the old launcher, link, desktop and icon', async t => {
  const f = await fixture(t);
  const sentinels = await setupSentinels(f);
  await setupLegacy(f);
  const before = await snapshot(sentinels);
  const targetBefore = await fs.readFile(f.target);
  const desktopBefore = await fs.readFile(f.desktop);
  const iconBefore = await fs.readFile(f.icon);
  await addRelease(f, {version: '0.5.0'});
  const once = path.join(f.root, 'fail-mv-once');
  const result = runInstaller(f, ['--upgrade'], {
    FAIL_MV_DEST: f.desktop, FAIL_MV_ONCE: once,
  });
  assert.notEqual(result.status, 0);
  assert.deepEqual(await fs.readFile(f.target), targetBefore);
  assert.deepEqual(await fs.readFile(f.desktop), desktopBefore);
  assert.deepEqual(await fs.readFile(f.icon), iconBefore);
  assert.equal(await fs.readlink(f.command), f.target);
  assertUnchanged(await snapshot(sentinels), before);
  await fs.stat(once);
  await assertNoTemporaryArtifacts(f);
  await assert.rejects(fs.stat(`${f.target}.nexus-update.lock`), {code: 'ENOENT'});
});

test('a failed restore preserves the recovery directory and the old image bytes', async t => {
  const f = await fixture(t);
  const sentinels = await setupSentinels(f);
  await setupLegacy(f);
  const before = await snapshot(sentinels);
  const oldTarget = await fs.readFile(f.target);
  await addRelease(f, {version: '0.5.0'});
  const once = path.join(f.root, 'fail-mv-once');
  const result = runInstaller(f, ['--upgrade'], {
    FAIL_MV_DEST: f.desktop,
    FAIL_MV_ONCE: once,
    FAIL_MV_SOURCE: 'old-image',
  });
  assert.notEqual(result.status, 0);
  const stages = await stageDirs(f);
  assert.equal(stages.length, 1);
  const stage = path.join(f.app, stages[0]);
  assert.deepEqual(await fs.readFile(path.join(stage, 'old-image')), oldTarget);
  assert.match(result.stderr, /Recovery files were kept at:/);
  assert.ok(result.stderr.includes(stage));
  assertUnchanged(await snapshot(sentinels), before);
  await assert.rejects(fs.stat(`${f.target}.nexus-update.lock`), {code: 'ENOENT'});
  assert.deepEqual((await fs.readdir(f.binDir)).filter(name => name.startsWith('.nexus-link.')), []);
  assert.deepEqual((await fs.readdir(f.desktopDir)).filter(name => name.startsWith('.xodus-nexus.desktop.')), []);
});

test('uninstall removes the quoted installer entry and keeps user data', async t => {
  const f = await fixture(t);
  const sentinels = await setupSentinels(f);
  await setupLegacy(f);
  const before = await snapshot(sentinels);
  const release = await addRelease(f, {version: '0.5.0'});
  const install = runInstaller(f, ['--upgrade']);
  assert.equal(install.status, 0, install.stderr);
  await assertInstalled(f, release.image);
  const uninstall = await runUninstall(f);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  for (const file of [f.target, f.command, f.desktop, f.icon]) {
    await assert.rejects(fs.stat(file), {code: 'ENOENT'});
  }
  assertUnchanged(await snapshot(sentinels), before);
});
