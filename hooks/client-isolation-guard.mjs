#!/usr/bin/env node
// PreToolUse(Edit|Write|MultiEdit): project isolation. Stops content from one project leaking into
// another. Config "projectIsolation.projects" is a list of { id, root, guard[], tokens[] }:
//   root    folder of the project, relative to the repo (e.g. "clients/acme")
//   guard   globs relative to root that are checked (default: everything under root)
//   tokens  strings that identify the project (names, domains, brand colours), case-insensitive
// A write inside project A is denied if its new text contains a token of project B.
// Fails open on error.
import { readStdin, loadConfig, relPath, matchAny, newContent, deny, EDIT_TOOLS } from './lib.mjs';

try {
  const input = readStdin();
  if (input && EDIT_TOOLS.includes(input.tool_name) && input.tool_input && input.tool_input.file_path) {
    const { config } = loadConfig();
    const cfg = config && config.projectIsolation;
    if (cfg && cfg.enabled !== false && Array.isArray(cfg.projects)) {
      const rel = relPath(input.tool_input.file_path);
      if (rel) {
        const relLower = rel.toLowerCase();
        const owner = cfg.projects.find((p) => {
          const root = String(p.root || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
          if (!root || !(relLower === root || relLower.startsWith(root + '/'))) return false;
          const inner = rel.slice(root.length + 1);
          return !Array.isArray(p.guard) || p.guard.length === 0 || matchAny(inner, p.guard);
        });
        const text = owner ? newContent(input).toLowerCase() : '';
        if (owner && text) {
          const hits = [];
          for (const other of cfg.projects) {
            if (other === owner) continue;
            for (const tok of other.tokens || []) {
              if (text.includes(String(tok).toLowerCase())) hits.push(`"${tok}" (belongs to ${other.id || other.root})`);
            }
          }
          if (hits.length) {
            deny('client-isolation-guard', [
              `Project isolation: ${rel} belongs to "${owner.id || owner.root}" but the new text contains tokens of another project:`,
              ...hits.map((h) => `  - ${h}`),
              '',
              'Reuse patterns and architecture across projects, never names, copy, palette or voice.',
              'If this is a false positive, adjust the tokens in guardrails.config.json.',
            ].join('\n'));
          }
        }
      }
    }
  }
} catch { /* fail open */ }
process.exit(0);
