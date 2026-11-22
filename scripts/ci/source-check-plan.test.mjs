import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  FULL_MODE, MODES, NATIVE_COMPILATION_FIXTURES, SOURCE_ONLY_MODE,
  buildPlan, listCompilingFixtures, modeOutputLine, omissionReport,
  parseRuntimeToolFiles, readEventPayload, resolveMode,
  writeGithubOutput,
} from './source-check-plan.mjs';

const yaml = createRequire(import.meta.url)('js-yaml');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const helper = path.join(root, 'scripts/ci/source-check-plan.mjs');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const packageJson = () => JSON.parse(read('package.json'));
const runtimeToolsScript = () => packageJson().scripts['test:runtime-tools'];

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of ['NEXUS_SOURCE_CHECK_MODE', 'NEXUS_EVENT_NAME', 'NEXUS_EVENT_PATH',
    'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH', 'GITHUB_REF', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY']) delete env[key];
  return { ...env, ...extra };
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8', env: cleanEnv(env) });
}

function tempFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-source-plan-'));
  return { directory, join: name => path.join(directory, name) };
}

test('full mode keeps the exact existing runtime tool command and files', () => {
  const script = runtimeToolsScript();
  const files = parseRuntimeToolFiles(script);
  const plan = buildPlan({ mode: FULL_MODE, runtimeToolsScript: script, exists: () => true });
  assert.equal(plan.mode, FULL_MODE);
  assert.equal(plan.installNativeToolchain, true);
  assert.deepEqual(plan.runtimeTools.command, ['npm', 'run', 'test:runtime-tools']);
  assert.deepEqual(plan.runtimeTools.files, files);
  assert.deepEqual(plan.runtimeTools.omitted, []);
  assert.deepEqual(omissionReport(plan), []);
  assert.deepEqual(files, ['scripts/eac-trace-summary.test.mjs', 'scripts/wine-exception-metadata.test.mjs']);
  assert.deepEqual(NATIVE_COMPILATION_FIXTURES, []);
});

test('source-only mode keeps every runtime tool fixture in order', () => {
  const script = runtimeToolsScript();
  const files = parseRuntimeToolFiles(script);
  const plan = buildPlan({ mode: SOURCE_ONLY_MODE, runtimeToolsScript: script, exists: () => true });
  assert.equal(plan.mode, SOURCE_ONLY_MODE);
  assert.equal(plan.installNativeToolchain, false);
  assert.deepEqual(plan.runtimeTools.omitted, []);
  assert.deepEqual(plan.runtimeTools.files, files);
  assert.deepEqual(plan.runtimeTools.command, ['node', '--test', ...plan.runtimeTools.files]);
  assert.ok(plan.runtimeTools.files.includes('scripts/eac-trace-summary.test.mjs'));
  assert.ok(plan.runtimeTools.files.includes('scripts/wine-exception-metadata.test.mjs'));
});

test('source-only mode reports no native omission without claiming native coverage', () => {
  const plan = buildPlan({ mode: SOURCE_ONLY_MODE, runtimeToolsScript: runtimeToolsScript(), exists: () => true });
  const report = omissionReport(plan).join('\n');
  assert.match(report, /No native compilation fixtures are declared/);
  assert.doesNotMatch(report, /passed/i);
  assert.doesNotMatch(report, /not a substitute for the full native checks/);
});

test('the declared omission is justified by actual compiler invocations', () => {
  const files = parseRuntimeToolFiles(runtimeToolsScript());
  assert.deepEqual(listCompilingFixtures(files, read), NATIVE_COMPILATION_FIXTURES.map(item => item.file));
  const plan = buildPlan({ mode: SOURCE_ONLY_MODE, runtimeToolsScript: runtimeToolsScript(), exists: () => true });
  assert.deepEqual(listCompilingFixtures(plan.runtimeTools.files, read), []);
});

test('source-only fails closed on a future compiling fixture not in the manifest', () => {
  const sources = {
    'spawns-compiler.test.mjs': "import { execFileSync } from 'node:child_process';\nexecFileSync('cargo', ['test']);",
    'requires-compiler.test.mjs': "const { spawnSync } = require('node:child_process');\nconst command = 'clang';\n",
    'spawns-node.test.mjs': "import { execFileSync } from 'node:child_process';\nexecFileSync(process.execPath, ['-e', '']);",
    'mentions-compiler.test.mjs': "const command = 'winegcc';\n",
  };
  assert.deepEqual(listCompilingFixtures(Object.keys(sources), file => sources[file]),
    ['spawns-compiler.test.mjs', 'requires-compiler.test.mjs']);
});

test('only an explicit manual dispatch on main selects the full native plan', () => {
  assert.equal(resolveMode('workflow_dispatch', 'refs/heads/main'), FULL_MODE);
  for (const ref of ['refs/heads/develop', 'refs/heads/feature/example', 'refs/heads/fix/example', 'refs/tags/v1', ''])
    assert.equal(resolveMode('workflow_dispatch', ref), SOURCE_ONLY_MODE);
  assert.equal(resolveMode('workflow_dispatch', undefined), SOURCE_ONLY_MODE);
});

test('ordinary push and pull request events never compile or package', () => {
  for (const ref of ['refs/heads/main', 'refs/heads/develop', 'refs/heads/feature/example'])
    assert.equal(resolveMode('push', ref), SOURCE_ONLY_MODE);
  assert.equal(resolveMode('pull_request', 'refs/heads/main'), SOURCE_ONLY_MODE);
  assert.equal(resolveMode('', ''), SOURCE_ONLY_MODE);
  assert.equal(resolveMode('schedule', 'refs/heads/main'), SOURCE_ONLY_MODE);
});

test('commit messages and pull request titles cannot promote a build', () => {
  // resolveMode only accepts the event name and the trusted runner ref, so
  // commit/PR text has no path to select a build mode. The CLI test below
  // proves hostile payload text is ignored.
  assert.equal(resolveMode('push', 'refs/heads/main'), SOURCE_ONLY_MODE);
  assert.equal(resolveMode('pull_request', 'refs/heads/main'), SOURCE_ONLY_MODE);
  assert.equal(resolveMode('workflow_dispatch', 'refs/heads/main'), FULL_MODE);
});

test('hostile event text cannot change the selected mode or reach the output file', () => {
  // The resolver has no text input; the CLI test below proves payload text is
  // ignored and only the allowlisted literal mode reaches the output file.
  assert.equal(resolveMode('pull_request', 'refs/heads/main'), SOURCE_ONLY_MODE);
  assert.equal(modeOutputLine(SOURCE_ONLY_MODE), 'mode=source-only\n');
  assert.equal(modeOutputLine(FULL_MODE), 'mode=full\n');
  for (const mode of ['source_only', 'full\nINJECTED=1', 'source-only\r\nmode=full'])
    assert.throws(() => modeOutputLine(mode), /Refusing to publish unknown source check mode/);
});

test('the output writer appends only a validated literal mode', () => {
  const fixture = tempFixture();
  try {
    const output = fixture.join('output');
    fs.writeFileSync(output, '');
    writeGithubOutput(output, SOURCE_ONLY_MODE);
    writeGithubOutput(output, FULL_MODE);
    assert.equal(fs.readFileSync(output, 'utf8'), 'mode=source-only\nmode=full\n');
    assert.throws(() => writeGithubOutput(output, 'source-only\nINJECTED=1'), /Refusing/);
    assert.equal(fs.readFileSync(output, 'utf8'), 'mode=source-only\nmode=full\n');
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('source-only fails closed when a declared fixture is stale or no fixture is selected', () => {
  const script = runtimeToolsScript();
  // Declared exclusions stay checked against the selected files and the
  // checkout, so a future compiling fixture must be reviewed, not dropped.
  const selected = parseRuntimeToolFiles(script);
  const declared = [{ file: selected[0], reason: 'temporary' }];
  assert.throws(() => buildPlan({ mode: SOURCE_ONLY_MODE, runtimeToolsScript: script, exists: () => false, fixtures: declared }),
    /missing from the checkout/);
  assert.throws(() => buildPlan({ mode: SOURCE_ONLY_MODE, runtimeToolsScript: 'node --test scripts/other.test.mjs', exists: () => true, fixtures: declared }),
    /not selected by test:runtime-tools/);
  assert.throws(() => buildPlan({ mode: SOURCE_ONLY_MODE, runtimeToolsScript: 'node --test', exists: () => true }),
    /selects no test files/);
});

test('unknown modes fail instead of falling back to a silent plan', () => {
  for (const mode of ['', 'source_only', 'FULL', 'full\nINJECTED=1', undefined, null])
    assert.throws(() => buildPlan({ mode, runtimeToolsScript: runtimeToolsScript(), exists: () => true }),
      /Unknown source check mode/);
});

test('runtime tool script parsing rejects shell syntax and escaping paths', () => {
  assert.deepEqual(parseRuntimeToolFiles('node --test a.test.mjs scripts/b.test.mjs'),
    ['a.test.mjs', 'scripts/b.test.mjs']);
  for (const script of ['', 'node --test', 'npm --test a.test.mjs', 'node --test $(touch x).test.mjs',
    'node --test ../a.test.mjs', 'node --test /a.test.mjs', 'node --test a.test.mjs && touch x'])
    assert.throws(() => parseRuntimeToolFiles(script));
});

test('malformed event JSON fails closed instead of selecting a silent mode', () => {
  const fixture = tempFixture();
  try {
    const invalid = fixture.join('invalid.json');
    fs.writeFileSync(invalid, '[');
    assert.throws(() => readEventPayload(invalid), /not valid JSON/);
    const array = fixture.join('array.json');
    fs.writeFileSync(array, '[]');
    assert.throws(() => readEventPayload(array), /must be a JSON object/);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('resolve-mode trusts the runner ref, not the event payload ref', () => {
  const fixture = tempFixture();
  try {
    const event = fixture.join('event.json');
    const output = fixture.join('output');
    fs.writeFileSync(output, '');
    const resolve = (name, payload, runnerRef) => {
      fs.writeFileSync(event, JSON.stringify(payload));
      fs.writeFileSync(output, '');
      const env = { NEXUS_EVENT_NAME: name, NEXUS_EVENT_PATH: event, GITHUB_OUTPUT: output };
      if (runnerRef !== undefined) env.GITHUB_REF = runnerRef;
      const result = runCli(['resolve-mode'], env);
      assert.equal(result.status, 0, result.stderr);
      return { result, written: fs.readFileSync(output, 'utf8') };
    };
    // A bare payload ref is not trusted; the runner GITHUB_REF is.
    let resolved = resolve('workflow_dispatch', { ref: 'main' }, 'refs/heads/main');
    assert.equal(resolved.written, 'mode=full\n');
    assert.match(resolved.result.stdout, /manual dispatch on refs\/heads\/main/);
    // A payload claiming main cannot override a non-main runner ref.
    resolved = resolve('workflow_dispatch', { ref: 'refs/heads/main' }, 'refs/heads/feature/example');
    assert.equal(resolved.written, 'mode=source-only\n');
    // Missing runner ref fails closed even with a main-looking payload.
    resolved = resolve('workflow_dispatch', { ref: 'refs/heads/main' }, undefined);
    assert.equal(resolved.written, 'mode=source-only\n');
    // Ordinary push/PR are always source-only, regardless of strings.
    resolved = resolve('push', { ref: 'refs/heads/main', head_commit: { message: '[source-only]' } }, 'refs/heads/main');
    assert.equal(resolved.written, 'mode=source-only\n');
    resolved = resolve('pull_request', { pull_request: { title: "[source-only]\n$(touch pwned)" } }, 'refs/heads/main');
    assert.equal(resolved.written, 'mode=source-only\n');
    // Malformed payload fails closed before writing a mode.
    fs.writeFileSync(event, '{not json');
    const malformed = runCli(['resolve-mode'], {
      NEXUS_EVENT_NAME: 'workflow_dispatch', NEXUS_EVENT_PATH: event, GITHUB_REF: 'refs/heads/main',
    });
    assert.notEqual(malformed.status, 0);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('report command prints the current source-only selection', () => {
  const fixture = tempFixture();
  try {
    const summary = fixture.join('summary.md');
    fs.writeFileSync(summary, '');
    const result = runCli(['report'], {
      NEXUS_SOURCE_CHECK_MODE: SOURCE_ONLY_MODE, GITHUB_STEP_SUMMARY: summary,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No native compilation fixtures are declared/);
    assert.match(fs.readFileSync(summary, 'utf8'), /No native compilation fixtures are declared/);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('mode consumers reject unknown modes before running anything', () => {
  for (const command of ['validate-mode', 'report', 'run-runtime-tools']) {
    const result = runCli([command], { NEXUS_SOURCE_CHECK_MODE: 'native' });
    assert.notEqual(result.status, 0, command);
    assert.match(result.stderr, /Unknown source check mode/, command);
  }
  for (const mode of [FULL_MODE, SOURCE_ONLY_MODE]) {
    const result = runCli(['validate-mode'], { NEXUS_SOURCE_CHECK_MODE: mode });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Source check mode: ${mode}`));
  }
});

test('workflow wiring resolves the mode once and keeps full and candidate behavior', () => {
  const workflow = yaml.load(read('.github/workflows/ci.yml'));
  const steps = workflow.jobs.checks.steps;
  const mode = steps.find(step => step.name === 'Resolve source check mode');
  assert.equal(mode.id, 'source_mode');
  assert.equal(mode.run, 'node scripts/ci/source-check-plan.mjs resolve-mode');
  assert.deepEqual(mode.env, {
    NEXUS_EVENT_NAME: '${{ github.event_name }}',
    NEXUS_EVENT_PATH: '${{ github.event_path }}',
  });
  const validate = steps.find(step => step.name === 'Validate source check mode');
  assert.equal(validate.run, 'node scripts/ci/source-check-plan.mjs validate-mode');
  assert.deepEqual(validate.env, { NEXUS_SOURCE_CHECK_MODE: '${{ steps.source_mode.outputs.mode }}' });
  assert.equal(validate.if, undefined);
  // No runtime tool fixture compiles native code, so CI installs no extra
  // toolchain and the source-only and full plans run the same checks.
  assert.ok(!steps.some(step => step.run?.includes('ubuntu-mirror.mjs')));
  assert.ok(!steps.some(step => step.run?.includes('gcc-mingw-w64')));
  assert.ok(steps.indexOf(validate) > steps.indexOf(mode));
  const checks = steps.find(step => step.name === 'Check source without compiling a distribution candidate');
  assert.equal(checks.if, "steps.source_mode.outputs.mode == 'source-only'");
  assert.equal(checks.run, 'npm run i18n:check && npm run typecheck && npm run test');
  const report = steps.find(step => step.run === 'node scripts/ci/source-check-plan.mjs report');
  assert.ok(steps.indexOf(report) > steps.indexOf(validate));
  assert.ok(steps.indexOf(report) < steps.indexOf(checks));
  assert.ok(steps.some(step => step.run === 'npm run test:ci-tools'));
  const fullTools = steps.find(step => step.run === 'npm run test:runtime-tools');
  assert.equal(fullTools.if, "steps.source_mode.outputs.mode == 'full'");
  for (const command of ['report', 'run-runtime-tools']) {
    const step = steps.find(item => item.run === `node scripts/ci/source-check-plan.mjs ${command}`);
    assert.equal(step.if, "steps.source_mode.outputs.mode == 'source-only'");
    assert.deepEqual(step.env, { NEXUS_SOURCE_CHECK_MODE: '${{ steps.source_mode.outputs.mode }}' });
  }
  const candidateGuard = "steps.source_mode.outputs.mode == 'full'";
  for (const step of steps.filter(item => item.run?.includes('npm run build') ||
    item.run?.includes('electron-builder') || item.run?.includes('artifact-manifest.mjs') ||
    item.uses?.startsWith('actions/upload-artifact')))
    assert.equal(step.if, candidateGuard);
  for (const step of steps) {
    if (typeof step.run === 'string')
      assert.doesNotMatch(step.run, /github\.event\.|head_commit|pull_request\.title|\$\{\{\s*github\.event/);
    assert.equal(step['continue-on-error'], undefined);
  }
  assert.deepEqual(workflow.on.push.branches, ['main', 'develop']);
  assert.ok(workflow.on.pull_request);
  assert.doesNotMatch(read('.github/workflows/ci.yml'), /\[skip ci\]/i);
});

test('the unit test command and its exclusions remain unchanged', () => {
  const scripts = packageJson().scripts;
  assert.equal(scripts.test, 'vitest run');
  assert.match(scripts.typecheck, /tsc --noEmit/);
  assert.match(scripts.typecheck, /tsconfig\.electron\.json --noEmit/);
  assert.match(read('vitest.config.ts'), /scripts\/\*\*\/\*\.test\.mjs/);
});
