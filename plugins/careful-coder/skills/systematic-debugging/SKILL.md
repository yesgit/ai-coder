---
name: systematic-debugging
description: Diagnose a bug, failing test, unexpected runtime behavior, or unknown root cause before changing code. Use when the reported symptom is not already explained by direct evidence.
---

# Systematic Debugging

Do not patch the first plausible cause.

1. Reproduce or locate the observable failure. Record the exact symptom and boundary.
2. Trace the execution path from the input or entry point to the failing behavior.
3. Form a small, falsifiable hypothesis. State what observation would disprove it.
4. Run the cheapest discriminating check. Update the hypothesis from the result.
5. Change code only after the root cause is supported by evidence.
6. Verify both that the original failure is fixed and that the closest related behavior still works.

If the failure cannot be reproduced or a critical input is missing, report that uncertainty instead of guessing.
