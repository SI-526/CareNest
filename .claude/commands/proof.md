# /proof — Produce durable, reviewable evidence

Run whenever work is declared complete and again after deployment. Proof is a gate, not a
summary: verify the promised behavior on the best available target and preserve evidence
that another person or session can inspect.

## 1. Establish stage and claim

State the target (`local`, `test`, `preview`, or `production`), commit/PR/deploy identifier,
and the exact user-visible or system claim being proved. Pre-merge proof and production
proof are distinct; do not present one as the other.

## 2. Inspect the actual change

- Diff from the repository's merge base and enumerate every changed file.
- Summarize behavior-changing hunks; collapse generated or mechanical noise.
- Identify the top three plausible production failures and mark each `addressed`, `open`,
  or `deferred` with evidence or owner.

## 3. Execute change-type verification

For UI proof, prefer deterministic Playwright or repository-native browser tests when they
prove the claim. Any interactive computer-use pass must be delegated and run alone against
the browser pane: Claude uses `builder-opus-low` for a fixed checklist or `builder-opus`
for diagnosis; Codex uses Sol high or Sol xhigh respectively. Never route computer use to
Fable or Astra, and never use `low` or `max` effort. Save screenshots, recordings, accessibility trees, and page dumps
under `.claude/proof/<task>/`; return only artifact paths and concise pass/fail findings to
the orchestrator.

- **UI:** drive the real browser at the target, exercise the promised path and important
  failure/empty state, and attach screenshots. Record a short capture for multi-step flows.
- **API/logic:** capture representative request/response or deterministic test output,
  including authorization and error cases when relevant.
- **Background/event work:** capture the run/result plus the resulting durable state;
  account for retries and idempotency.
- **Schema/data:** use only the repository-approved migration procedure. Capture status and
  deploy/dry-run output; never substitute an unsafe schema-sync command.
- **Prompts/models:** capture required eval results and relevant before/after cases.
- **Infrastructure/config:** capture plan/status/health evidence and the rollback path.

Run all required lint, type, build, test, security, migration, and eval gates implicated
by the change. Record commands and exit codes; do not say "tests pass" without specifics.

## 4. Output the proof block

```markdown
## Proof — <change> (<stage>)
- **Target:** <URL/environment + commit/PR/deploy>
- **Claim:** <behavior proved>
- **Diff:** <file inventory + key behavior changes>
- **Top risks:**
  1. <risk> — addressed|open|deferred — <evidence/owner>
  2. <risk> — addressed|open|deferred — <evidence/owner>
  3. <risk> — addressed|open|deferred — <evidence/owner>
- **Verified:** <commands, exit codes, observations, artifact links>
- **NOT verified:** <every skipped, assumed, env-specific, or unreachable path>
- **Rollback:** <exact route>
- **Verdict:** PASS | FAIL | BLOCKED
```

Never abbreviate `NOT verified`. Missing mandatory evidence makes the verdict `FAIL` or
`BLOCKED`, not PASS. If evidence contradicts the claim, return to implementation and
re-prove.

## 5. Preserve the evidence

Post the concise proof block and artifact links where the repository expects them (for
example, the PR or release record). Store temporary captures only in a gitignored task
directory or external attachment. Never commit bulky screenshots/recordings unless the
repository explicitly requires it.
