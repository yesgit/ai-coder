---
name: planning-complex-changes
description: Plan a change that spans multiple modules, has multiple viable designs, affects data or public contracts, or cannot be safely implemented from one local code reading. Do not use for a small, obvious, low-risk edit.
---

# Plan a Complex Change

First establish requirement IDs and the existing behavior that must survive.

Before choosing an implementation, build a change-impact map from repository evidence:

| Surface | Current contract | Proposed effect | Evidence | Risk |
|---|---|---|---|---|
| callers/wrappers | arguments and assumptions | preserved/changed | path:line | low/medium/high |

Check at least the applicable surfaces: direct and indirect callers, shared wrappers, public API/types, persisted data and migrations, state transitions, events/jobs, configuration/defaults, permissions, external integrations, concurrency/ordering, and deployment/runtime packaging. Mark an applicable but unresolved surface `unknown`; do not omit it.

Create a short plan organized by observable behavior. Each step must include:

- linked requirement IDs and preserved invariants;
- symbols/files and why each is causally required;
- dependencies and failure modes;
- verification oracle, including a negative or regression path where relevant;
- migration, rollout, and rollback action when contracts or stored state can outlive one process.

No high-risk or `unknown` impact may be hidden inside an implementation step. Investigate it, split a reversible seam, or obtain the missing decision first. Do not turn a simple task into a ceremonial plan.
