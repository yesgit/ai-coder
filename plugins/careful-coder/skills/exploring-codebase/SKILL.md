---
name: exploring-codebase
description: Trace a requested behavior through an unfamiliar codebase before changing it. Use for bug fixes, feature work, routing, configuration, integrations, regressions, or whenever a config/constant may not be the runtime implementation.
---

# Explore the Codebase

Trace from observable behavior to the code that produces it. Do not stop at a symbol definition or configuration table.

1. Confirm every code read comes from the user-authorized baseline, then find the runtime entry point: event, API, route, command, or component that users actually trigger. If the current working tree is explicitly excluded, use `git show <ref>:<path>` or an isolated worktree instead of Read on the current file.
2. Follow callers and consumers until you can name the execution path, guards, parameters, side effects, and final target.
3. Search for analogous working behavior and compare the whole path, not just identifiers.
4. Record evidence as `file → role → observed behavior`; label gaps as unknown rather than filling them with guesswork.
5. Change the smallest causal point(s). If the request needs multiple layers—metadata, resolver, navigation, component registration, guards—verify each layer has a consumer.

Represent the result as a causal path: `trigger → consumer/processing → guards and state → side effects → observable result`, with a source for every non-obvious claim. For non-runtime artifacts, use the equivalent production path from authoring input to consumed output.

Before declaring the investigation sufficient, answer: “What invokes this code at runtime, and what proves the requested outcome happens after invocation?”
