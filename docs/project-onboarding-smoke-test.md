# Project Onboarding Smoke Test

This smoke test verifies the first project-profile loop:

1. run the built-in `Project Onboarding` workflow
2. update an existing `CLAUDE.md` without replacing valuable content
3. confirm the generated memory
4. verify development workflow admission gates

## Test Project

Use the sample project in:

```text
samples/onboarding-target
```

It intentionally includes an existing `CLAUDE.md` so the onboarding workflow must read it and
perform an incremental update.

## Preconditions

- Run `npm install` in the AI Coder repository.
- Start the desktop app with `npm run dev`.
- Claude runtime diagnostics should show the SDK is available.
- If Claude Code authentication is missing, the app may still run in mock mode; that is enough to
  verify UI gates, but not enough to validate live file edits.

## Onboarding Flow

1. Click `Select Project`.
2. Select `samples/onboarding-target`.
3. Select the `Project Onboarding` workflow.
4. Use this task prompt:

```text
Onboard this project. Read the existing CLAUDE.md, preserve its useful team rules, and update it with a compact project profile.
```

5. Start the agent.
6. Expected behavior:
   - The workflow starts even though onboarding is not confirmed.
   - The scan stage reports that `CLAUDE.md` already exists.
   - The draft stage requires approval before writing.
   - The write stage asks for file-write approval before changing `CLAUDE.md`.
   - The final `CLAUDE.md` keeps useful existing content and adds a `Compact Summary`.

## Confirm Onboarding

1. Review `samples/onboarding-target/CLAUDE.md`.
2. Click `Confirm CLAUDE.md` in the Onboarding panel.
3. Expected behavior:
   - Onboarding status changes to `confirmed`.
   - A local confirmation record is written under `~/.ai-coder/onboarding`.

## Admission Gate

1. Select `Plan Execute`.
2. Enter a small development task:

```text
Update the greeting message in src/index.ts and verify the tests still pass.
```

3. Expected behavior:
   - If onboarding is `confirmed`, `Start Agent` is enabled.
   - Session detail records the onboarding status and `CLAUDE.md` hash at start.

## Pending Review Regression

1. Edit `samples/onboarding-target/CLAUDE.md` manually.
2. Re-select the project or refresh onboarding status by selecting the project again.
3. Expected behavior:
   - Onboarding status becomes `pending_review`.
   - `Plan Execute` is blocked by default.
   - Checking `Run without confirmed onboarding` allows a local experiment.
   - The started session records `override: true`.

## Known Limitations

- There is no separate refresh button for onboarding status yet; re-select the project to refresh.
- Denying a rework request is not implemented yet.
- Live Claude execution depends on the local Claude Agent SDK and Claude Code authentication.
