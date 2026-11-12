#!/usr/bin/env node
// PostToolUse(Skill): records which skills were invoked in this session.
// It is the eye of skill-preflight-gate: the gate verifies against this record.
// Fails open on any error.
import { readStdin, loadConfig, stateDir, loadJson, saveJson } from './lib.mjs';
import { resolve } from 'node:path';

const MAX_SESSIONS = 50;

try {
  const input = readStdin();
  if (input && input.tool_name === 'Skill') {
    const skill = input.tool_input && input.tool_input.skill;
    const sid = input.session_id;
    if (typeof skill === 'string' && skill && sid) {
      const { config } = loadConfig();
      const path = resolve(stateDir(config), 'skill-usage-state.json');
      const state = loadJson(path, { sessions: {} });
      if (!state.sessions || typeof state.sessions !== 'object') state.sessions = {};
      const entry = state.sessions[sid] || { skills: [] };
      if (!Array.isArray(entry.skills)) entry.skills = [];
      if (!entry.skills.includes(skill)) entry.skills.push(skill);
      entry.updated_at = new Date().toISOString();
      state.sessions[sid] = entry;
      const ids = Object.keys(state.sessions);
      if (ids.length > MAX_SESSIONS) {
        const keep = ids
          .sort((a, b) => String(state.sessions[a].updated_at).localeCompare(String(state.sessions[b].updated_at)))
          .slice(-MAX_SESSIONS);
        const trimmed = {};
        for (const id of keep) trimmed[id] = state.sessions[id];
        state.sessions = trimmed;
      }
      saveJson(path, state);
    }
  }
} catch { /* fail open */ }
process.exit(0);
