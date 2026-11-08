# /dispose — Safely clean up only this task's resources

Run after work is merged, abandoned with approval, or otherwise safely recoverable.
This command is cleanup. Audit finding classification belongs to `/disposition`.

## Inventory before mutation

List the exact resources created or owned by this task:

- local/remote task branch and PR;
- dedicated worktree path;
- gitignored context, proof, logs, downloads, and other scratch paths;
- temporary servers or processes started by the task;
- current checkout/parking branch expected after cleanup.

Confirm ownership from the current task record, branch, PR, and worktree list. Never infer
ownership from a name alone.

## Cleanup

1. Confirm committed/merged work is recoverable from the remote or approved to discard.
2. Stop only task-owned temporary processes.
3. Remove only the task-owned worktree, using the normal non-force path.
4. Delete only task-owned local/remote branches when repository policy allows it.
5. Remove only exact task scratch paths.
6. Return the primary checkout to the repository's designated clean parking/integration
   branch and update it only through the documented safe path.

## Guardrails

- Never delete or rewrite the primary/protected/integration branch.
- Never remove another task's branch, PR, worktree, process, or artifacts.
- Never run broad worktree pruning, `reset --hard`, force deletion, recursive cleanup on
  an unresolved path, or a shared `git stash` to make cleanup succeed.
- Never close/reopen or force-push a PR not created by this task.
- If ownership or recoverability is uncertain, leave the resource and report it. Stranded
  cruft is cheaper than deleting another session's work.

Finish with a concise list of removed resources, retained resources and why, recovery
location, and final branch/worktree state.
