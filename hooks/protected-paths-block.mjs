#!/usr/bin/env node
// PreToolUse(Edit|Write|MultiEdit): denies writes to protected paths unless an approval file
// (path or glob, from config) carries approved_by, a recent approved_at (TTL in days) and a
// `paths` list of globs that covers the file being written.
// FAIL-CLOSED: a broken config or an unexpected error denies the edit instead of letting it through.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { readStdin, loadConfig, relPath, matchAny, globToRegex, deny, projectDir, EDIT_TOOLS } from './lib.mjs';

// Minimal front matter reader: `key: value` lines and lists written as "- item" or [a, b].
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    if (val === '') {
      const items = [];
      while (i + 1 < lines.length && /^\s+-\s*/.test(lines[i + 1])) {
        i++;
        items.push(lines[i].replace(/^\s+-\s*/, '').trim().replace(/^['"]|['"]$/g, ''));
      }
      meta[key] = items;
    } else if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    } else {
      meta[key] = val.replace(/^['"]|['"]$/g, '');
    }
  }
  return meta;
}

// Expand a path or glob (relative to the project) into candidate files.
function expandApprovalFiles(pattern) {
  const root = projectDir();
  if (!/[*?]/.test(pattern)) return [resolve(root, pattern)];
  const fixed = [];
  for (const seg of pattern.split('/')) { if (/[*?]/.test(seg)) break; fixed.push(seg); }
  const base = resolve(root, fixed.join('/'));
  const re = globToRegex(pattern);
  const out = [];
  const walk = (d, depth) => {
    if (depth > 6) return;
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = resolve(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (re.test(relative(root, p).replace(/\\/g, '/'))) out.push(p);
    }
  };
  walk(base, 0);
  return out;
}

function checkApprovals(cfg, rel) {
  const ttlDays = Number.isFinite(cfg.ttlDays) ? cfg.ttlDays : 14;
  const approvers = Array.isArray(cfg.approvers) && cfg.approvers.length ? cfg.approvers : null;
  const files = expandApprovalFiles(cfg.approvalFile || '').filter((f) => {
    try { return statSync(f).isFile(); } catch { return false; }
  });
  if (files.length === 0) return { ok: false, note: `no approval file found for "${cfg.approvalFile}"` };
  const notes = [];
  for (const f of files) {
    const name = relative(projectDir(), f).replace(/\\/g, '/');
    let meta;
    try { meta = parseFrontmatter(readFileSync(f, 'utf-8')); } catch { notes.push(`${name}: unreadable`); continue; }
    if (!meta || !meta.approved_by) { notes.push(`${name}: missing approved_by`); continue; }
    if (approvers && !approvers.includes(meta.approved_by)) { notes.push(`${name}: approved_by "${meta.approved_by}" is not in the approvers list`); continue; }
    const at = new Date(String(meta.approved_at || ''));
    if (!meta.approved_at || isNaN(at.getTime())) { notes.push(`${name}: approved_at missing or invalid`); continue; }
    const age = (Date.now() - at.getTime()) / 86400000;
    if (age > ttlDays) { notes.push(`${name}: expired (approved ${at.toISOString().slice(0, 10)}, ${Math.floor(age)}d > TTL ${ttlDays}d)`); continue; }
    const paths = Array.isArray(meta.paths) ? meta.paths : [];
    if (paths.length === 0) { notes.push(`${name}: no "paths" list (an approval must name what it unlocks)`); continue; }
    if (matchAny(rel, paths)) return { ok: true, note: `${name} (approved by ${meta.approved_by}, ${Math.floor(age)}d old)` };
    notes.push(`${name}: valid, but "paths" does not cover this file`);
  }
  return { ok: false, note: notes.join('; ') };
}

function failClosed(msg) {
  deny('protected-paths-block', `Hook error (fail-closed): ${msg}. Fix the hook or the config before editing files that may be protected.`);
}

try {
  const input = readStdin();
  if (input && EDIT_TOOLS.includes(input.tool_name) && input.tool_input && input.tool_input.file_path) {
    const { config, error } = loadConfig();
    if (error) failClosed(error);
    const cfg = config && config.protectedPaths;
    if (cfg && cfg.enabled !== false && Array.isArray(cfg.patterns)) {
      const rel = relPath(input.tool_input.file_path);
      if (rel && matchAny(rel, cfg.patterns) && !matchAny(rel, cfg.allow)) {
        const res = checkApprovals(cfg, rel);
        if (res.ok) {
          process.stderr.write(`[protected-paths-block] ALLOW ${rel}: ${res.note}\n`);
        } else {
          deny('protected-paths-block', [
            `Protected path: ${rel}`,
            '',
            `Writing here needs an approval file ("${cfg.approvalFile}") with front matter:`,
            `  approved_by, approved_at (within ${Number.isFinite(cfg.ttlDays) ? cfg.ttlDays : 14} days), paths (globs this approval unlocks).`,
            `State: ${res.note}`,
            '',
            'Ask the owner for the approval instead of working around the gate.',
          ].join('\n'));
        }
      }
    }
  }
} catch (e) {
  failClosed(e && e.message ? e.message : String(e));
}
process.exit(0);
