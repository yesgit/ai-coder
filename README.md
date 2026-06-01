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

## Claude Agent SDK

The first implementation includes an adapter boundary in `src/main/agent/claudeAgentRunner.ts`.
If `ANTHROPIC_API_KEY` is not set, the app runs in deterministic mock mode so the workflow UI,
permissions, gates, and local session recording can be exercised without live model calls.
