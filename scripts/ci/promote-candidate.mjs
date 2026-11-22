// Manual promotion only: download and verify tested bytes, never rebuild.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { verifyManifest } from './artifact-manifest.mjs';
import { releaseNotesRef, assertApprovedReleaseNotes } from './release-notes-policy.mjs';
const kind = process.env.CANDIDATE_KIND, runId = process.env.CANDIDATE_RUN;
const repo = process.env.GITHUB_REPOSITORY;
if (process.env.GITHUB_REF !== 'refs/heads/main' || process.env.APPROVE_RELEASE !== 'true') throw Error('Explicit main-branch release authorization required');
if (kind !== 'launcher' || !/^\d+$/.test(runId ?? '') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '')) throw Error('Invalid promotion selection');
const command = (tool, args) => execFileSync(tool, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const run = JSON.parse(command('gh', ['api', `repos/${repo}/actions/runs/${runId}`]));
const workflow = JSON.parse(command('gh', ['api', `repos/${repo}/actions/workflows/${run.workflow_id}`]));
const expectedWorkflow = '.github/workflows/ci.yml';
if (run.conclusion !== 'success' || run.head_branch !== 'main' || !['push', 'workflow_dispatch'].includes(run.event) ||
    workflow.path !== expectedWorkflow || !/^[a-f0-9]{40}$/.test(run.head_sha ?? '')) throw Error('Not a successful main candidate build');
command('git', ['merge-base', '--is-ancestor', run.head_sha, 'HEAD']);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-promotion-'));
try {
  command('gh', ['run', 'download', runId, '--repo', repo, '--name', 'launcher-candidate', '--dir', directory]);
  const manifest = await verifyManifest(directory, { kind, repository: repo, commit: run.head_sha, runId });
  const hash = createHash('sha256').update(await fs.readFile(path.join(directory, 'candidate.json'))).digest('hex');
  const approvals = JSON.parse(await fs.readFile('.github/release-validation.json', 'utf8'));
  const approval = approvals.schema === 1 && approvals.approvals?.find(item => item.kind === kind && item.runId === runId &&
    item.commit === run.head_sha && item.manifestSha256 === hash && item.approved === true && item.approvedBy === process.env.GITHUB_ACTOR &&
    typeof item.evidence === 'string' && item.evidence.trim().length > 0);
  if (!approval) throw Error('No recorded human validation for this exact artifact');
  const pkg = JSON.parse(command('git', ['show', `${run.head_sha}:package.json`]));
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw Error('Not a stable launcher version');
  const tag = `v${pkg.version}`;
  const notesPath = `.github/release-notes/launcher-${tag.slice(1)}.md`;
  const notes = command('git', ['show', `${releaseNotesRef(kind, run.head_sha, approval)}:${notesPath}`]);
  assertApprovedReleaseNotes(notes, approval);
  // One new release per tag. Never edit an existing release or replace assets.
  try { command('gh', ['release', 'view', tag, '--repo', repo]); throw Error('Release already exists'); }
  catch (error) { if (!error.status) throw error; }
  // Public release display title only. Tags, asset filenames and approvals stay unchanged.
  const releaseTitle = `Nexus Launcher ${tag}`;
  command('gh', ['release', 'create', tag, '--repo', repo, '--target', run.head_sha,
    ...manifest.files.map(file => path.join(directory, file.name)), path.join(directory, 'candidate.json'),
    '--title', releaseTitle, '--notes', notes]);
  console.log(`Promoted tested ${kind} candidate ${runId} as ${tag}; no rebuild performed.`);
} finally { await fs.rm(directory, { recursive: true, force: true }); }
