---
name: preserving-existing-behavior
description: Modify existing code, public APIs, routes, state transitions, configuration, or shared utilities without breaking established behavior. Use before changing code whose callers, inputs, side effects, guards, or compatibility contract may matter.
---

# Preserve Existing Behavior

Before editing, produce a behavior contract with evidence:

| Contract item | Current behavior | Evidence | Change |
|---|---|---|---|
| precondition/postcondition/invariant | exact observable semantics | path:line or test | preserve/change |

Cover all applicable dimensions:

- accepted and rejected inputs, requiredness, defaults, coercion, and validation;
- outputs, mutations, events, side effects, and externally visible timing;
- guards, authorization, early returns, error type/message/retry semantics;
- idempotency, ordering, concurrency, cancellation, and partial-failure behavior;
- direct callers, shared wrappers, persisted formats, and compatibility assumptions.

Use `investigating-call-contracts` when a function or component contract is involved. Mark unresolved dynamic callers or runtime behavior `unknown`; a correctness-affecting unknown blocks editing.

While editing:

- Make the smallest change that satisfies the user goal.
- Do not refactor, rename, or normalize unrelated code.
- Preserve mixed pinyin, initials, English, and historical misspellings when they participate in routes, APIs, storage, events, native bridges, reflection, or other compatibility contracts.
- Treat a “cleaner” name as a contract change unless all consumers and migration behavior are proven.
- If another file becomes necessary, explain the causal link to the requested behavior.

After editing:

1. Inspect the diff for unintended scope expansion.
2. Create a compatibility matrix: each changed contract item × representative old/new input × expected outcome.
3. Verify the new behavior and the closest preserved success, rejection, and failure paths.
4. Explain every intentional contract change by requirement ID. An unexplained difference is a regression, not cleanup.
