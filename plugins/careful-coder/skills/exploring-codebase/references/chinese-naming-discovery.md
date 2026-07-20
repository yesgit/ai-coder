# Chinese Codebase Naming Discovery

Domestic projects often preserve several naming eras at once. For each important Chinese business term, search a focused alias matrix:

- the Chinese text in comments, labels, logs, requirements, commits, and tests;
- full pinyin, pinyin initials, and mixed full-pinyin/initial forms;
- established English translations and common domain abbreviations;
- camelCase, PascalCase, snake_case, kebab-case, lowercase, and uppercase variants;
- nearby repository-specific aliases, historical spellings, typos, route keys, API fields, storage keys, and analytics events;
- common layer/type suffixes such as `Controller`, `Service`, `ServiceImpl`, `Mapper`, `DAO`, `DTO`, `VO`, `BO`, `PO`, `Req`, `Resp`, `Util`, `Page`, `View`, `Handler`, `Config`, and `Const`.

For example, “修改交易密码” may appear as `modifyTradePassword`, `xgJymm`, `xgJiaoyiPwd`, `JYPassword`, or a route string unrelated to the component name. These are search hypotheses, not equivalent meanings.

Use this workflow:

1. Extract domain words and observed aliases from the requirement, adjacent code, route/config tables, API schemas, Chinese commit messages, and analogous working flows.
2. Record `business term → observed alias → evidence`. Generate only plausible missing variants; do not create a combinatorial search flood.
3. Search exact runtime strings and observed repository conventions first, then pinyin/initial/mixed/English and case/separator variants.
4. Follow every candidate to its definition, callers, consumers, guards, and observable result. Reject false positives explicitly.
5. If an abbreviation is ambiguous, keep it unknown until context proves its meaning. For example, `yh` may mean 用户、银行、优惠, or something project-specific.

Guardrails:

- Never rename, “correct,” or normalize mixed pinyin, abbreviations, or historical typos merely for style.
- Treat public route names, API fields, persisted keys, event names, native bridges, and dynamically composed strings as compatibility contracts.
- Repository evidence outranks textbook pinyin or a preferred English translation.
- A failed exact-name search does not prove absence; a name match does not prove runtime use.
- Prefer a compact alias map over an automatic transliteration script: word segmentation, initials, polyphonic characters, and team-specific abbreviations make exhaustive generation noisy and unsafe.
