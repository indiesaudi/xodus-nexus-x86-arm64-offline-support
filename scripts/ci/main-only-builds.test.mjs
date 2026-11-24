import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const yaml=createRequire(import.meta.url)('js-yaml');
const read=async name=>yaml.load(await fs.readFile(`.github/workflows/${name}.yml`,'utf8'));
const candidateGuard="steps.source_mode.outputs.mode == 'full'";
const sourceGuard="steps.source_mode.outputs.mode == 'source-only'";
test('manual launcher candidates can select x64 without weakening main-only checks', async()=>{
  const workflow=await read('ci');
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.architecture.options,['both','x64']);
  assert.equal(workflow.on.workflow_dispatch.inputs.architecture.default,'both');
  const build=workflow.jobs.checks.steps.find(step=>step.name==='Build launcher candidate (never publish)');
  assert.equal(build.if,candidateGuard);
  assert.match(build.run,/x64\) npx --no-install electron-builder --linux AppImage --x64 --publish never/);
  assert.match(build.run,/both\) npx --no-install electron-builder --linux AppImage --x64 --arm64 --publish never/);
  assert.match(build.run,/Unsupported launcher architecture selection/);
  assert.ok(workflow.jobs.checks.steps.some(step=>step.run==='npm run build'&&step.if===candidateGuard));
  assert.ok(workflow.jobs.checks.steps.some(step=>step.run==='node scripts/ci/artifact-manifest.mjs write launcher release'&&step.if===candidateGuard));
});
test('the launcher repository has no separate runtime workflow to dispatch',async()=>{
  // Runtime builds live in the independent runtime repository; only launcher
  // candidates are promoted from this repository.
  await assert.rejects(fs.readFile('.github/workflows/runtime.yml','utf8'),{code:'ENOENT'});
  const release=await read('release');
  assert.deepEqual(Object.keys(release.on),['workflow_dispatch']);
  assert.equal(release.jobs.promote.if,"github.ref == 'refs/heads/main' && inputs.approve_release");
});
test('develop/PR checks cannot package or upload launcher candidates',async()=>{
  const steps=(await read('ci')).jobs.checks.steps;
  const checks=steps.find(step=>step.name==='Check source without compiling a distribution candidate');
  assert.equal(checks.if,sourceGuard);
  assert.equal(checks.run,'npm run i18n:check && npm run typecheck && npm run test');
  for(const step of steps.filter(step=>step.run?.includes('npm run build')||step.run?.includes('electron-builder')||step.run?.includes('artifact-manifest.mjs')||step.uses?.startsWith('actions/upload-artifact'))){
    assert.equal(step.if,candidateGuard);
  }
});
test('ordinary main/develop/PR events run source checks but never compile or package candidates', async()=>{
  const ci=await read('ci');
  const checks=ci.jobs.checks.steps.find(step=>step.name==='Check source without compiling a distribution candidate');
  const candidates=[...ci.jobs.checks.steps.filter(step=>step.run?.includes('npm run build')||step.run?.includes('electron-builder')||step.run?.includes('artifact-manifest.mjs')||step.uses?.startsWith('actions/upload-artifact'))];
  assert.equal(checks.if,sourceGuard);
  for(const candidate of candidates)assert.equal(candidate.if,candidateGuard);
  const {resolveMode,FULL_MODE,SOURCE_ONLY_MODE}=await import('./source-check-plan.mjs');
  for(const ref of ['refs/heads/main','refs/heads/develop','refs/pull/1/merge']){
    assert.equal(resolveMode('push',ref),SOURCE_ONLY_MODE);
    assert.equal(resolveMode('pull_request',ref),SOURCE_ONLY_MODE);
  }
  assert.equal(resolveMode('workflow_dispatch','refs/heads/main'),FULL_MODE);
  for(const ref of ['refs/heads/develop','refs/heads/feature/example','refs/pull/1/merge'])
    assert.equal(resolveMode('workflow_dispatch',ref),SOURCE_ONLY_MODE);
  assert.deepEqual(Object.keys((await read('release')).on),['workflow_dispatch']);
});
test('launcher CI compiles no native runtime fixtures',async()=>{
  const steps=(await read('ci')).jobs.checks.steps;
  const runs=steps.map(step=>step.run??'').join('\n');
  assert.doesNotMatch(runs,/wine64-tools|mingw|runtime-compat|runtime-tests/);
  assert.ok(steps.some(step=>step.run==='npm run test:runtime-tools'&&step.if===candidateGuard));
  assert.ok(steps.some(step=>step.name==='Run noncompiling runtime tool tests'&&step.if===sourceGuard));
});
