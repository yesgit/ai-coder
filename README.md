# AI Coder

Desktop AI coding agent with local, pluggable workflows.

## Development

```bash
npm install
npm run dev
```

## Workflow Loading Order

Workflows are merged by id in this order, where later sources override earlier ones:

1. Built-in workflows from `workflows/*.yaml`
2. User workflows from `~/.ai-coder/workflows/*.yaml`
3. Project workflows from `.ai-coder/workflows/*.yaml`

## Project Onboarding

The built-in `project-onboarding` workflow uses Claude Agent SDK to scan a selected project and
create or update the project root `CLAUDE.md`.

This is the first project profile format. It deliberately uses Claude Code project memory instead
of a separate knowledge database so later stage execution can reuse the same context.

The onboarding workflow requires Claude to:

- check whether `CLAUDE.md` already exists before drafting changes
- preserve valuable existing team rules, architecture notes, commands, and imports
- add a Compact Summary near the top for context compression and task resumption
- keep memory focused, structured, and concrete
- avoid secrets, credentials, generated directories, and long source dumps
- request file-write approval before creating or updating `CLAUDE.md`

After reviewing `CLAUDE.md`, the user can confirm onboarding in the desktop app. Confirmation is
stored locally under `~/.ai-coder/onboarding` and is tied to the current `CLAUDE.md` content hash.
If `CLAUDE.md` changes later, the project returns to pending review.

Development workflows require confirmed onboarding by default. The `project-onboarding` workflow
is always allowed. Users can explicitly override the gate for local experiments; sessions record
the onboarding status, `CLAUDE.md` hash, and override flag at start time.

See `docs/project-onboarding-smoke-test.md` for a manual end-to-end verification flow using
`samples/onboarding-target`.

## Tool Permission Smoke Test

Use `docs/tool-permission-smoke-test.md` with `samples/tool-permission-target` to verify the live
Claude Agent SDK permission loop:

- shell commands pause for user approval
- file edits pause for user approval and record `file_changes`
- paths outside the selected project are blocked
- approved tool calls can continue the session

## Callsite Investigation

JS/TS symbol investigation indexes project-local module relationships before
binding references. It follows renamed/default imports, re-export chains and
JSX uses without requiring callers to contain the original symbol name.
Dependencies needed for binding are included; unrelated importers of a shared
utility are excluded.

Reports include `analyzer_coverage.source_scope` with discovered, required and
selected file counts. The source program is bounded to 500 selected files.
Unreadable sources, unresolved relative/configured-alias imports, file limits,
and indirect-reference depth/state limits are retained in
`static_analysis_limits` and require further verification. A `complete` result
describes the indexed project-local static scope; runtime dispatch and callers
outside the project still require separate evidence.

Each reference card also carries `target_usage`: `execution` identifies a
statically bound execution expression, `value-transfer` identifies passing or
registering a value, and `possible-execution` retains an ambiguous execution
candidate. `certainty`, source evidence and unresolved reasons travel with the
card into semantic review. Const aliases and source-backed callback parameters
are followed; reassignment, mixed callback sources and unknown factory results
remain uncertain. Callback call contexts retain their own arguments and guards.
Candidate relationships are excluded from automatic behavior fingerprints.

## Claude Agent SDK

The first implementation includes an adapter boundary in `src/main/agent/claudeAgentRunner.ts`.
The app does not store Anthropic API keys. It reuses Claude Agent SDK / Claude Code authentication
and settings from the local environment.

Claude SDK sessions load Claude Code `user`, `project`, and `local` settings. If the local
`claude` command is configured to use a supported third-party Claude-compatible provider, AI Coder
will use the same Claude Code configuration when started from an environment that can access it.

Runtime diagnostics report:

- whether the Claude Agent SDK package is available
- whether a `claude` executable is visible on `PATH`
- whether `ANTHROPIC_API_KEY` is present in the process environment

If the SDK is unavailable, the app falls back to deterministic mock mode so the workflow UI,
permissions, gates, and local session recording can be exercised without live model calls.
