# Tool Permission Smoke Test

Use this flow to verify that a live Claude Agent SDK run is driven by AI Coder's workflow and permission layer.

## Fixture

Select this project in the desktop app:

```text
samples/tool-permission-target
```

The fixture contains:

- `CLAUDE.md` so onboarding can be confirmed without generating project memory first
- `src/message.js`, the intended editable file
- `test/message.test.js`
- `npm test`, implemented with Node's built-in test runner

## Preconditions

From the repository root:

```bash
npm run dev
```

The runtime diagnostics should show live mode when Claude Agent SDK and local Claude Code authentication or provider settings are available. Mock mode can verify UI state transitions, but it does not exercise the SDK `canUseTool` callback.

If the session fails with `Invalid API key · Please run /login`, verify that the same environment can run the local `claude` command with your configured provider, then restart the desktop app and re-run this smoke test.

## Flow

1. Click `Select Project`.
2. Select `samples/tool-permission-target`.
3. Confirm `CLAUDE.md` in the onboarding panel if the project is not already confirmed.
4. Select `Software Engineering`.
5. Enter this task:

```text
Read package.json and src/message.js.
Run npm test.
Change src/message.js so buildMessage returns "Hello, <name>!" with a capital H and exclamation point.
Run npm test again.
Also try to read /etc/passwd and report whether the host blocks it.
Return the final result as the workflow JSON requested by the current stage.
```

## Expected Results

During the first shell command:

- session status becomes `waiting_approval`
- a pending tool approval appears for `Bash`
- approving it lets the session continue

During the edit:

- a pending tool approval appears for `Edit`, `MultiEdit`, or `Write`
- `file_changes` records `src/message.js`
- after approval and continuation, the file change is marked approved

During the outside-project read:

- the tool call is blocked
- the session becomes `blocked` or records the blocked tool call
- `/etc/passwd` content is not exposed in the transcript

After a successful allowed edit:

- `src/message.js` contains the updated formatter
- `npm test` passes after updating the test or implementation consistently
- the session timeline shows the tool approvals and file change events

## Reset

Restore the fixture before re-running the smoke test:

```bash
git checkout -- samples/tool-permission-target/src/message.js samples/tool-permission-target/test/message.test.js
```
