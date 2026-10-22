import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, readFile, lstat, rm, realpath, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { discover, deleteSkill, metadata } from '../lib/discovery.js';
import { clean, groupSkills, deletionRisk, renderBrowser } from '../lib/ui.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'skills-manager-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function skill(relative, name = 'example') {
    const directory = path.join(root, relative);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: A test skill\n---\nInstructions.`);
    return directory;
  }
  return { root, skill };
}

test('finds global, nested project, hidden skills and duplicate names; skips dependencies', async t => {
  const { root, skill } = await fixture(t);
  await skill('.agents/skills/design', 'design');
  await skill('projects/demo/.claude/skills/design', 'design');
  await skill('.codex/skills/.system/builtin', 'builtin');
  await skill('node_modules/package/skills/ignored', 'ignored');
  const result = await discover([root, path.join(root, '.agents/skills')]);
  assert.deepEqual(result.skills.map(s => s.name), ['builtin', 'design', 'design']);
  assert.equal(result.skills.find(s => s.agent === 'Claude').blocked, false);
  assert.equal(result.warnings.length, 0);
});

test('explicit roots discover plugin caches skipped by a home scan', async t => {
  const { root, skill } = await fixture(t);
  const plugin = await skill('.codex/plugins/cache/vendor/tool/1.0/skills/example');
  assert.equal((await discover([root])).skills.length, 0);
  assert.equal((await discover([path.join(root, '.codex/plugins/cache')])).skills[0].path, plugin);
});

test('does not hide an installed skill named build or cache', async t => {
  const { root, skill } = await fixture(t);
  await skill('.agents/skills/build', 'build');
  await skill('.agents/skills/cache', 'cache');
  assert.deepEqual((await discover([root])).skills.map(s => s.name), ['build', 'cache']);
});

test('removes a selected folder and preserves other skills', async t => {
  const { root, skill } = await fixture(t);
  const first = await skill('skills/first', 'first');
  const second = await skill('skills/second', 'second');
  const result = await discover([root]);
  await deleteSkill(result.skills.find(s => s.name === 'first'));
  await assert.rejects(lstat(first), { code: 'ENOENT' });
  assert.match(await readFile(path.join(second, 'SKILL.md'), 'utf8'), /second/);
});

test('unlinks a skill symlink without deleting its target; handles loops', async t => {
  const { root, skill } = await fixture(t);
  const target = await skill('shared/example');
  await mkdir(path.join(root, 'agent'));
  await symlink(target, path.join(root, 'agent/example'), 'dir');
  await symlink(root, path.join(root, 'loop'), 'dir');
  const result = await discover([root]);
  const link = result.skills.find(s => s.symlink);
  assert.ok(link);
  await deleteSkill(link);
  assert.match(await readFile(path.join(target, 'SKILL.md'), 'utf8'), /example/);
  await assert.rejects(lstat(link.path), { code: 'ENOENT' });
});

test('blocks deletion through a symlinked collection, including child symlinks', async t => {
  const { root, skill } = await fixture(t);
  await skill('collection/example');
  await symlink(path.join(root, 'collection/example'), path.join(root, 'collection/alias'), 'dir');
  await symlink(path.join(root, 'collection'), path.join(root, 'linked'), 'dir');
  const result = await discover([path.join(root, 'linked')]);
  assert.equal(result.skills.length, 2);
  for (const s of result.skills) {
    assert.equal(s.blocked, true);
    await assert.rejects(deleteSkill(s), /symlinked collection/);
  }
});

test('refuses a replaced folder after inventory was taken', async t => {
  const { root, skill } = await fixture(t);
  const directory = await skill('example');
  const { skills } = await discover([root]);
  await rename(directory, directory + '-old');
  await skill('example', 'replacement');
  await assert.rejects(deleteSkill(skills[0]), /changed since scanning/);
  assert.match(await readFile(path.join(directory, 'SKILL.md'), 'utf8'), /replacement/);
});

test('reads common metadata styles and sanitizes terminal control characters', () => {
  assert.deepEqual(metadata('---\nname: "test"\ndescription: >-\n  first line\n  second line\n---\n', 'fallback'), { name: 'test', description: 'first line second line' });
  assert.equal(metadata('# Just instructions', 'fallback').name, 'fallback');
  assert.equal(clean('\x1b[2Jhello\nworld'), 'hello world');
});

test('groups duplicate installs and named families while preserving every installation', () => {
  const skills = [
    { name: 'archify', path: '/shared/archify', description: 'Draw diagrams.' },
    { name: 'archify', path: '/claude/archify', description: 'Draw diagrams.' },
    { name: 'hyperframes-audio', path: '/audio', description: 'Mix audio.' },
    { name: 'hyperframes', path: '/base', description: 'Create videos.' },
    { name: 'hyperframes-core', path: '/core' },
    { name: 'documents:edit', path: '/edit' },
    { name: 'documents:create', path: '/create' },
    { name: 'unrelated-tool', path: '/other' },
  ];
  const groups = groupSkills(skills);
  assert.deepEqual(groups.map(g => [g.name, g.items.length]), [
    ['archify', 2], ['documents', 2], ['hyperframes', 3], ['unrelated', 1],
  ]);
  assert.equal(groups.find(g => g.name === 'hyperframes').description, 'Create videos.');
  assert.equal(new Set(groups.flatMap(g => g.items.map(s => s.path))).size, skills.length);
});

test('groups by the first dash without requiring a base skill to be installed', () => {
  const skills = [
    { name: 'archify-diagrams', path: '/a' },
    { name: 'archify-workflows', path: '/b' },
    { name: 'reversa-debugger-fix', path: '/c' },
    { name: 'reversa-docs', path: '/d' },
    { name: 'Reversa-Forward', path: '/e' },
    { name: 'standalone', path: '/f' },
  ];
  assert.deepEqual(groupSkills(skills).map(g => [g.name, g.items.map(s => s.path)]), [
    ['archify', ['/a', '/b']], ['reversa', ['/c', '/d', '/e']], ['standalone', ['/f']],
  ]);
});

test('CLI JSON and noninteractive list never delete; invalid options fail', async t => {
  const { root, skill } = await fixture(t);
  const directory = await skill('example', 'cli-test');
  const bin = path.resolve('bin/skills-manager.js');
  const output = execFileSync(process.execPath, [bin, '--root', root, '--json'], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).skills[0].name, 'cli-test');
  assert.match(execFileSync(process.execPath, [bin, '--root', root], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), /interactive terminal/);
  assert.ok(await lstat(directory));
  assert.throws(() => execFileSync(process.execPath, [bin, '--root'], { stdio: 'pipe' }), { status: 1 });
});

test('deletion risk distinguishes shortcuts, normal folders, built-ins, and plugin installs', () => {
  const skill = { path: '/home/user/.agents/skills/archify', agent: 'Shared' };
  assert.equal(deletionRisk(skill).level, 'MEDIUM');
  assert.match(deletionRisk(skill).reason, /multiple agents/);
  assert.equal(deletionRisk({ ...skill, path: '/project/.claude/skills/test' }).level, 'MEDIUM');
  assert.equal(deletionRisk({ ...skill, symlink: true }).level, 'LOW');
  assert.equal(deletionRisk({ path: '/home/.codex/skills/.system/test' }).level, 'HIGH');
  assert.equal(deletionRisk({ path: '/home/.codex/plugins/cache/tool/skills/test' }).level, 'HIGH');
  assert.equal(deletionRisk({ path: 'C:\\Users\\user\\.codex\\skills\\.system\\test' }).level, 'HIGH');
  assert.equal(deletionRisk({ path: '/project/my-plugins/skills/test' }).level, 'MEDIUM');
  // A shortcut to a built-in still only removes the shortcut.
  assert.equal(deletionRisk({ path: '/home/.codex/skills/.system/test', symlink: true }).level, 'LOW');
});

test('deletion review identifies folders backing other discovered installations', () => {
  const original = { path: '/shared/archify', realPath: '/shared/archify' };
  const link = { path: '/claude/archify', realPath: '/shared/archify', symlink: true };
  const inventory = [original, link];
  assert.equal(deletionRisk(original, inventory).level, 'HIGH');
  assert.match(deletionRisk(original, inventory).reason, /Other installations reference/);
  assert.equal(deletionRisk(link, inventory).level, 'LOW');
  assert.equal(deletionRisk(original, [original]).level, 'MEDIUM');
});

test('browser stays within terminal dimensions and shows only the focused description', () => {
  const skills = Array.from({ length: 30 }, (_, i) => ({
    name: `group${String(i).padStart(2, '0')}`, path: `/skills/${i}`,
    description: `Description for skill ${i}.`, agent: 'Shared',
  }));
  const items = groupSkills(skills);
  for (const [columns, rows] of [[40, 12], [80, 24], [120, 40]]) {
    for (const showHelp of [false, true]) {
      const rendered = renderBrowser({ items, cursor: 15, selected: new Set(),
        totalGroups: items.length, totalSkills: skills.length, query: '', columns, rows, showHelp });
      const lines = rendered.split('\n');
      assert.ok(lines.length < rows);
      assert.ok(lines.every(line => Array.from(line).length < columns));
      assert.ok((rendered.match(/\[ \]/g) || []).length <= 10);
      assert.match(rendered, /group15/);
      assert.match(rendered, /enter open/);
      if (rows >= 20) {
        assert.match(rendered, /Description for skill 15/);
        assert.doesNotMatch(rendered, /Description for skill 14/);
      }
    }
  }
});

test('browser renders empty search, selection, and optional color without unsafe metadata escapes', () => {
  const empty = renderBrowser({ items: [], cursor: 0, selected: new Set(),
    totalGroups: 2, totalSkills: 4, query: 'missing' });
  assert.match(empty, /No matches/);
  assert.match(empty, /0 results/);
  const skill = { name: 'example\x1b[2J', path: '/skills/example', agent: 'Shared', description: 'Example.' };
  const state = { items: [skill], cursor: 0, activeGroup: { name: 'example' },
    selected: new Set([skill.path]), totalGroups: 1, totalSkills: 1, query: '' };
  const plain = renderBrowser(state);
  assert.match(plain, /\[x\]/);
  assert.match(plain, /1 selected/);
  assert.match(plain, /\/skills\/example/);
  assert.doesNotMatch(plain, /\x1b/);
  assert.match(renderBrowser({ ...state, color: true }), /\x1b\[7(?:;\d+)*m/);
});
