---
name: safe-git-operations
description: Prepare or perform branch switching, reset, clean, stash, rebase, force push, deletion, or other Git operations that can discard work, rewrite history, or mix unrelated changes. Use before such operations.
---

# Safe Git Operations

1. Read `git status`, the current branch, and relevant diff before changing repository state.
2. Separate user-owned changes from work required by the current request.
3. For destructive or history-rewriting actions, state the exact impact and obtain explicit user approval unless already granted for that exact action. Switching to an explicitly requested existing baseline and creating a new branch are ordinary reversible execution steps when they do not overwrite working-tree changes; do not ask the user to confirm them again.
4. Prefer an isolated branch or worktree over stashing shared work.
5. After the operation, verify branch, status, and diff match the intended state.

Do not use a stash as an inspection shortcut when it can mix task changes with pre-existing work.
