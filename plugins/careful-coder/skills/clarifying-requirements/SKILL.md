---
name: clarifying-requirements
description: Preserve the user's actual outcome before planning, debugging, or coding. Use when a request may be confused with an implementation hint, has material ambiguity, affects existing behavior, or crosses multiple components.
---

# Clarifying Requirements

The user's observable outcome is the contract. Existing plans, configuration names, and earlier agent summaries are evidence, not replacement requirements.

Before planning, produce a requirement contract. Keep it in the task tree or working notes so later steps can cite stable IDs:

| ID | Observable result | Source | Verification oracle | Status |
|---|---|---|---|---|
| R1 | What a user or caller can observe | request/answer/spec location | test, command, or manual observation | confirmed/assumed/blocked |

The contract must also name:

- `preserved_behaviors`: behavior explicitly or implicitly required to remain;
- `out_of_scope`: nearby work that must not be absorbed;
- `blocking_unknowns`: unknowns whose answers would change behavior, safety, or acceptance;
- `assumptions`: reversible defaults, their evidence, and how they will be verified.

Rules:

1. State each requested user-visible result separately. Do not combine multiple obligations into “support the feature.”
2. Separate outcomes from proposed mechanisms. “Add navigation” is not the same as “add route metadata.”
3. Give every requirement an independent observable oracle. “Code changed” and “configuration exists” are not oracles unless that is itself the requested result.
4. Treat user answers as binding and update the same requirement IDs. Never silently narrow “all”, a range, or an earlier answer.
5. Map every implementation task to one or more requirement IDs. A task with no requirement link is scope expansion.
6. Ask a question only when the answer would materially change the implementation, safety, or acceptance criteria. Otherwise make the smallest reversible assumption and label it.

If the user names a branch, revision, snapshot, generated artifact, or other baseline, establish it before using code as evidence. Record the effective baseline with a command result. When the user says to ignore the current working tree, inspect code through that baseline (`git show`, an isolated worktree, or an equivalent immutable source); never cite the ignored tree as evidence.

For an attachment or specification containing a range, table, repeated records, identifiers, or mappings, build a source-of-truth matrix before interpreting implementation. Preserve exact identifiers and duplicates. Each row must include `item/range identity + exact value + source location + confidence`. Resolve missing endpoints, duplicate numbers, parent/child relationships, and count mismatches before planning.

If any attachment listed in the manifest returns empty or unreadable content (e.g., Read returns no text, image cannot be decoded), stop the extraction immediately. Record the failing path as a `blocking_unknown` with the exact path and the reason `"Attachment <path> returned no content — requirements cannot be confirmed"`. Do not substitute with similarly-named files found elsewhere in the project.

## Evidence-before-question gate

Treat a human question as an expensive blocking operation, not as an interview.

Before asking, do all four checks:

1. **Answer check**: reread the original request, attachments, prior human answers, and explicit scope words such as “all”, “only”, “from X onward”, and “ignore”. Never ask the user to repeat them.
2. **Evidence check**: search project rules, neighboring correct implementations, callers, consumers, git state, and naming history. Do not ask for facts the repository can answer.
3. **Impact check**: name the two or more materially different actions that depend on the answer. If the same safe implementation follows either way, do not ask.
4. **Default check**: if a small reversible choice has a convention-backed default, take it and record the assumption. Ask only when a wrong default would create meaningful rework, unsafe behavior, or a different observable result.

When a question is justified:

- Ask for one decision at a time. Do not combine identity, scope, behavior, and confirmation in one text box.
- Prefer 2–3 concrete options when the choice is bounded; recommend the convention-preserving option.
- State only the missing decision and its consequence. Do not paste a requirements recap into the question.
- For destructive actions, ask approval for the exact destructive action and affected paths. Do not re-confirm an already explicit non-destructive instruction.

Reject these patterns:

- Asking for a developer identifier when project rules, branch history, or the current branch already establish it.
- Asking which items are in scope when the user or attachment already says “all” or gives the range.
- Asking how an existing feature is triggered before tracing the adjacent implementation and its runtime consumer.
- Asking for priority when the request requires the whole stated scope and no ordering decision blocks implementation.

Do not plan implementation while a `blocking_unknown` remains unresolved. Before implementation, check: “Would the user recognize every R-ID as working, even if they never saw this diff?” If not, the requirement is not yet represented.

For code behavior, express acceptance as `observable result + source + verification`. Keep implementation guesses out of acceptance criteria until code evidence supports them.
