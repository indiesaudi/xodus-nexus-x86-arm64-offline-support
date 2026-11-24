#!/usr/bin/env node
// Points the launcher's in-app updater at this fork, so arm64 installs find
// the arm64 AppImages this fork publishes. Upstream release URLs stay
// accepted. This is the only change made to the upstream source.
//
// Usage: node point-updater-at-fork.mjs <upstream source dir> <owner/repo>
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [source, fork] = process.argv.slice(2);
if (!source || !/^[\w.-]+\/[\w.-]+$/.test(fork ?? '')) {
  console.error('usage: point-updater-at-fork.mjs <source dir> <owner/repo>');
  process.exit(2);
}
const file = path.join(source, 'src/main/launcher-update.ts');
let text = readFileSync(file, 'utf8');

function replaceOnce(pattern, replacement, what) {
  const matches = text.match(new RegExp(pattern.source, 'gm')) ?? [];
  if (matches.length !== 1) {
    console.error(`Expected one ${what} in ${file}, found ${matches.length}. Upstream changed the updater; update this script.`);
    process.exit(1);
  }
  text = text.replace(pattern, replacement);
}

// The repository whose releases the updater lists.
replaceOnce(/^const REPO = '[^']+';$/m, `const REPO = '${fork}';`, 'REPO constant');
// The repositories a release's download URLs may come from: add the fork.
replaceOnce(/^(const REPOSITORIES\s*=\s*\[)([^\]]+)(\]\s*as const;)$/m, `$1$2,'${fork}'$3`, 'REPOSITORIES list');

writeFileSync(file, text);
console.log(`Launcher updater now checks ${fork} (${path.relative(source, file)}).`);
