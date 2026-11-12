# claude-code-guardrails

[![test](https://github.com/Michel9329/claude-code-guardrails/actions/workflows/test.yml/badge.svg)](https://github.com/Michel9329/claude-code-guardrails/actions/workflows/test.yml)

Hooks for [Claude Code](https://docs.claude.com/en/docs/claude-code) that enforce project rules mechanically.

Built with Claude Code, designed and reviewed by Michel Dimitri.

A rule written in `CLAUDE.md` is an instruction. The model can forget it, misread it, or decide this case is an exception. A hook that denies the tool call cannot be forgotten: the edit does not happen until the condition is met.

This package collects the hooks I use in my own workspace, with the project-specific parts moved into one config file. They were built with Claude Code, from rules I wrote down after things went wrong (a client document produced without loading the writing method, a file overwritten by a parallel session, a Google font loaded from Google's servers, which a Munich court ruled a GDPR breach in 2022). The origin is Sharkcode, a small web studio in Italy.

## The principle

Three kinds of rule, three kinds of hook:

- **Forbid**: deny a tool call that breaks a rule (`protected-paths-block`, `git-discipline-gate`, `deliverable-text-gate`, `client-isolation-guard`).
- **Require**: deny a tool call until the model has done something first, such as loading a skill (`skill-preflight-gate`, `prebuild-ui-reuse-gate`).
- **Remind**: block or warn once at the end of a session (`session-close-guard`).

Every deny carries a reason that tells the model what to do next, so it can fix the problem and retry.

## What is in the box

| Hook | Event and matcher | What it does | Config key |
|---|---|---|---|
| `skill-preflight-gate` + `skill-usage-track` | PreToolUse `Edit\|Write\|MultiEdit`, PostToolUse `Skill` | Denies writes to matching paths until the required skills were invoked in this session. Counts denials and fails open after N with no progress. | `skillGate` |
| `protected-paths-block` | PreToolUse `Edit\|Write\|MultiEdit` | Denies writes to protected paths unless an approval file has `approved_by`, a recent `approved_at` (TTL) and a `paths` list covering the file. Fail-closed. | `protectedPaths` |
| `git-discipline-gate` | PreToolUse `Bash` | Denies `git commit --amend`, `git commit` without `-- <pathspec>`, and recursive forced `rm`. | `git` |
| `deliverable-text-gate` | PreToolUse `Edit\|Write\|MultiEdit` | Per-path text rules: regexes that deny, regexes that warn. Optional presets: Google Fonts CDN (deny), em-dash (warn), Italian apostrophe-for-accent (deny). | `textRules` |
| `session-close-guard` | Stop, PreCompact | If a status file is stale but the session left real work (dirty tree or recent commit), blocks once on Stop, warns on PreCompact. | `sessionClose` |
| `prebuild-ui-reuse-gate` | PreToolUse `Edit\|Write\|MultiEdit` | Denies the first matching write of a session with a "look for an existing implementation first" checklist. The retry passes. | `firstEditChecklist` |
| `client-isolation-guard` | PreToolUse `Edit\|Write\|MultiEdit` | Denies a write inside project A whose text contains a token that belongs to project B. | `projectIsolation` |

Nothing project-specific is in the code. Every path, skill name, pattern, TTL and message comes from `guardrails.config.json`. A hook whose section is missing does nothing.

## Requirements

Node 20 or newer. No npm dependencies, no Bun.

## Install

1. Copy the `hooks/` folder into your project as `.claude/hooks/guardrails/`.
2. Copy `guardrails.config.example.json` to `guardrails.config.json` in the project root and edit it. Keep only the sections you want.
3. Merge the `hooks` block from `settings.example.json` into `.claude/settings.json`. Drop the entries for hooks you do not use.
4. Add the state files to `.gitignore` (`.claude/skill-usage-state.json`, `.claude/skill-preflight-state.json`, `.claude/first-edit-checklist-state.json`).
5. Run `node test/smoke.mjs` from this repo to check that the hooks run with your Node version.

The config is found in this order: `$GUARDRAILS_CONFIG`, `<project>/guardrails.config.json`, `<project>/.claude/guardrails.config.json`. The project is `$CLAUDE_PROJECT_DIR`, or the current directory if that is not set. The config accepts `//` and `/* */` comments.

## Configure

Paths are globs relative to the project root: `**` crosses folders, `*` stays in one folder, `?` is one character, `{a,b}` is a choice. Matching ignores case.

### A skill gate

```json
"skillGate": {
  "maxDeniesWithoutProgress": 3,
  "rules": [
    { "paths": ["content/**/*.md"], "requireSkills": ["writing-method"] },
    { "paths": ["src/**/*.tsx"], "requireAnyOf": ["design-a", "design-b"] }
  ]
}
```

The first write to `content/about.md` in a session is denied with the list of missing skills. The model invokes `writing-method` through the Skill tool, `skill-usage-track` records it, and the retry passes. If the model keeps failing without loading anything new, the fourth attempt goes through with a warning on stderr. The gate is there to steer, not to freeze the session.

### Protected paths with an approval file

```json
"protectedPaths": {
  "patterns": ["templates/**"],
  "approvalFile": ".guardrails/APPROVAL.md",
  "ttlDays": 14,
  "approvers": ["Your Name"]
}
```

`approvalFile` can be a glob, for example `.planning/phases/*/APPROVAL.md`. Every match is checked and any valid one unlocks. The file starts with front matter:

```
---
approved_by: Your Name
approved_at: 2026-11-06
paths:
  - templates/brand/**
---
```

An approval that is expired, signed by someone not in `approvers`, or missing a `paths` list unlocks nothing. If the config cannot be parsed, every edit that reaches this hook is denied.

### Text rules

```json
"textRules": [
  {
    "paths": ["clients/**"],
    "extensions": ["md", "html"],
    "presets": ["google-fonts-cdn", "em-dash"],
    "deny": [{ "pattern": "\\bTODO_REPLACE\\b", "message": "Placeholder left in a deliverable." }]
  }
]
```

Only the new text of the edit is checked, not the rest of the file.

## Example session

With the skill gate above, the model tries to write `content/about.md`:

```
[skill-preflight-gate] STOP: pre-write gate (a mechanical check, not a reminder).
You are about to write content/about.md without loading the required skills in this session.

Missing: writing-method

Invoke the missing skills with the Skill tool, then retry the same edit.
```

The tool call is not executed. The model loads the skill and retries, and the write goes through.

## Limits

- **Edit and Write hooks do not see writes made through Bash.** `echo text > file`, `sed -i`, `cp`, a Python script that writes files: none of these pass through the file-editing gates. These hooks are a checkpoint for a model that forgets, not a sandbox against a model that works around them. If you need a hard boundary, use file permissions, `permissions.deny` in your settings, or run in a container.
- **The Bash gate reads the command text.** It ignores quoted strings and splits on `&&`, `||`, `;` and `|`. It does not expand variables, aliases or subshells, so `eval "$X"` or a script that calls `rm -rf` inside is invisible to it.
- **Warnings go to the user, not to the model.** A `warn` rule exits with code 1, which Claude Code shows as a non-blocking error. The model does not read it. Use `deny` when the model must act on it.
- **Skill tracking trusts the Skill tool.** A skill counts as used once the Skill tool was called with its name. The hook cannot tell whether the model followed it.
- **Subagents are skipped by default** by the skill gate, because their transcripts live in a separate path and the parent session usually governs them. Set `skipSubagents` to `false` to include them.
- **State is local.** Session records are JSON files in `stateDir`. They rotate at 50 sessions.
- **Tested on Windows (Node 24) and in CI on Ubuntu (Node 20).** The smoke test sends each hook a PreToolUse-style JSON and checks the exit code. It does not run Claude Code itself. Matcher names and payload fields follow the Claude Code hooks documentation at the time of writing, so check them against your version.
- The Italian apostrophe preset uses a short word list. It misses accents it does not know and can flag a few legitimate forms.

## Tests

```
npm run check   # node --check on every file
npm test        # node test/smoke.mjs
```

The smoke test creates a temporary project, writes a config, and covers at least one allow and one deny per hook, plus the fail-open and fail-closed paths.

## License

MIT. Copyright (c) 2026 Michel Dimitri.

---

More tools from the same system: [github.com/Michel9329](https://github.com/Michel9329).
