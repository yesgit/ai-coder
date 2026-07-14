---
name: verification-before-completion
description: Verify work before claiming a coding task is complete. Use whenever the agent is about to report completion after analysis, debugging, implementation, refactoring, configuration, or test changes.
---

# Verify Before Completion

Treat the original user request and subsequent user answers as the acceptance source. Do not accept an implementation plan or a configuration diff as proof by itself.

1. Restate the observable result that must now hold.
2. Inspect the final diff and confirm every changed file has a causal link to that result.
3. Run the strongest relevant verification available: focused test, build, lint, static check, or reproducible manual check.
4. Check the command result, not merely that a command was invoked. A swallowed failure is not evidence.
5. Check the closest regression risk introduced by the change.

Report one of:

- verified complete, with evidence;
- implemented but not verified, with the missing check and reason;
- incomplete or blocked, with the unmet requirement.

Never use "complete" for the latter two cases.
