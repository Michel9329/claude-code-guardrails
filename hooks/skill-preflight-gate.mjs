#!/usr/bin/env node
// PreToolUse(Edit|Write|MultiEdit): positive gate. Denies a write to configured paths until the
// required skills show up in this session's usage record (written by skill-usage-track.mjs).
// Anti-deadlock: the counter resets whenever the model loads a new skill. After
// maxDeniesWithoutProgress consecutive denials with no new skill, the gate fails open with a
// warning on stderr, so a broken tracker never freezes the work.
// Fails open on any error.
import { readStdin, loadConfig, relPath, matchAny, deny, loadJson, saveJson, stateDir, isSubagentTranscript, EDIT_TOOLS } from './lib.mjs';
import { resolve } from 'node:path';

function main() {
  const input = readStdin();
  if (!input || !EDIT_TOOLS.includes(input.tool_name)) return;
  const filePath = input.tool_input && input.tool_input.file_path;
  if (!filePath) return;

  const { config } = loadConfig();
  const cfg = config && config.skillGate;
  if (!cfg || cfg.enabled === false || !Array.isArray(cfg.rules)) return;
  if (cfg.skipSubagents !== false && isSubagentTranscript(input)) return;

  const rel = relPath(filePath);
  if (!rel) return;

  const sid = input.session_id || 'unknown';
  const dir = stateDir(config);
  const usage = loadJson(resolve(dir, 'skill-usage-state.json'), { sessions: {} });
  const entry = usage.sessions && usage.sessions[sid];
  const used = new Set(entry && Array.isArray(entry.skills) ? entry.skills : []);

  const missing = [];
  const messages = [];
  for (const rule of cfg.rules) {
    if (!matchAny(rel, rule.paths) || matchAny(rel, rule.exclude)) continue;
    for (const s of rule.requireSkills || []) {
      if (!used.has(s) && !missing.includes(s)) missing.push(s);
    }
    const any = rule.requireAnyOf;
    if (Array.isArray(any) && any.length && !any.some((s) => used.has(s))) {
      const label = `one of: ${any.join(', ')}`;
      if (!missing.includes(label)) missing.push(label);
    }
    if (rule.message) messages.push(rule.message);
  }
  if (missing.length === 0) return;

  const max = Number.isInteger(cfg.maxDeniesWithoutProgress) ? cfg.maxDeniesWithoutProgress : 3;
  const gatePath = resolve(dir, 'skill-preflight-state.json');
  const gate = loadJson(gatePath, { sessions: {} });
  if (!gate.sessions || typeof gate.sessions !== 'object') gate.sessions = {};
  const prev = gate.sessions[sid] || { denies: 0, skills_at_last_deny: -1 };
  const progress = used.size > prev.skills_at_last_deny;
  const denies = progress ? 1 : prev.denies + 1;

  if (denies > max) {
    process.stderr.write(`[skill-preflight-gate] FAIL-OPEN after ${prev.denies} denials without progress (missing: ${missing.join(', ')}) on ${rel}\n`);
    return;
  }
  gate.sessions[sid] = { denies, skills_at_last_deny: used.size, updated_at: new Date().toISOString() };
  const ids = Object.keys(gate.sessions);
  if (ids.length > 50) {
    const trimmed = {};
    for (const id of ids.slice(-50)) trimmed[id] = gate.sessions[id];
    gate.sessions = trimmed;
  }
  saveJson(gatePath, gate);

  const hints = cfg.skillHints || {};
  const lines = [
    'STOP: pre-write gate (a mechanical check, not a reminder).',
    `You are about to write ${rel} without loading the required skills in this session.`,
    '',
    `Missing: ${missing.join(', ')}`,
    ...missing.filter((m) => hints[m]).map((m) => `  - ${m}: ${hints[m]}`),
    ...messages,
    '',
    'Invoke the missing skills with the Skill tool, then retry the same edit.',
  ];
  deny('skill-preflight-gate', lines.join('\n'));
}

try {
  main();
} catch {
  process.exit(0);
}
process.exit(0);
