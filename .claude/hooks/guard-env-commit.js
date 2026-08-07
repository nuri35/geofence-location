#!/usr/bin/env node
// PreToolUse guard (matcher: Bash|PowerShell): blocks git commands that would
// commit or stage a .env file. Exit 2 blocks the tool call; exit 0 allows it.
'use strict';
const { execSync } = require('node:child_process');

let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  let command = '';
  try {
    command = JSON.parse(input).tool_input?.command ?? '';
  } catch {
    process.exit(0);
  }

  const isEnvToken = (token) => token === '.env' || token.endsWith('/.env');

  // Explicitly staging a .env is itself the mistake — block it regardless of commit.
  if (/git\b[\s\S]*\badd\b/.test(command) && command.split(/\s+/).some(isEnvToken)) {
    console.error(
      'Blocked: this command stages a .env file. Secrets never get committed - .env is gitignored on purpose.',
    );
    process.exit(2);
  }

  if (!/git\b[\s\S]*\bcommit\b/.test(command)) process.exit(0);

  let staged = '';
  try {
    staged = execSync('git diff --cached --name-only', { encoding: 'utf8' });
  } catch {
    process.exit(0); // git unavailable or not a repo - never block unrelated work
  }

  const hits = staged.split(/\r?\n/).filter(isEnvToken);
  if (hits.length > 0) {
    console.error(
      `Blocked: ${hits.join(', ')} is staged for commit. Unstage it first: git restore --staged ${hits.join(' ')}`,
    );
    process.exit(2);
  }
  process.exit(0);
});
