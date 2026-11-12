#!/usr/bin/env node
// Stop + PreCompact: reminds the model to update a status file before the session ends.
//   Stop:       if the status file is older than staleHours AND the session left real work
//               (dirty git tree or a commit in the last recentCommitHours), block once (exit 2).
//               stop_hook_active in the payload prevents a loop: the second Stop passes.
//   PreCompact: same check, warning only (exit 1). A needed compaction is never blocked.
// Fails open on error.
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readStdin, loadConfig, projectDir } from './lib.mjs';

function git(args) {
  try {
    return execFileSync('git', args, { cwd: projectDir(), timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

try {
  if (process.env.GUARDRAILS_SKIP === '1') process.exit(0);
  const payload = readStdin() || {};
  const { config } = loadConfig();
  const cfg = config && config.sessionClose;
  if (!cfg || cfg.enabled === false || !cfg.stateFile) process.exit(0);

  const file = resolve(projectDir(), cfg.stateFile);
  if (!existsSync(file)) process.exit(0);
  const staleHours = Number.isFinite(cfg.staleHours) ? cfg.staleHours : 6;
  const recentHours = Number.isFinite(cfg.recentCommitHours) ? cfg.recentCommitHours : 12;
  const ageH = (Date.now() - statSync(file).mtimeMs) / 3600000;
  if (ageH < staleHours) process.exit(0);

  const dirty = git(['status', '--porcelain']);
  const ts = parseInt(git(['log', '-1', '--format=%ct']), 10);
  const recent = Number.isFinite(ts) && Date.now() - ts * 1000 < recentHours * 3600000;
  if (!dirty && !recent) process.exit(0);

  const msg = `[session-close-guard] ${cfg.stateFile} has not changed for ${Math.round(ageH)}h but this session has real work (working tree ${dirty ? 'dirty' : 'clean'}, recent commit: ${recent ? 'yes' : 'no'}). ${cfg.message || 'Update it before closing.'}`;
  const event = payload.hook_event_name || 'Stop';
  process.stderr.write(msg + '\n');
  process.exit(event === 'Stop' && !payload.stop_hook_active ? 2 : 1);
} catch {
  process.exit(0);
}
