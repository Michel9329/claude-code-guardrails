#!/usr/bin/env node
// PreToolUse(Edit|Write|MultiEdit): text rules per path.
// Each rule in config "textRules" has: paths, exclude, extensions, deny[], warn[], presets[].
// A deny pattern blocks the write; a warn pattern prints a warning and exits 1 (non-blocking).
// Only the NEW text being written is checked, never what is already in the file.
// Fails open on error.
import { readStdin, loadConfig, relPath, matchAny, newContent, deny, EDIT_TOOLS } from './lib.mjs';

// Optional presets. Opt in with "presets": ["google-fonts-cdn", ...] on a rule.
const PRESETS = {
  'google-fonts-cdn': {
    deny: [{
      pattern: 'fonts\\.googleapis\\.com|fonts\\.gstatic\\.com',
      flags: 'i',
      message: 'Google Fonts loaded from the CDN is not allowed (GDPR: LG Muenchen, Jan 2022). Self-host the fonts or use a package such as Fontsource.',
    }],
  },
  'em-dash': {
    warn: [{
      pattern: '\\u2014',
      message: 'Em-dash found. Use commas, colons or full stops in this kind of text.',
    }],
  },
  // Italian: apostrophe typed in place of the accent (perche', piu', e' ...).
  'italian-apostrophe-accent': {
    deny: [{
      pattern: "\\b(?:perche|piu|gia|cosi|puo|nonche|poiche|percio|cioe|laggiu|lassu|verita|citta|attivita|realta|novita|qualita|quantita|societa)'|(?:^|[\\s(>])[eE]'(?=[\\s,.;:!?)])",
      flags: 'm',
      message: 'Apostrophe used instead of the accent. Write the accented letter (è, più, perché, già, così, può).',
    }],
  },
};

function compile(item) {
  try { return { re: new RegExp(item.pattern, item.flags || ''), message: item.message || `matches /${item.pattern}/` }; } catch { return null; }
}

function main() {
  const input = readStdin();
  if (!input || !EDIT_TOOLS.includes(input.tool_name)) return;
  const filePath = input.tool_input && input.tool_input.file_path;
  if (!filePath) return;
  const { config } = loadConfig();
  const rules = config && config.textRules;
  if (!Array.isArray(rules)) return;
  const rel = relPath(filePath);
  if (!rel) return;
  const content = newContent(input);
  if (!content) return;

  const warnings = [];
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    if (!matchAny(rel, rule.paths) || matchAny(rel, rule.exclude)) continue;
    if (Array.isArray(rule.extensions) && rule.extensions.length) {
      const ext = (rel.match(/\.([^./]+)$/) || [])[1];
      if (!ext || !rule.extensions.map((e) => e.replace(/^\./, '').toLowerCase()).includes(ext.toLowerCase())) continue;
    }
    const denies = [];
    const warns = [];
    for (const name of rule.presets || []) {
      const p = PRESETS[name];
      if (p) { denies.push(...(p.deny || [])); warns.push(...(p.warn || [])); }
    }
    denies.push(...(rule.deny || []));
    warns.push(...(rule.warn || []));

    for (const d of denies) {
      const c = compile(d);
      const hit = c && content.match(c.re);
      if (hit) {
        deny('deliverable-text-gate', `Text rule${rule.name ? ` "${rule.name}"` : ''} blocked this write to ${rel}\nFound: "${String(hit[0]).trim().slice(0, 60)}"\n${c.message}\nFix the new text and retry. Only the text being written is checked.`);
      }
    }
    for (const w of warns) {
      const c = compile(w);
      if (c && c.re.test(content)) warnings.push(`${rel}: ${c.message}`);
    }
  }
  if (warnings.length) {
    process.stderr.write(`[deliverable-text-gate] WARNING\n${warnings.join('\n')}\n`);
    process.exit(1);
  }
}

try {
  main();
} catch (e) {
  process.stderr.write(`[deliverable-text-gate] error (fail-open): ${e && e.message ? e.message : e}\n`);
}
process.exit(0);
