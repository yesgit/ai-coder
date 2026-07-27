---
name: investigating-call-contracts
description: Investigate the complete call contract of an existing function, method, shared wrapper, or UI component before changing it. Use when a task changes a symbol's parameters, props, return value, defaults, guards, side effects, compatibility behavior, or any implementation with multiple callers. Covers all static call sites, public wrappers, argument combinations, local preconditions, input/output definitions, and unresolved dynamic references.
---

# Investigate Call Contracts

Build an evidence-backed usage model before editing an existing callable. Treat tool output as facts and interpretation as claims.

## Required workflow

1. Resolve one exact target file and symbol. If the symbol is ambiguous, pass `target_line` to identify its definition before investigating.
   - When the target came from a Chinese business term or mixed pinyin/abbreviation, first apply the alias-discovery rules in [chinese-naming-discovery.md](../exploring-codebase/references/chinese-naming-discovery.md). Record ambiguous matches instead of silently choosing one.
2. Call `mcp__ai_coder__investigate_symbol_contract` once for the exact target. This host-owned script automatically consumes `contract`, `calls`, `wrappers`, and `references` in full, including every pagination offset, and recursively investigates public wrappers. `Read`, `Grep`, `Bash`, prose claims, or piecemeal `analyze_symbol_contract` calls do not satisfy this prerequisite. Record every input, prop and output from the report:
   - meaning and type;
   - required or optional;
   - declaration default and destructuring default;
   - return type or component output.
3. Check the report before interpretation:
   - `all_pages_consumed` must be `true`;
   - all four entries in `sections_completed` must be present;
   - `wrapper_graph.complete` must be `true`;
   - a `partial` report is not a completed investigation;
   - every item in `unresolved_dynamic_references` must be followed or explicitly retained as an unresolved boundary.
4. For every reported call site, inspect the cited source around the call. Confirm:
   - exact argument or prop values and omitted values;
   - local guards, earlier returns, route/state/permission prerequisites;
   - caller-specific assumptions not visible to the static analyzer.
5. For every exported/public wrapper in the report and recursive `wrapper_graph`, trace how each wrapper parameter is transformed, defaulted, dropped, merged, or forwarded to the target. Count distinct parameter-presence combinations separately from distinct runtime values.
6. Investigate every callback, assignment, registration, re-export, dependency-injection, event, or other non-call reference until its runtime invocation is found or recorded as unresolved.
7. Read the target implementation. Confirm guards, defaults implemented inside the body, state reads/writes, side effects, error behavior, ordering constraints, and output consumers.
8. Compare the proposed change against every observed combination and unresolved reference. Expand verification when a dynamic edge or business prerequisite remains uncertain.

## Evidence rules

- Cite `path:line` for each caller, wrapper, precondition, default, and contract claim.
- Keep static facts, inferred business meaning, and unknowns distinct.
- Never infer runtime completeness from text search alone.
- Never treat an omitted argument as equivalent to `undefined`, `null`, an empty value, or a declared default without reading the implementation.
- Never collapse calls merely because they have the same number of arguments; group by parameter presence and behaviorally relevant values.
- Treat spread props/arguments, callbacks, reflective lookup, event registration, dependency injection, and external consumers as incomplete until followed.
- Treat zero discovered callers as a finding to investigate, not proof that the symbol is unused.
- Before accepting zero callers or references, search observed Chinese, pinyin, initial, mixed, English, case, separator, route-key, and dynamically composed aliases. Alias matches still require runtime evidence.

## Investigation result

Do not emit a large schema merely to satisfy formatting. Produce a concise decision artifact containing:

- target contract and defaults;
- complete caller inventory with pagination evidence;
- distinct argument/prop combinations;
- public wrapper mappings;
- caller preconditions and business assumptions;
- indirect or unresolved invocation paths;
- compatibility obligations for the proposed change;
- focused verification cases derived from observed combinations.

The investigation is complete only when every tool-reported call/reference is accounted for, or each remaining gap is explicitly marked as a blocking or residual unknown.

## Framework boundaries

Read [static-analysis-boundaries.md](references/static-analysis-boundaries.md) when the target uses React composition, callbacks, events, dependency injection, reflection, generated code, or cross-package consumers.
