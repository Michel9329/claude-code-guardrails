// Smoke test: feeds each hook a Claude Code style JSON on stdin and checks the exit code.
// Run with: node test/smoke.mjs   (Node 20+, no dependencies)
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
const root = mkdtempSync(join(tmpdir(), 'guardrails-smoke-'));
let pass = 0;
let fail = 0;

const config = {
  stateDir: '.claude',
  skillGate: {
    maxDeniesWithoutProgress: 3,
    rules: [{ name: 'src', paths: ['src/**'], requireSkills: ['method'], requireAnyOf: ['design-a', 'design-b'] }],
  },
  protectedPaths: {
    patterns: ['templates/**'],
    approvalFile: '.guardrails/APPROVAL.md',
    ttlDays: 14,
    approvers: ['Owner'],
  },
  git: {},
  textRules: [{ name: 'copy', paths: ['clients/**'], extensions: ['md', 'html'], presets: ['google-fonts-cdn', 'em-dash', 'italian-apostrophe-accent'] }],
  sessionClose: { stateFile: 'STATUS.md', staleHours: 6, recentCommitHours: 12 },
  firstEditChecklist: { paths: ['ui/**'] },
  projectIsolation: {
    projects: [
      { id: 'a', root: 'clients/a', guard: ['site/**'], tokens: ['AlphaBrand'] },
      { id: 'b', root: 'clients/b', guard: ['site/**'], tokens: ['BetaBrand'] },
    ],
  },
};
writeFileSync(join(root, 'guardrails.config.json'), JSON.stringify(config), 'utf-8');

function run(hook, payload, env = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, hook)], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
    encoding: 'utf-8',
  });
  return r.status;
}

function expect(name, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (exit ${got}, expected ${want})`);
}

const edit = (rel, extra = {}, session = 's1') => ({
  session_id: session,
  tool_name: 'Write',
  tool_input: { file_path: join(root, rel), content: 'hello', ...extra },
});
const skill = (name, session = 's1') => ({ session_id: session, tool_name: 'Skill', tool_input: { skill: name } });
const bash = (command) => ({ session_id: 's1', tool_name: 'Bash', tool_input: { command } });

// 1. skill-preflight-gate + skill-usage-track
expect('skill gate: deny without skills', run('skill-preflight-gate.mjs', edit('src/a.js')), 2);
expect('skill gate: allow outside rule paths', run('skill-preflight-gate.mjs', edit('README.md')), 0);
run('skill-usage-track.mjs', skill('method'));
expect('skill gate: still deny, anyOf missing', run('skill-preflight-gate.mjs', edit('src/a.js')), 2);
run('skill-usage-track.mjs', skill('design-b'));
expect('skill gate: allow once skills were invoked', run('skill-preflight-gate.mjs', edit('src/a.js')), 0);
expect('skill gate: deny is per session', run('skill-preflight-gate.mjs', edit('src/a.js', {}, 's2')), 2);
run('skill-preflight-gate.mjs', edit('src/a.js', {}, 's3'));
run('skill-preflight-gate.mjs', edit('src/a.js', {}, 's3'));
run('skill-preflight-gate.mjs', edit('src/a.js', {}, 's3'));
expect('skill gate: fail-open after 3 denials without progress', run('skill-preflight-gate.mjs', edit('src/a.js', {}, 's3')), 0);

// 2. protected-paths-block
expect('protected: deny without approval', run('protected-paths-block.mjs', edit('templates/x.html')), 2);
expect('protected: allow unprotected path', run('protected-paths-block.mjs', edit('src/x.js')), 0);
mkdirSync(join(root, '.guardrails'), { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const approval = (by, at, paths) => `---\napproved_by: ${by}\napproved_at: ${at}\npaths:\n${paths.map((p) => `  - ${p}`).join('\n')}\n---\nnotes\n`;
writeFileSync(join(root, '.guardrails/APPROVAL.md'), approval('Owner', today, ['templates/brand/**']), 'utf-8');
expect('protected: allow when approval covers the path', run('protected-paths-block.mjs', edit('templates/brand/a.html')), 0);
expect('protected: deny when approval does not cover the path', run('protected-paths-block.mjs', edit('templates/legal/a.html')), 2);
writeFileSync(join(root, '.guardrails/APPROVAL.md'), approval('Owner', '2020-01-01', ['templates/**']), 'utf-8');
expect('protected: deny when approval is expired (TTL)', run('protected-paths-block.mjs', edit('templates/brand/a.html')), 2);
writeFileSync(join(root, '.guardrails/APPROVAL.md'), approval('Someone Else', today, ['templates/**']), 'utf-8');
expect('protected: deny when approver is not listed', run('protected-paths-block.mjs', edit('templates/brand/a.html')), 2);

// 3. git-discipline-gate
expect('git: deny --amend', run('git-discipline-gate.mjs', bash('git commit --amend -m x')), 2);
expect('git: deny commit without pathspec', run('git-discipline-gate.mjs', bash('git commit -m "msg"')), 2);
expect('git: deny rm -fr', run('git-discipline-gate.mjs', bash('rm -fr build')), 2);
expect('git: deny rm --recursive --force', run('git-discipline-gate.mjs', bash('ls && rm --recursive --force build')), 2);
expect('git: allow commit with pathspec', run('git-discipline-gate.mjs', bash('git commit -m "msg" -- a.txt b.txt')), 0);
expect('git: allow plain rm', run('git-discipline-gate.mjs', bash('rm notes.txt')), 0);
expect('git: allow quoted mention of --amend', run('git-discipline-gate.mjs', bash('echo "git commit --amend"')), 0);

// 4. deliverable-text-gate
const text = (rel, content) => edit(rel, { content });
expect('text: deny Google Fonts CDN', run('deliverable-text-gate.mjs', text('clients/a/page.html', '<link href="https://fonts.googleapis.com/css">')), 2);
expect('text: deny apostrophe for accent', run('deliverable-text-gate.mjs', text('clients/a/t.md', 'Lo faccio perche\' serve.')), 2);
expect('text: warn on em-dash (exit 1)', run('deliverable-text-gate.mjs', text('clients/a/t.md', 'Uno — due.')), 1);
expect('text: allow clean text', run('deliverable-text-gate.mjs', text('clients/a/t.md', 'Lo faccio perché serve.')), 0);
expect('text: allow outside rule paths', run('deliverable-text-gate.mjs', text('src/t.md', 'perche\' —')), 0);

// 5a. session-close-guard
execFileSync('git', ['init', '-q'], { cwd: root });
writeFileSync(join(root, 'STATUS.md'), 'status', 'utf-8');
const old = new Date(Date.now() - 10 * 3600 * 1000);
utimesSync(join(root, 'STATUS.md'), old, old);
const stop = { hook_event_name: 'Stop', session_id: 's1' };
expect('session-close: block once on Stop (stale status, dirty tree)', run('session-close-guard.mjs', stop), 2);
expect('session-close: second Stop passes with warning', run('session-close-guard.mjs', { ...stop, stop_hook_active: true }), 1);
expect('session-close: PreCompact only warns', run('session-close-guard.mjs', { ...stop, hook_event_name: 'PreCompact' }), 1);
utimesSync(join(root, 'STATUS.md'), new Date(), new Date());
expect('session-close: allow when status is fresh', run('session-close-guard.mjs', stop), 0);

// 5b. prebuild-ui-reuse-gate
expect('checklist: deny first matching edit', run('prebuild-ui-reuse-gate.mjs', edit('ui/Card.tsx')), 2);
expect('checklist: allow the retry', run('prebuild-ui-reuse-gate.mjs', edit('ui/Card.tsx')), 0);
expect('checklist: allow non-matching path', run('prebuild-ui-reuse-gate.mjs', edit('docs/a.md', {}, 's9')), 0);

// 5c. client-isolation-guard
expect('isolation: deny foreign token', run('client-isolation-guard.mjs', edit('clients/a/site/x.html', { content: 'Welcome to BetaBrand' })), 2);
expect('isolation: allow own token', run('client-isolation-guard.mjs', edit('clients/a/site/x.html', { content: 'Welcome to AlphaBrand' })), 0);
expect('isolation: allow foreign token outside guarded globs', run('client-isolation-guard.mjs', edit('clients/a/notes/x.md', { content: 'BetaBrand' })), 0);

// Shipped example files must parse, and globs with braces must work.
const { stripJsonComments, globToRegex } = await import(join(HOOKS, 'lib.mjs').replace(/^/, 'file:///').replace(/\\/g, '/'));
const { readFileSync } = await import('node:fs');
const repo = resolve(HOOKS, '..');
let exampleOk = true;
try {
  JSON.parse(stripJsonComments(readFileSync(join(repo, 'guardrails.config.example.json'), 'utf-8')));
  JSON.parse(readFileSync(join(repo, 'settings.example.json'), 'utf-8'));
} catch { exampleOk = false; }
expect('example config and settings example parse', exampleOk ? 0 : 1, 0);
expect('glob: braces and **', globToRegex('src/**/*.{tsx,vue}').test('src/a/b/c.vue') ? 0 : 1, 0);

// Config errors: protected-paths is fail-closed, the others fail open.
writeFileSync(join(root, 'guardrails.config.json'), '{ broken', 'utf-8');
expect('broken config: protected-paths denies (fail-closed)', run('protected-paths-block.mjs', edit('src/x.js')), 2);
expect('broken config: text gate fails open', run('deliverable-text-gate.mjs', text('clients/a/t.md', 'perche\'')), 0);

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
