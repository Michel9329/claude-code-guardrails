#!/usr/bin/env node
// PreToolUse(Edit|Write|MultiEdit): "look before you build" checkpoint.
// The first time per session the model writes a file matching config "firstEditChecklist.paths",
// the write is denied once with a checklist (search for an existing implementation and reuse it).
// The session is marked satisfied at that moment, so the retry passes. Fails open on error.
import { resolve } from 'node:path';
import { readStdin, loadConfig, relPath, matchAny, deny, loadJson, saveJson, stateDir, EDIT_TOOLS } from './lib.mjs';

try {
  const input = readStdin();
  if (input && EDIT_TOOLS.includes(input.tool_name) && input.tool_input && input.tool_input.file_path) {
    const { config } = loadConfig();
    const cfg = config && config.firstEditChecklist;
    if (cfg && cfg.enabled !== false && Array.isArray(cfg.paths)) {
      const rel = relPath(input.tool_input.file_path);
      if (rel && matchAny(rel, cfg.paths) && !matchAny(rel, cfg.exclude)) {
        const sid = input.session_id || 'unknown';
        const path = resolve(stateDir(config), 'first-edit-checklist-state.json');
        const state = loadJson(path, { satisfiedSessions: [] });
        if (!Array.isArray(state.satisfiedSessions)) state.satisfiedSessions = [];
        if (!state.satisfiedSessions.includes(sid)) {
          state.satisfiedSessions.push(sid);
          if (state.satisfiedSessions.length > 50) state.satisfiedSessions = state.satisfiedSessions.slice(-50);
          saveJson(path, state);
          const items = Array.isArray(cfg.checklist) && cfg.checklist.length
            ? cfg.checklist
            : ['Search the codebase for an existing implementation of what you are about to build.', 'Reuse or port it instead of rewriting it.'];
          deny('prebuild-ui-reuse-gate', [
            `STOP: first-edit checklist (once per session). You are about to write ${rel}.`,
            '',
            ...items.map((s, i) => `  ${i + 1}. ${s}`),
            '',
            'Do the check, then retry the same edit. You will not be blocked again in this session.',
          ].join('\n'));
        }
      }
    }
  }
} catch { /* fail open */ }
process.exit(0);
