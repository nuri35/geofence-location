#!/usr/bin/env node
// PostToolUse warning (matcher: Edit|Write): fires when a COMMITTED migration
// file is edited. Executed migrations are immutable - TypeORM matches by
// (timestamp, name) and never re-runs a recorded migration, so the edit will
// silently do nothing in any database that already ran it. Exit 2 surfaces the
// warning to Claude; the edit itself is not undone.
'use strict';
const { execSync } = require('node:child_process');

let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  let filePath = '';
  try {
    filePath = JSON.parse(input).tool_input?.file_path ?? '';
  } catch {
    process.exit(0);
  }

  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/src\/migrations\/([^/]+\.ts)$/);
  if (!match) process.exit(0);

  let tracked = '';
  try {
    tracked = execSync('git ls-files src/migrations', { encoding: 'utf8' });
  } catch {
    process.exit(0);
  }

  if (tracked.split(/\r?\n/).some((f) => f.replace(/\\/g, '/').endsWith(match[1]))) {
    console.error(
      `Warning: ${match[1]} is a committed migration and may already be recorded in the migrations table. ` +
        'TypeORM will NOT re-run it - this edit changes nothing in databases that already ran it. ' +
        'Fix forward with a NEW migration, or confirm it is unexecuted: ' +
        'docker exec geofence-postgres psql -U geofence -d geofence -c "SELECT name FROM migrations;"',
    );
    process.exit(2);
  }
  process.exit(0);
});
