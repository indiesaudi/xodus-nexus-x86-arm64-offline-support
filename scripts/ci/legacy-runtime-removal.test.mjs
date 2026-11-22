import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The launcher repository does not build a runtime. Runtime libraries, patches
// and the Proton base are built in the independent runtime repository, and
// the launcher only downloads, verifies and installs managed runtime families.
// This guard fails if the removed legacy build chain or its patch series
// reappears here, or if the active launcher assets or launcher promotion
// checks are dropped.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const exists = file => fs.existsSync(path.join(root, file));
const walk = (directory, out = []) => {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) walk(relative, out);
    else out.push(relative);
  }
  return out;
};
const sourceFiles = [...walk('src'), ...walk('scripts'), ...walk('.github'), 'package.json', 'README.md', 'CONTRIBUTING.md']
  .filter(file => /\.(?:ts|tsx|mjs|cjs|yml|json|md|sh)$/.test(file) && file !== 'package-lock.json' &&
    // This guard names the removed paths and patterns, so it cannot scan itself.
    // Existing absence assertions for the removed workflow live in
    // main-only-builds.test.mjs.
    file !== 'scripts/ci/legacy-runtime-removal.test.mjs' &&
    file !== 'scripts/ci/main-only-builds.test.mjs');

const REMOVED_FILES = [
  '.github/workflows/runtime.yml',
  'scripts/build-shared-runtime.mjs',
  'scripts/build-runtime-dxvk.mjs',
  'scripts/build-runtime-dxvk.test.mjs',
  'scripts/build-runtime-media.mjs',
  'scripts/assemble-shared-runtime.mjs',
  'scripts/assemble-shared-runtime.test.mjs',
  'scripts/verify-runtime-base.mjs',
  'scripts/verify-runtime-base.test.mjs',
  'scripts/runtime-patches.lock.json',
  'scripts/runtime-base.lock.json',
  'scripts/runtime-media.lock.json',
  'scripts/runtime-dxvk.lock.json',
  'scripts/SHARED_RUNTIME.md',
  'scripts/ci/runtime-needed.mjs',
  'scripts/ci/runtime-needed.test.mjs',
  'scripts/ci/runtime-inputs.mjs',
  'scripts/ci/runtime-promotion-policy.mjs',
  'scripts/ci/runtime-promotion-policy.test.mjs',
  'scripts/ci/check-media-glibc.mjs',
  'scripts/ci/check-media-glibc.test.mjs',
  'scripts/ci/ubuntu-mirror.mjs',
  'scripts/ci/ubuntu-mirror.test.mjs',
  'scripts/build-locale-runtime.sh',
  'scripts/install-locale-runtime.sh',
  'scripts/LOCALE_RUNTIME.md',
  'scripts/build-cloud-save-preview.sh',
  'scripts/install-cloud-save-preview.sh',
  'scripts/use-previous-cloud-runtime.sh',
  'scripts/install-async-lifetime-fix.mjs',
  'scripts/install-mono-path-fix.mjs',
  'scripts/install-xuser-contract-runtime.mjs',
  'scripts/runtime-compat',
  'scripts/runtime-tests',
];

const REMOVED_REFERENCES = [
  /runtime-patches\.lock/,
  /runtime-(?:base|media|dxvk)\.lock/,
  /build-shared-runtime/,
  /assemble-shared-runtime/,
  /build-runtime-media/,
  /build-runtime-dxvk/,
  /verify-runtime-base/,
  /scripts\/ci\/runtime-(?:needed|inputs|promotion-policy)/,
  /scripts\/runtime-compat|scripts\/runtime-tests/,
  /SHARED_RUNTIME|LOCALE_RUNTIME/,
  /build-locale-runtime|install-locale-runtime/,
  /(?:build|install|use-previous)-cloud-(?:save-)?(?:runtime|preview)/,
  /install-(?:async-lifetime|mono-path)-fix|install-xuser-contract-runtime/,
  /\.github\/workflows\/runtime\.yml/,
  /runtime-signin-updates\.md/,
];

test('the legacy launcher runtime build chain stays removed', () => {
  for (const file of REMOVED_FILES) assert.equal(exists(file), false, file);
  assert.deepEqual(fs.readdirSync(path.join(root, '.github/workflows')).filter(name => /runtime/.test(name)), []);
  assert.deepEqual(fs.readdirSync(path.join(root, 'assets')).filter(name => name.endsWith('.patch')), []);
  assert.equal(fs.existsSync(path.join(root, 'assets/backend-source.lock.json')), true);
});

test('no source, workflow, script or documentation refers to the removed chain', () => {
  for (const file of sourceFiles) {
    const source = read(file);
    for (const pattern of REMOVED_REFERENCES) assert.doesNotMatch(source, pattern, `${file}: ${pattern}`);
  }
});

test('the launcher package runs only the remaining noncompiling diagnostics', () => {
  assert.equal(JSON.parse(read('package.json')).scripts['test:runtime-tools'],
    'node --test scripts/eac-trace-summary.test.mjs scripts/wine-exception-metadata.test.mjs');
  for (const file of ['scripts/eac-trace-summary.mjs', 'scripts/eac-trace-summary.test.mjs',
    'scripts/wine-exception-metadata.mjs', 'scripts/wine-exception-metadata.test.mjs']) assert.equal(exists(file), true, file);
});

test('active launcher assets and runtime management source are preserved', () => {
  for (const file of ['assets/icon.png', 'assets/backend-source.lock.json', 'assets/fonts/DejaVuSans.ttf',
    'assets/fonts/LICENSE', 'assets/fonts/source.json', 'assets/locales/en.json', 'assets/overlay/game_monitor.py',
    'assets/overlay/xbox_guide.py']) assert.equal(exists(file), true, file);
  for (const file of ['src/main/managed-runtime.ts', 'src/main/runtime-families.ts', 'src/main/runtime.ts',
    'src/main/legacy-runtime-state.ts', 'src/main/legacy-runtime-update.test.ts', 'scripts/RUNTIME_FAMILIES.md'])
    assert.equal(exists(file), true, file);
  // Runtime families are installed and updated from their own repositories.
  assert.match(read('src/main/managed-runtime.ts'), /XODUS_NEXUS_PATCH\.json/);
});

test('launcher promotion keeps every strict check and never rebuilds', () => {
  const release = read('.github/workflows/release.yml');
  const promotion = read('scripts/ci/promote-candidate.mjs');
  assert.match(release, /options: \[launcher\]/);
  assert.match(release, /group: stable-promotion/);
  assert.match(release, /if: github\.ref == 'refs\/heads\/main' && inputs\.approve_release/);
  assert.match(promotion, /GITHUB_REF !== 'refs\/heads\/main' \|\| process\.env\.APPROVE_RELEASE !== 'true'/);
  assert.match(promotion, /kind !== 'launcher'/);
  assert.match(promotion, /workflow\.path !== expectedWorkflow/);
  assert.match(promotion, /run\.conclusion !== 'success'/);
  assert.match(promotion, /run\.head_branch !== 'main'/);
  assert.match(promotion, /\['push', 'workflow_dispatch'\]\.includes\(run\.event\)/);
  assert.match(promotion, /command\('git', \['merge-base', '--is-ancestor', run\.head_sha, 'HEAD'\]\)/);
  assert.match(promotion, /verifyManifest\(directory, \{ kind, repository: repo, commit: run\.head_sha, runId \}\)/);
  assert.match(promotion, /item\.manifestSha256 === hash/);
  assert.match(promotion, /item\.approvedBy === process\.env\.GITHUB_ACTOR/);
  assert.match(promotion, /assertApprovedReleaseNotes\(notes, approval\)/);
  assert.match(promotion, /Release already exists/);
  assert.doesNotMatch(promotion, /npm run build|electron-builder|rebuild\s*\(/);
});

test('launcher source CI still gates ordinary events to source checks and candidates to manual main dispatch', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /mode == 'source-only'/);
  assert.match(ci, /mode == 'full'/);
  assert.match(ci, /npm run test:ci-tools/);
  assert.doesNotMatch(ci, /ubuntu-mirror\.mjs|apt-get /);
  const plan = read('scripts/ci/source-check-plan.mjs');
  assert.match(plan, /eventName === 'workflow_dispatch' && runnerRef === 'refs\/heads\/main' \? FULL_MODE : SOURCE_ONLY_MODE/);
});
