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

## Claude Agent SDK

The first implementation includes an adapter boundary in `src/main/agent/claudeAgentRunner.ts`.
The app does not store Anthropic API keys. It reuses Claude Agent SDK / Claude Code authentication
and settings from the local environment.

Runtime diagnostics report:

- whether the Claude Agent SDK package is available
- whether a `claude` executable is visible on `PATH`
- whether `ANTHROPIC_API_KEY` is present in the process environment

If the SDK is unavailable, the app falls back to deterministic mock mode so the workflow UI,
permissions, gates, and local session recording can be exercised without live model calls.
