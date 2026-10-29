---
name: land
description: >-
  Land the current Weaklings-Manager change onto origin/main through a GitHub
  pull request and a merge commit. Use only when the user has explicitly asked
  to land or merge the change, including a /land invocation. Do not use for
  review, preparation, passing checks, or installing this skill.
disable-model-invocation: true
metadata:
  delta-action: land
---

# Land changes

This skill lands the requested change. The request that invoked it is the merge intent. Do not ask again whether to merge, and do not reply to `/land` by saying you are waiting for an explicit landing request. Stop only for a real blocker: missing auth, unrelated dirty files, an ambiguous conflict, or a required check that is not green.

## Scope

- Repository: this checkout of `alessandrobrunoh/Weaklings-Manager`. Remote is `origin` (`https://github.com/alessandrobrunoh/Weaklings-Manager`). Destination branch is `main`.
- Land only the change the user asked to land. Leave unrelated dirty files unstaged and uncommitted. If those files would be overwritten by checkout or merge, stop and report them.
- Do not force-push `main`. Do not push directly to `main`. Do not skip hooks.

## Prepare

1. `git status`, `git diff`, and `git log --oneline -8` so the commit covers the requested change and nothing else.
2. `git fetch origin main`.
3. Create a branch from `origin/main` named for the change (for example `feat/discord-event-authority`). If already on a non-`main` branch that contains only this change, reuse it.
4. Commit with a message in the repo's style (`feat:`, `fix:`, or a short imperative sentence). `GIT_EDITOR=true` is not needed for `git commit -m`.
5. `git push -u origin HEAD`.
6. Open a pull request with `gh pr create --base main --head <branch> --title <title> --body <body>` if one is not already open for that branch.

## Conflicts

Resolve conflicts automatically when the intended result is clear (the requested change plus the incoming `main` change both kept). Pause and report the files when intent is ambiguous, a check fails, or resolving would drop unrelated work. Do not leave conflict markers.

## Verify before merging

Run the local checks that match the diff, from the repository root. Sources: `README.md` (Verification) and `apps/backend/README.md`.

- Backend (`apps/backend/**`): `cargo test -p backend`
- Discord bot (`apps/discord-bot/**`): `npm test --prefix apps/discord-bot`
- Frontend (`apps/frontend/**`): `npm test --prefix apps/frontend`

This repo has no GitHub Actions workflow. If `gh pr checks` reports required checks, they must be passing on the pull request head being merged. Pending, failing, or missing required checks mean the change has not landed. A local run does not replace a required remote check.

## Land

1. `gh pr merge <number> --merge` (merge commit, matching `Merge pull request #N` history). Do not squash and do not delete the remote branch unless the user asked.
2. `git fetch origin main` and confirm `origin/main` contains the merge commit (`git log origin/main -1` and `git merge-base --is-ancestor <feature-commit> origin/main`).
3. Report the pull request URL and the merge commit. If any step above blocked the merge, say clearly that the change has not landed and why.
