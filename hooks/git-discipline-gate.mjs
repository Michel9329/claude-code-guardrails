#!/usr/bin/env node
// PreToolUse(Bash): git discipline.
//   DENY git ... --amend                       (rewrites history, can swallow files from parallel sessions)
//   DENY git commit without explicit pathspec  (no " -- <paths>" separator)
//   DENY recursive + forced rm in any spelling (-rf, -fr, -r -f, --recursive --force)
// Each rule can be turned off in config under "git". Text inside quotes is ignored, so an echo
// that merely mentions "git commit --amend" is not blocked. Fails open on error.
import { readStdin, loadConfig, deny } from './lib.mjs';

function stripQuoted(s) {
  return String(s).replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function segments(cmd) {
  return stripQuoted(cmd).split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
}

try {
  const input = readStdin();
  if (input && input.tool_name === 'Bash') {
    const { config } = loadConfig();
    const cfg = (config && config.git) || {};
    if (config && cfg.enabled !== false) {
      const command = String(input.tool_input && input.tool_input.command || '');
      for (const seg of segments(command)) {
        if (cfg.denyAmend !== false && /\bgit\b/.test(seg) && /--amend\b/.test(seg)) {
          deny('git-discipline-gate', 'git --amend is blocked (it rewrites history and can pull in files from parallel sessions). Make a new commit with explicit pathspecs.');
        }
        if (cfg.requirePathspecOnCommit !== false
            && /\bgit\b[^\n]*\bcommit\b/.test(seg)
            && !/\s--\s/.test(seg)
            && !/--allow-empty\b/.test(seg)
            && !/--(continue|abort)\b/.test(seg)) {
          deny('git-discipline-gate', 'git commit without explicit pathspecs is blocked. Use: git commit -m "..." -- <paths>, so changes from other sessions are not swept in.');
        }
        if (cfg.denyForcedRecursiveRm !== false && /(^|\s)rm\s/.test(seg)) {
          const hasR = /\s-{1,2}[a-zA-Z]*r/i.test(seg) || /--recursive\b/.test(seg);
          const hasF = /\s-[a-zA-Z]*f/.test(seg) || /--force\b/.test(seg);
          if (hasR && hasF) {
            deny('git-discipline-gate', 'Recursive forced rm is blocked in every spelling (-rf, -fr, -r -f, --recursive --force). Move the files to an archive folder, or ask the owner.');
          }
        }
      }
    }
  }
} catch (e) {
  process.stderr.write(`[git-discipline-gate] error (fail-open): ${e && e.message ? e.message : e}\n`);
}
process.exit(0);
