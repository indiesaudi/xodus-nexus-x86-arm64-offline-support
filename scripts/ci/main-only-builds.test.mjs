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
test('full backend/runtime workflows only build main, including manual dispatch',async()=>{
  for(const [name,job] of [['runtime','changes']]){
    const workflow=await read(name);
    if(name==='backend')assert.deepEqual(workflow.on.push.branches,['main']);
    else assert.deepEqual(Object.keys(workflow.on),['workflow_dispatch']);
    assert.equal(workflow.on.pull_request,undefined);
    assert.equal(workflow.jobs[job].if,name==='backend'?candidateGuard:"github.ref == 'refs/heads/main'");
  }
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
test('runtime CI exposes the installed Ubuntu Wine tools before compilation',async()=>{
  const steps=(await read('runtime')).jobs.build.steps;
  const install=steps.findIndex(step=>step.name==='Install build and test prerequisites');
  const build=steps.findIndex(step=>step.name==='Build all shared components from pinned clean checkouts');
  assert.ok(install>=0&&build>install);
  assert.match(steps[install].run,/wine64-tools/);
  assert.match(steps[install].run,/test -x \/usr\/lib\/wine\/widl/);
  assert.match(steps[install].run,/echo \/usr\/lib\/wine >> "\$GITHUB_PATH"/);
});
