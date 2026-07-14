---
name: preserving-existing-behavior
description: Modify existing code, public APIs, routes, state transitions, configuration, or shared utilities without breaking established behavior. Use before changing code whose callers, inputs, side effects, guards, or compatibility contract may matter.
---

# Preserve Existing Behavior

Before editing:

1. Read the target implementation and its direct callers or closest working analogue.
2. Identify the behavior that must remain: inputs, outputs, guards, side effects, ordering, error handling, and compatibility assumptions.
3. Mark critical unknowns. Investigate them before changing code.

While editing:

- Make the smallest change that satisfies the user goal.
- Do not refactor, rename, or normalize unrelated code.
- If another file becomes necessary, explain the causal link to the requested behavior.

After editing:

1. Inspect the diff for unintended scope expansion.
2. Verify the new behavior.
3. Verify the most relevant preserved behavior or caller contract.
