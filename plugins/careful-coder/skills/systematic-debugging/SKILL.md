---
name: systematic-debugging
description: Diagnose a bug, failing test, unexpected runtime behavior, or unknown root cause before changing code. Use when the reported symptom is not already explained by direct evidence.
---

# Systematic Debugging

Do not patch the first plausible cause. Maintain a small hypothesis ledger:

| Hypothesis | Supporting evidence | Disproving observation | Next discriminating check | State |
|---|---|---|---|---|
| H1 | observed fact | concrete result | one check | open/rejected/supported |

1. Record the exact symptom, input, environment, boundary, and expected behavior.
2. Trace the execution path from the input or entry point to the first point where actual and expected state diverge.
3. Form the smallest falsifiable hypothesis. Do not use “something is wrong with X.”
4. Run the cheapest check that distinguishes competing hypotheses. Record the actual result.
5. Treat every surprise as new evidence: update or reject the hypothesis before running another command. Never repeat an unchanged failed attempt.
6. Change code only when one hypothesis is supported and explains the complete observed sequence.
7. When practical, capture a regression test that fails before the fix. After editing, verify the original failure, the causal mechanism, and the closest related behavior.

If the failure is intermittent, record frequency and control variables; do not call one passing run a fix. If it cannot be reproduced or a critical input is missing, report the bounded uncertainty and evidence collected instead of guessing.
