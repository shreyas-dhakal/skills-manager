#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { defaultRoots, discover, deleteSkill } from '../lib/discovery.js';
import { clean, shortPath, skillSummary, groupSkills, selectSkills, confirmDeletion } from '../lib/ui.js';

const help = `Skills Manager — discover and remove local agent skills

Usage: skills-manager [options]

  --list           Print the inventory without opening the selector
  --json           Print the inventory as JSON (implies --list)
  --root <path>    Scan only this directory; repeat for multiple roots
  --help, -h       Show help
  --version, -v    Show version

By default, scans your home folder, current directory, and known skill/plugin
locations. Skips dependencies, build outputs, OS data, and most caches.
Use --root to scan any skipped directory or another disk explicitly.

↑/↓ move · Enter open group · space toggle · Esc back · Ctrl+D review deletion
Deletion always requires typing "delete". Symlinks are unlinked, not followed.
`;

async function main() {
  const args = process.argv.slice(2);
  const roots = [];
  let list = false, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { console.log(help); return; }
    if (arg === '--version' || arg === '-v') { console.log('0.1.0'); return; }
    if (arg === '--list') list = true;
    else if (arg === '--json') { json = true; list = true; }
    else if (arg === '--root') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('--root requires a directory path.');
      roots.push(path.resolve(value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value));
    } else throw new Error(`Unknown option: ${clean(arg)}. Run with --help.`);
  }
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (!json) process.stderr.write('Scanning for installed skills…\n');
  const result = await discover(roots.length ? roots : defaultRoots());
  if (json) {
    console.log(JSON.stringify({ skills: result.skills, warnings: result.warnings }, null, 2));
    return;
  }
  if (result.warnings.length) {
    process.stderr.write(`Skipped ${result.warnings.length} inaccessible location(s). Run --json to inspect warnings.\n`);
  }
  console.log(`Found ${result.skills.length} skill installation(s).\n`);
  if (!result.skills.length) return;
  if (list || !interactive) {
    for (const group of groupSkills(result.skills)) console.log(`${skillSummary(group)} (${group.items.length} installation${group.items.length === 1 ? '' : 's'})`);
    if (!list) console.log('\nRun in an interactive terminal to select and delete skills.');
    return;
  }
  const selected = await selectSkills(result.skills);
  if (!selected?.length) { console.log('No skills selected.'); return; }
  if (!await confirmDeletion(selected, result.skills)) { console.log('Cancelled.'); return; }
  let removed = 0;
  for (const skill of selected) {
    try {
      await deleteSkill(skill);
      console.log(`Removed ${clean(shortPath(skill.path))}`);
      removed++;
    } catch (error) {
      console.error(`Could not remove ${clean(skill.path)}: ${clean(error.message)}`);
      process.exitCode = 1;
    }
  }
  console.log(`\nRemoved ${removed} of ${selected.length} selected installation(s).`);
}

main().catch(error => { console.error(`Error: ${clean(error.message)}`); process.exitCode = 1; });
