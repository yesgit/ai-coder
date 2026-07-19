---
name: verification-before-completion
description: Verify work before claiming a coding task is complete. Use whenever the agent is about to report completion after analysis, debugging, implementation, refactoring, configuration, or test changes.
---

# Verify Before Completion

Treat the requirement contract and subsequent user answers as the acceptance source. Do not accept an implementation plan, a configuration diff, or a command invocation as proof by itself.

Build a verification matrix before claiming completion:

| Requirement/invariant | Representative condition | Expected oracle | Evidence | Result |
|---|---|---|---|---|
| R1 or I1 | success/failure/boundary combination | independently observable result | command + key output | pass/fail/not run |

1. Include every requirement ID and every intentionally preserved invariant.
2. Cover the changed success path, closest failure/rejection path, boundary/default case, and affected caller or parameter combinations. Risk, not test count, determines breadth.
3. Prefer an independent oracle: assert public output or state, not the same helper implementation used by the change.
4. When practical, prove the regression test fails against pre-fix behavior and passes after the fix.
5. Inspect the final diff and confirm every changed file has a causal link to a requirement.
6. Run the strongest relevant focused tests, then the broader build/type/static checks required by the affected surface.
7. Read exit codes and key output. Detect skipped tests, swallowed failures, stale artifacts, wrong architecture, and commands that exercised a different path.
8. Record checks that could not run and the residual risk they leave. A clean unrelated test is not substitute evidence.

Report one of:

- verified complete, with the matrix evidence;
- implemented but not verified, with the missing check and reason;
- incomplete or blocked, with the unmet requirement.

Never use "complete" for the latter two cases.
