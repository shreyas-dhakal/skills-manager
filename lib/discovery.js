import { readdir, readFile, lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Ignore bulky generated/system trees during a home scan. Explicit roots bypass
// the ignore rule for the root itself, including plugin caches.
const ignored = new Set(['node_modules', '.git', '.hg', '.svn', '.npm', '.cache',
  '.Trash', 'Library', 'AppData', '.venv', 'venv', '__pycache__',
  'target', 'dist', 'build', '.next', '.nuxt', '.gradle', '.m2', '.rustup',
  '.cargo', '.local', '.nvm', '.pnpm-store', '.yarn', 'Caches', 'cache']);

export function defaultRoots(home = os.homedir(), cwd = process.cwd(), env = process.env) {
  return [...new Set([home, cwd,
    path.join(env.CODEX_HOME || path.join(home, '.codex'), 'skills'),
    path.join(env.CODEX_HOME || path.join(home, '.codex'), 'plugins', 'cache'),
    path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills'),
    path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'plugins', 'cache'),
    path.join(home, '.config', 'opencode', 'skills'),
    path.join(home, '.local', 'share', 'opencode', 'skills'),
  ].map(p => path.resolve(p)))];
}

export function metadata(source, fallback) {
  const front = source.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
  const field = key => {
    const match = front.match(new RegExp(`^${key}:\\s*([^\\r\\n]*)`, 'm'));
    if (!match) return '';
    let value = match[1].trim();
    if (/^[>|][-+]?\s*$/.test(value)) {
      value = front.slice(match.index + match[0].length).match(/^(?:\r?\n[ \t]+[^\r\n]*)+/)?.[0].trim().replace(/\s+/g, ' ') || '';
    }
    return value.replace(/^(['"])([\s\S]*)\1$/, '$2');
  };
  return { name: field('name') || fallback, description: field('description') };
}

export async function discover(roots, { onProgress = () => {} } = {}) {
  const skills = new Map();
  const warnings = [];
  let directories = 0;
  async function walk(directory, ancestors = new Set(), linkedAncestor = false) {
    let physical, stat;
    try {
      stat = await lstat(directory);
      physical = await realpath(directory);
    } catch (error) {
      if (error.code !== 'ENOENT') warnings.push(`${directory}: ${error.code}`);
      return;
    }
    if (ancestors.has(physical)) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOTDIR') warnings.push(`${directory}: ${error.code}`); return; }
    onProgress(++directories);
    if (entries.some(e => e.name === 'SKILL.md' && e.isFile())) {
      try {
        const source = await readFile(path.join(directory, 'SKILL.md'), 'utf8');
        const parent = await realpath(path.dirname(directory));
        skills.set(directory, { ...metadata(source, path.basename(directory)), path: directory,
          realPath: physical, parent, symlink: stat.isSymbolicLink(),
          // A symlink pointing directly at a skill can be unlinked safely. A
          // skill reached THROUGH a linked collection cannot be unlinked alone.
          blocked: linkedAncestor || parent !== path.dirname(directory),
          identity: `${stat.dev}:${stat.ino}`, agent: agentFor(directory) });
      } catch (error) { warnings.push(`${directory}: ${error.code}`); }
      // Resources inside a skill belong to that skill, not separate installs.
      return;
    }
    const next = new Set(ancestors).add(physical);
    // Bounded sequential traversal avoids thousands of concurrent open files.
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const child = path.join(directory, entry.name);
      if (ignored.has(entry.name)) {
        // A skill may itself be called "build" or "cache". Ignore generated
        // trees, but do not hide an actual skill because of its folder name.
        try { if (!(await lstat(path.join(child, 'SKILL.md'))).isFile()) continue; }
        catch { continue; }
      }
      await walk(child, next, linkedAncestor || stat.isSymbolicLink());
    }
  }
  for (const root of [...new Set(roots.map(p => path.resolve(p)))]) await walk(root);
  return { skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)), warnings, directories };
}

function agentFor(location) {
  const parts = location.split(path.sep);
  for (const [folder, label] of [['.agents', 'Shared'], ['.claude', 'Claude'], ['.codex', 'Codex'], ['.cursor', 'Cursor'], ['.copilot', 'Copilot'], ['.gemini', 'Gemini'], ['.windsurf', 'Windsurf'], ['.roo', 'Roo'], ['.kiro', 'Kiro'], ['.opencode', 'OpenCode']]) {
    if (parts.includes(folder)) return label;
  }
  return parts.includes('opencode') ? 'OpenCode' : 'Other';
}

export async function deleteSkill(skill) {
  if (skill.blocked) throw new Error('This skill is inside a symlinked collection. Manage it at its original path.');
  const stat = await lstat(skill.path);
  if (`${stat.dev}:${stat.ino}` !== skill.identity || stat.isSymbolicLink() !== skill.symlink ||
      await realpath(skill.path) !== skill.realPath || await realpath(path.dirname(skill.path)) !== skill.parent) {
    throw new Error('The skill location changed since scanning. Rescan before deleting.');
  }
  if (!skill.symlink) {
    const marker = await lstat(path.join(skill.path, 'SKILL.md'));
    if (!marker.isFile()) throw new Error('SKILL.md is no longer a regular file. Rescan before deleting.');
  }
  // rm of a symlink removes the link, never its target.
  await rm(skill.path, { recursive: !skill.symlink, force: false });
}
