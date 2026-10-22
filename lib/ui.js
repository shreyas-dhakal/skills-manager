import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';

// Skill metadata is untrusted terminal text. Strip control/escape sequences.
export function clean(value) {
  return String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ');
}
export function shortPath(value) {
  const home = os.homedir();
  return value === home ? '~' : value.startsWith(home + path.sep) ? '~' + value.slice(home.length) : value;
}

export function skillSummary(skill) {
  const description = clean(skill.description || '').replace(/\s+/g, ' ').trim();
  const sentence = description.match(/^.*?[.!?](?=\s|$)/)?.[0] || description || 'No description available.';
  const brief = sentence.length > 100 ? sentence.slice(0, 97).trimEnd() + '…' : sentence;
  return `${clean(skill.name)}${skill.blocked ? ' (read only)' : ''} — ${brief}`;
}

export function groupSkills(skills) {
  const groups = new Map();
  for (const skill of skills) {
    const name = skill.name.trim().toLowerCase();
    const key = name.split(/[:-]/)[0] || name;
    if (!groups.has(key)) groups.set(key, { name: key, description: skill.description, items: [] });
    const group = groups.get(key);
    group.items.push(skill);
    if (name === key) {
      group.name = skill.name;
      group.description = skill.description;
    }
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function cellWidth(char) {
  if (/\p{Mark}|[\u200d\ufe0e\ufe0f]/u.test(char)) return 0;
  const code = char.codePointAt(0);
  return code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) || code >= 0x1f000) ? 2 : 1;
}

function fit(value, width) {
  const chars = Array.from(clean(value));
  if (chars.reduce((sum, char) => sum + cellWidth(char), 0) <= width) return chars.join('');
  let result = '', used = 0;
  for (const char of chars) {
    if (used + cellWidth(char) > width - 1) break;
    result += char; used += cellWidth(char);
  }
  return result + '…';
}

function browserPageSize(rows, showHelp) {
  return Math.max(1, Math.min(10, rows - (rows < 20 ? 10 : 12) - (showHelp ? 2 : 0)));
}

function terminalColors() {
  if ('NO_COLOR' in process.env || process.env.FORCE_COLOR === '0') return false;
  if ('FORCE_COLOR' in process.env) return true;
  return process.stdout.isTTY && process.env.TERM !== 'dumb';
}

export function renderBrowser({ items, cursor, activeGroup, query, selected, totalGroups,
  totalSkills, columns = 80, rows = 24, color = false, showHelp = false }) {
  const width = Math.max(8, Math.min(96, columns - 4));
  const paint = (code, value) => color ? `\x1b[${code}m${value}\x1b[0m` : value;
  const muted = value => paint('2', value);
  const accent = value => paint('36;1', value);
  const success = value => paint('32;1', value);
  const compact = rows < 20;
  const pageSize = browserPageSize(rows, showHelp);
  const start = Math.floor(cursor / pageSize) * pageSize;
  const end = Math.min(start + pageSize, items.length);
  const lines = [];
  const add = (value = '', style = v => v) => lines.push('  ' + style(fit(value, width)));
  if (!compact) add();
  add('skills manager', value => paint('35;1', value));
  add(activeGroup ? `Skills / ${activeGroup.name}` : `${totalGroups} groups · ${totalSkills} installations`, accent);
  if (!compact) add();
  add(query ? `Search  ${query}_` : 'Search  type to filter', value => paint(query ? '33;1' : '33', value));
  add();
  for (let i = start; i < end; i++) {
    const item = items[i];
    const members = (activeGroup ? [item] : item.items).filter(s => !s.blocked);
    const count = members.filter(s => selected.has(s.path)).length;
    const check = members.length && count === members.length ? 'x' : count ? '-' : ' ';
    const left = `${i === cursor ? '›' : ' '} [${check}] ${item.name}`;
    const right = activeGroup ? (item.blocked ? 'read only' : item.agent || 'Other') :
      `${item.items.length} ${item.items.length === 1 ? 'install' : 'installs'}  ›`;
    const leftWidth = Math.max(1, width - right.length - 3);
    const label = fit(left, leftWidth);
    const gap = Math.max(1, width - Array.from(label).reduce((sum, c) => sum + cellWidth(c), 0) - right.length);
    add(label + ' '.repeat(gap) + right, value => {
      if (i === cursor) return paint('7;36;1', value);
      if (count) return success(value);
      const suffix = clean(right);
      return value.endsWith(suffix) ? value.slice(0, -suffix.length) + paint(item.blocked ? '33' : '36', suffix) : value;
    });
  }
  if (!items.length) add('No matches. Backspace to clear your search.', muted);
  // Keep the detail area and controls in place while paging or filtering.
  for (let i = Math.max(1, end - start); i < pageSize; i++) add();
  add();
  const focused = items[cursor];
  if (!compact) {
    add(focused ? skillSummary(focused) : 'Try a skill name, agent, or folder.', muted);
    add(focused ? activeGroup ? shortPath(focused.path) : 'Enter to explore installations in this group.' : '',
      activeGroup ? value => paint('34', value) : muted);
    add();
  } else {
    add(focused ? activeGroup ? shortPath(focused.path) : skillSummary(focused) : '', muted);
  }
  const range = items.length ? `${start + 1}–${end} of ${items.length}` : '0 results';
  add(`${range}  ·  ${selected.size ? `${selected.size} selected` : 'nothing selected'}`, selected.size ? success : accent);
  add(width < 55 ? `↑↓ move · enter ${activeGroup ? 'review' : 'open'} · ? help` :
    `↑↓ move  enter ${activeGroup ? 'review' : 'open'}  space select  ? help`, value => paint('36', value));
  if (showHelp) {
    add('Type to search · PgUp/PgDn page · Home/End jump', muted);
    add(`Ctrl+A select shown · Ctrl+D review · ${activeGroup ? '←/Esc back' : 'Esc quit'}`, muted);
  }
  return lines.slice(0, Math.max(1, rows - 1)).join('\n');
}

export function selectSkills(skills) {
  const input = process.stdin, output = process.stdout;
  return new Promise(resolve => {
    const groups = groupSkills(skills);
    let query = '', cursor = 0, activeGroup = null, parentState = null, showHelp = false;
    const selected = new Set();
    const matches = s => `${s.name} ${s.agent} ${s.path} ${s.description}`.toLowerCase().includes(query.toLowerCase());
    const filtered = () => activeGroup ? activeGroup.items.filter(matches) :
      groups.filter(g => g.name.toLowerCase().includes(query.toLowerCase()) || g.items.some(matches));
    const installations = item => activeGroup ? [item] : item.items;
    function toggle(items) {
      const eligible = items.filter(s => !s.blocked);
      const all = eligible.every(s => selected.has(s.path));
      for (const s of eligible) all ? selected.delete(s.path) : selected.add(s.path);
    }
    function open(group) {
      if (!group) return;
      parentState = { query, cursor };
      activeGroup = group;
      query = ''; cursor = 0;
    }
    function back() {
      activeGroup = null;
      ({ query, cursor } = parentState);
      parentState = null;
    }
    function render() {
      const items = filtered();
      cursor = Math.max(0, Math.min(cursor, items.length - 1));
      output.write('\x1b[H\x1b[2J' + renderBrowser({ items, cursor, activeGroup, query, selected,
        totalGroups: groups.length, totalSkills: skills.length, columns: output.columns || 80,
        rows: output.rows || 24, showHelp,
        color: terminalColors() }));
    }
    function finish(result) {
      input.removeListener('keypress', onKey);
      output.removeListener('resize', render);
      input.setRawMode(false);
      input.pause();
      output.write('\x1b[?25h\x1b[?1049l');
      resolve(result);
    }
    function onKey(text, key = {}) {
      const items = filtered();
      if (key.ctrl && key.name === 'c') return finish(null);
      if (key.name === 'escape') {
        if (!activeGroup) return finish(null);
        back(); render(); return;
      }
      if (key.name === 'up') cursor--;
      else if (key.name === 'down') cursor++;
      else if (key.name === 'pageup' || key.name === 'pagedown') {
        const height = output.rows || 24;
        const page = browserPageSize(height, showHelp);
        cursor += key.name === 'pageup' ? -page : page;
      }
      else if (key.name === 'home') cursor = 0;
      else if (key.name === 'end') cursor = items.length - 1;
      else if (text === '?') showHelp = !showHelp;
      else if (key.ctrl && key.name === 'd') return finish(skills.filter(s => selected.has(s.path)));
      else if (key.name === 'left' && activeGroup) back();
      else if (key.name === 'right' && !activeGroup) open(items[cursor]);
      else if (key.name === 'return') {
        if (activeGroup) return finish(skills.filter(s => selected.has(s.path)));
        open(items[cursor]);
      }
      else if (key.ctrl && key.name === 'a') {
        toggle(items.flatMap(installations));
      } else if (key.name === 'space') {
        if (items[cursor]) toggle(installations(items[cursor]));
      } else if (key.name === 'backspace') { query = Array.from(query).slice(0, -1).join(''); cursor = 0; }
      else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f-\x9f]/.test(text)) { query += text; cursor = 0; }
      render();
    }
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on('keypress', onKey);
    output.on('resize', render);
    output.write('\x1b[?1049h\x1b[?25l');
    render();
  });
}

export function deletionRisk(skill, inventory = []) {
  if (skill.blocked) return { level: 'HIGH', reason: 'Inside a linked collection; deletion is blocked.' };
  if (skill.symlink) return { level: 'LOW', reason: 'Removes only this shortcut; the original skill stays.' };
  const parts = skill.path.split(/[\\/]/);
  if (parts.includes('.system')) {
    return { level: 'HIGH', reason: 'Built-in skill; removing it may disrupt agent features.' };
  }
  if (parts.includes('plugins')) {
    return { level: 'HIGH', reason: 'Plugin-managed skill; deletion may disrupt the plugin or be undone by an update.' };
  }
  if (skill.realPath && inventory.some(other => other.path !== skill.path && other.realPath === skill.realPath)) {
    return { level: 'HIGH', reason: 'Other installations reference this folder; deleting it may break them.' };
  }
  return { level: 'MEDIUM', reason: skill.agent === 'Shared' ?
    'Deletes the shared skill and its files; multiple agents may use it.' :
    'Permanently deletes this skill folder, including scripts and assets.' };
}

export async function confirmDeletion(skills, inventory = skills) {
  const color = terminalColors();
  const paint = (code, value) => color ? `\x1b[${code}m${value}\x1b[0m` : value;
  const riskColor = { HIGH: '31;1', MEDIUM: '33;1', LOW: '32;1' };
  const reviewed = skills.map(skill => ({ skill, risk: deletionRisk(skill, inventory) }));
  const counts = ['HIGH', 'MEDIUM', 'LOW'].map(level => {
    const count = reviewed.filter(item => item.risk.level === level).length;
    return count ? paint(riskColor[level], `${count} ${level.toLowerCase()}`) : null;
  }).filter(Boolean);
  console.log(`\nDeletion risk: ${counts.join(' · ')}`);
  console.log(`\nSelected ${skills.length} skill installation(s):\n`);
  for (const { skill, risk } of reviewed) {
    console.log(`  ${paint(riskColor[risk.level], `[${risk.level}]`)} ${paint('1', clean(skill.name))} — ${risk.reason}\n    ${paint('34', clean(skill.path))}`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise(resolve => {
      rl.once('close', () => resolve(false));
      rl.question('\nType "delete" to confirm, or press Enter to cancel: ', answer => resolve(answer.trim() === 'delete'));
    });
  } finally { rl.close(); }
}
