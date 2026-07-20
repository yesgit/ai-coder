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

## Chinese and mixed naming

When requirements use Chinese business terms, or the repository contains pinyin or abbreviations, read [chinese-naming-discovery.md](references/chinese-naming-discovery.md). Build a small alias map before declaring a symbol, route, file, or caller absent. Use aliases to widen discovery only; observed runtime evidence decides meaning.

Represent the result as a causal path: `trigger → consumer/processing → guards and state → side effects → observable result`, with a source for every non-obvious claim. For non-runtime artifacts, use the equivalent production path from authoring input to consumed output.

Before declaring the investigation sufficient, answer: “What invokes this code at runtime, and what proves the requested outcome happens after invocation?”

## 附件边界

- 需求来源只能是宿主”精确附件清单”中明确列出的路径。
- 不得自行发现并假设项目内的图片、文档、配置文件为需求来源。
- 如果附件清单中的文件 Read 返回空内容，这是 blocking_unknown——不要搜索替代文件。
- 附件路径中包含 UUID 目录名——不得猜测、缩写、补写页码或修改路径的任何部分。
