// Shared helpers for every guardrails hook. Node 20+, no dependencies.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute } from 'node:path';

export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit'];

export function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

export function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf-8'));
  } catch {
    return null;
  }
}

// JSON with // and /* */ comments allowed (so the example config can be annotated).
export function stripJsonComments(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i++; } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return out;
}

// Returns { config, path, error }. config is null when no file exists (hooks then allow everything).
export function loadConfig() {
  const dir = projectDir();
  const candidates = [
    process.env.GUARDRAILS_CONFIG,
    resolve(dir, 'guardrails.config.json'),
    resolve(dir, '.claude/guardrails.config.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    let raw;
    try { raw = readFileSync(p, 'utf-8'); } catch { continue; }
    try {
      return { config: JSON.parse(stripJsonComments(raw)), path: p, error: null };
    } catch (e) {
      return { config: null, path: p, error: `cannot parse ${p}: ${e.message}` };
    }
  }
  return { config: null, path: null, error: null };
}

// Case-insensitive glob: ** any depth, * within a segment, ? one char, {a,b} alternatives.
export function globToRegex(glob) {
  let re = '';
  let brace = 0;
  const g = String(glob).replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '{') { brace++; re += '(?:'; } else if (c === '}' && brace > 0) { brace--; re += ')'; } else if (c === ',' && brace > 0) re += '|';
    else if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

export function matchAny(rel, globs) {
  return (globs || []).some((g) => globToRegex(g).test(rel));
}

// Path relative to the project, forward slashes. Returns null if outside the project.
export function relPath(filePath) {
  const abs = isAbsolute(filePath) ? filePath : resolve(projectDir(), filePath);
  const rel = relative(projectDir(), abs).replace(/\\/g, '/');
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel;
}

export function newContent(input) {
  const ti = input.tool_input || {};
  if (input.tool_name === 'Write') return String(ti.content ?? '');
  if (input.tool_name === 'Edit') return String(ti.new_string ?? '');
  if (input.tool_name === 'MultiEdit') {
    return (Array.isArray(ti.edits) ? ti.edits : []).map((e) => String(e?.new_string ?? '')).join('\n');
  }
  return '';
}

// Deny a tool call. stdout JSON follows the documented PreToolUse shape; stderr plus exit 2
// is the fallback that Claude Code feeds back to the model.
export function deny(tag, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.stderr.write(`[${tag}] ${reason}\n`);
  process.exit(2);
}

export function loadJson(path, fallback) {
  try {
    const v = JSON.parse(readFileSync(path, 'utf-8'));
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8');
  } catch { /* state is best effort */ }
}

export function stateDir(config) {
  return resolve(projectDir(), (config && config.stateDir) || '.claude');
}

export function isSubagentTranscript(input) {
  return /\/(?:subagents|workflows)\//.test(String(input.transcript_path || '').replace(/\\/g, '/'));
}
