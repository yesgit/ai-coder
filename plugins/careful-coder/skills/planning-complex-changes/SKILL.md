---
name: planning-complex-changes
description: Plan a change that spans multiple modules, has multiple viable designs, affects data or public contracts, or cannot be safely implemented from one local code reading. Do not use for a small, obvious, low-risk edit.
---

# Plan a Complex Change

First establish the user-visible result and the existing behavior that must survive.

Create a short plan with only the steps needed to reach that result. For each step, include:

- the behavior it changes;
- the files or symbols expected to be involved;
- dependencies or risks;
- how the result will be verified.

Prefer a plan organized by observable behavior, not by file or configuration entry. If a key design choice remains uncertain, investigate or ask before implementation. Do not turn a simple task into a ceremonial plan.
