# /ship — Idea to production, hands-off

Take the requested outcome from idea through implementation, delivery, production
verification, documentation, and cleanup. The user stays on the loop for product
decisions and hard stops; routine execution and technical decisions stay with the agent.

**`/ship` is approval.** Invoking it counts as "go" under the plan-first rule. With no
arguments right after a PLAN block or recommendation, it approves exactly that plan: execute
it without asking again, except at the boundaries below or the plan's own stop-and-ask
conditions.

Invoking `/ship` authorizes the normal reversible lifecycle: create a branch or
worktree, edit files, run checks, commit, push, open or update a PR, drive CI green,
merge using the repository's normal policy, verify the deployed result, and clean up.
Do not pause for those routine steps. The approval covers the request fully built out:
the shipment and the follow-up work that comes out of it (Phase 7), until nothing
buildable is left. It covers no older backlog and no later request.

## Non-negotiable boundaries

- Read the repository instructions and delivery/runbook docs before acting. Repository
  rules override generic defaults.
- Stop before staging if the change includes a secret, credential, `.env`, private key,
  generated credential file, or unrelated user work.
- Route every choice by the user-visible test (`~/.claude/CLAUDE.md` §1; in a cloud
  session, which has no `~/.claude`, the repository's `CLAUDE.md` and the rules below). Technical
  decisions are made, not asked: pick industry-standard first, record an ADR-style entry
  (choice, standard, rejected alternative, concrete "what breaks next quarter" failure,
  reversal) in the PR body and `## Decisions`, and keep going. Only product decisions go
  to the user, in plain language with "Recommended:". A technical decision auto-made in a
  risk area (auth or permissions, tenant boundaries/data model, migrations, billing or
  spend limits, hub nodes, share-link auth, or the repository's own trigger list) requires
  a fresh-context `builder-opus-xhigh` (Sol xhigh in Codex) review of the diff plus
  decision record before merge; unresolved disagreement after one round becomes a hard stop.
- Hard stops need the user's plain-language "go": real-money spend (paid tier, raising an
  LLM budget/spend cap), destroying or irreversibly changing production data with no
  restore path, and platform-forced approvals (permission prompts, production
  `migrate deploy`, login/2FA/passkey walls, missing secrets). Never work around them.
- Preserve unrelated dirty state. Never use `git add -A`, a shared `git stash`, forceful
  cleanup, or another task's branch/worktree as a shortcut.
- Prefer established project patterns and small reversible changes over novel machinery.

## Phase 0 — Repo copy and backport

`~/.claude/commands/` and `~/.claude/agents/` are the source of truth for `/ship` and the
commands and agents it calls. A repository keeps a copy so `/ship` also works in cloud
sessions, which have no `~/.claude`.

- **Bootstrap (local sessions).** If the repository has neither `.claude/commands/ship.md`
  nor `.claude/skills/ship*`, copy `~/.claude/commands/{ship,proof,next,disposition,dispose}.md`
  into `.claude/commands/` and `~/.claude/agents/builder-*.md` into `.claude/agents/`.
  Never overwrite a file that exists: a repository may have specialized it. Commit the
  copies in this shipment's first PR with one PR-body line: "Adds the /ship workflow
  files; global `~/.claude` is the source of truth." If the repository is public, ask
  first: the files describe models and spend rules.
- **Backport.** When a shipment changes a repository's copy of these files (or of a
  specialization of them, such as a repo playbook), every part of the change that is not
  specific to that repository is also made to the matching global file in the same
  sitting. Local sessions only: save the global original as `<file>.bak-<date>` first and
  list the backport in the PR body. A cloud session cannot write `~/.claude`: it lists the
  change under "Backport to global (pending)" in the PR body, and the next local session
  that sees it applies it. Repository-specific rules (its database, branches, CI checks,
  deploy path) stay in the copy.

## Phase 1 — Resolve the delivery contract

Investigate first: read the relevant code, tests, docs, current git state, and recent
history. Resolve discoverable questions independently. Establish:

- who the change is for;
- the observable success metric;
- the full outcome cut into PR-sized slices (none left out for size);
- in-scope files/systems and explicit non-goals;
- affected risk gates, tests, deployment path, and rollback.

Pressure-test assumptions and failure modes, and decide technical questions yourself. If
a material product answer cannot be inferred, batch the remaining product questions into
one plain-language decision review with a clear recommendation. Do not reopen choices the
user already made. `/ship` itself approves the recommended safe, reversible plan; only
product decisions and the hard stops above may halt execution.

## Phase 2 — Orchestrate the build

Choose the shipment owner independently of the model that received `/ship`. Opus high is
the normal Claude owner and Sol high is the normal Codex owner. A cheaper session may own
a bounded deterministic shipment when it is sufficient. If the current session is Fable,
Astra, or another tier above what the complete task warrants, dispatch a clean-context
owner at the normal rung. The expensive parent then handles only unavoidable safety/user
decisions, efficient waiting, and final consolidation; it does not implement, browse, or
re-read worker evidence.

Delegate implementation and CI-driving work whenever subagents are available; do not hand
the user prompts to paste elsewhere. If delegation is unavailable, continue with the
lowest capable available tier and keep the session context lean. Cost control never
creates a self-imposed usage stop or relaxes proof, deployment, rollback, or cleanup.

Before each agent starts (including the shipment owner, implementation, and verification
workers), show this concise notice once. Show a new notice if its model or effort changes:

```text
DISPATCH
Runtime: <Claude Code | Codex>
Worker: <agent or task name>
Model: <exact model> @ <exact reasoning effort>
Task: <one-line bounded outcome>
Why this tier: <one-line reason>
```

After the dispatch notice, keep routine agent progress and coordination quiet. Report
only important findings, blockers requiring input, material risks or scope changes, and
completion. Do not repeat unchanged status or duplicate dispatch notices.

**Effort range is `medium` to `xhigh`, on every model, in every runtime, for every task.** Never
`low`, never `max`. Tier ceilings below still apply: Fable at high is the top of the Claude ladder.

Detect the active runtime and use only its ladder. Choose the lowest rung that can
complete the bounded task reliably; escalate from evidence, not prestige.

### Claude Code ladder

| Worker | Model / effort | Use when |
|---|---|---|
| `builder-haiku` | Haiku 5.5, medium | Scout and mechanical work: locate, enumerate, extract and inventory code for a builder's brief; CI waiting; zero-judgment steps with a deterministic pass/fail signal. Never writes or reviews product code. |
| `builder-sonnet` | Sonnet 5.5, medium | Fallback for the row above, only when `builder-haiku` is unavailable or failed a mechanical task for a capability reason. |
| `builder-opus-low` | Opus 5.5, medium | Small, fully specified change with little judgment. |
| `builder-opus` | Opus 5.5, high | Default for substantive implementation. |
| `builder-opus-xhigh` | Opus 5.5, xhigh | The independent risk-area review. Otherwise break glass: only after `builder-opus` failed three correction rounds for a **capability** reason. Never the routine builder or the routine reviewer. |
| `builder-fable` | Fable 5.1, high | Break glass. ONLY (a) after `builder-opus-xhigh` failed three correction rounds for a **capability** reason, or (b) when the user names Fable in their ask. Never for risk, never for quota. |

**Fable gate.** A `builder-fable` DISPATCH is invalid unless `Why this tier` quotes the
failed `builder-opus-xhigh` report (round count + what it got wrong) or the user's message naming Fable. Two
things are NOT Fable triggers:
- **Risk.** A risk area (auth, data model, migrations, hub nodes, LLM budget) gets the
  auto-decision record and the independent `builder-opus-xhigh` review; the build stays
  on `builder-opus`. Risk is covered by that review and the gates, not by a smarter model.
- **Quota / environment.** A worker dying on rate limit, quota, flaky CI, or a broken
  worktree is not a capability failure. Do not escalate. Report the reset time and
  stop; the user decides whether to wait or authorize Fable. Fable shares the orchestrator's
  quota pool, so escalating on quota drains the pool that runs this loop.

### Codex ladder

| Model / effort | Use when |
|---|---|
| GPT-6.1 Sol, medium | Bounded, fully specified work with deterministic validation; scripted checks. |
| GPT-6.1 Sol, high | Default for substantive implementation and routine production-quality review. |
| GPT-6.1 Sol, xhigh | Difficult integration, debugging, and consequential review. |
| GPT-6 Astra, high | Exceptional production-critical problems only. |

Use Sol medium for bounded work or Sol high for substantive work.
Do not use Astra high as the routine
architect, orchestrator, or fallback; reach it only when a production-critical problem
is exceptional even after applying the Sol ladder.

**Astra gate.** An Astra-high dispatch is invalid unless `Why this tier` names the
exceptional production-critical impact and either quotes the failed Sol-xhigh report and
capability gap or the user explicitly requested Astra for that bounded task. Risk, quota,
rate limits, flaky CI, and environment failures are not Astra triggers.

### Cost controls

- Start delegated workers with no inherited conversation (`fork_turns: none` in Codex or
  the runtime equivalent). Pass a bounded contract, relevant file paths, and a concise
  state packet; never copy an audit, transcript, screenshot set, or full command log.
- When `/ship` follows a broad audit, research task, or long debugging session, always
  cross a clean-context boundary. Distill accepted findings, decisions, current state,
  and next action into the state packet; do not continue the shipment in the audit context.
- **Hand off past the context threshold.** The orchestrator's context is re-read on
  every turn too, and a session resumed after an hour's gap re-caches all of it. Under
  ~400k (of a 1M window; ~150k on a 200k window) the shipment and its tail stay in this session. Check before each slice and each
  tail item. At about 300k (~120k on a 200k window) tell the user in one line, with the
  number. Past ~400k start nothing new here, finish only the phase in flight, and hand
  the rest to a continuation session whose prompt is the state packet: start it yourself
  when the runtime has a tool that starts one, otherwise raise a task chip (`spawn_task`
  in the Claude desktop app; where no such tool exists, print the packet). Do the same at
  the start, when `/ship` is invoked in a session already past ~400k of audit, research,
  or debugging: hand off and stop instead of building here. The packet must stand alone:
  goal, accepted decisions, exact paths, PR/commit identifiers, the tail issue, gates
  passed, next action, rollback. A session the user starts from a chip is approved for
  the items its packet lists, nothing more. A hand-off replaces this session for that work; it
  never adds a parallel build. Keep one build session active at a time unless the user
  asks for more: parallel `/ship` sessions burn the weekly quota fast. Never hand off work that is mid-flight for the current PR
  (review rounds, CI fixes, production proof, cleanup); a fresh session would have to
  rediscover it.
- Default to one active implementation worker. Use at most two only when both tasks are on
  the critical path, independent, and own disjoint files/worktrees. Do not launch
  speculative builders, broad audits, or reassurance-only reviewers. The risk-area
  decision reviewer (Non-negotiable boundaries) is a required gate, not reassurance.
- **Scout first, on the scout tier.** Searching and reading code is most of a
  builder's spend and context. Before briefing a build or review worker, dispatch `builder-haiku` with one
  question: where is the code this slice touches? It returns a map (files with line
  ranges, the excerpts that matter, the existing pattern and test to follow) in under
  about 2,000 words. Paste the map into the builder's brief so the builder opens those
  ranges instead of searching; the builder may still search when the map falls short.
  Skip the scout only when you already hold exact paths and line ranges. Keep each scout
  to one question and a short run: Haiku 5.5 costs five times more per token once its
  prompt passes 100k, and its window is 200k.
- **One phase per worker; keep context near ~150k.** Every turn re-reads the worker's
  whole context, so cost grows with turns squared, and nothing stops a worker
  mid-phase. So the bound is set by the size of the brief, not checked afterwards. A
  worker gets ONE phase and hands back: build one PR-sized slice and verify it locally;
  or one proof fix; or one CI fix. It does not stay alive to wait on CI. State the budget
  in every brief: after about 50 tool calls the worker hands back a partial report (what
  is done and committed, what is left) instead of pressing on. The next phase goes to a
  fresh worker at the same tier, briefed from the previous report, the scout map and the
  status record. The one exception is a correction to the phase a worker just handed
  back, and only when its last result reported under ~150k. A slice whose brief needs
  more than about ten files read in full is two slices. "Its context is still useful" is
  not a reason to exceed the bound.
- **Hand the reviewer the diff.** Otherwise the reviewer spends most of its budget
  rebuilding the diff with git and file reads. Before dispatching any reviewer, write the diff to a task-scoped file
  (`git diff origin/main...HEAD > .claude/proof/<task>/review-<short sha>.diff`) and give
  the reviewer that path, the HEAD sha, the decision record and the scout map of touched
  call sites. Paste a diff under about 400 lines into the brief instead. Regenerate the
  file after every fix push so a reviewer never approves a stale diff. The reviewer still
  gets no builder reasoning.
- **CI waiting is mechanical-tier work.** After the PR is open, use the runtime's PR
  monitor when it has one; otherwise `builder-haiku` (Claude) or Sol medium (Codex) arms
  auto-merge, waits with one blocking watch per run, and re-pushes zero-judgment fixes
  (format, lint autofix, rebase, lockfile). On a red check that needs diagnosis it reports
  the failing job plus the actionable log excerpt, and the fix goes to an implementation
  worker under the context bound. Never keep a high-tier worker alive to poll checks.
- **Read-only fan-out runs below the build tier.** Enumerate, extract, locate, and
  inventory tasks go to `builder-haiku` (Claude; name the agent rather than passing
  `model: haiku`, which can resolve to an older Haiku, and `Explore` inherits
  the parent model unless told otherwise) or Sol medium (Codex). Use the build tier only
  when the output is a judgment: a review verdict, a risk call, a design choice.
- Store full logs, screenshots, recordings, accessibility trees, and large reports in
  task-scoped proof/scratch files. Reports contain results, actionable failure excerpts,
  and paths—not raw payloads. The orchestrator opens only evidence needed for a decision.
- Inspect incrementally: file lists and diff stats first, then targeted hunks or line
  ranges. Set output caps, do not dump whole repositories or unchanged manuals, and do not
  reread unchanged instructions after recording the applicable invariants.
- Maintain a concise phase-boundary status record containing commit/PR/deploy identifiers,
  completed gates, current failure, next action, and rollback. Resume from it instead of
  reconstructing state from chat history.
- Prefer narrow checks during iteration. Run the complete required gate set once for a
  release candidate; after a fix, rerun the affected checks and any full gate the change
  invalidated rather than reflexively rerunning unrelated work.
- Wait on CI, deployment, and worker state changes with the longest practical event-based
  wait. Do not repeatedly fetch unchanged status or paste entire check/deploy payloads.
- When the runtime exposes usage, read it at the start, phase boundaries, and before a
  reserve-tier escalation. Report material changes, but never stop at a policy percentage.
  Never redeem a reset or buy credits without the user's explicit authorization.

The worker brief must contain the delivery contract, repository instructions, allowed
scope, non-goals, branch/worktree ownership, validation gates, the hand-back point (slice
built and locally verified, not CI green), and required report.
Parallelize only independent tasks with disjoint files and separate worktrees; otherwise
sequence them. Never let two workers mutate the same checkout or branch.

Require this report:

```markdown
## Report
- **Worker:** agent name and actual model
- **Done:** file-by-file changes
- **Verified:** commands/observations with results and exit codes
- **NOT verified:** skipped, assumed, or unreachable behavior
- **Risks / deviations:** scope changes, new dependencies, unresolved risk
- **Blocked / needs a decision:** question or `none`
- **PR / branch:** link or name
```

Review in this order:

1. Answer blockers from the approved contract or repository docs and decide technical
   ones; escalate only a product decision or a hard stop.
2. Send missing required verification back to the worker (the same one under the context
   bound, a fresh one over it).
3. Correct scope drift, unapproved dependencies, or unrelated edits.
4. Inspect the actual diff and test evidence; a confident report is not proof.
5. Accept only when the report and repository state agree.

Allow at most three correction rounds per slice; swapping in a fresh worker for the
context bound does not reset the count. Then fix an unclear brief or, on a
capability failure only, escalate one tier with the failed report and evidence. Quota or
environment failures stop and report per the Fable gate. Keep implementation out of the orchestrator
context unless delegation is unavailable or the task is truly mechanical.

## Phase 3 — Validate and prove before merge

A bug fix starts with a test that fails on the bug: the builder sees it fail, then writes
the fix.

Run the repository's complete required checks plus every conditional gate implicated by
the diff. Then run `/proof` against the best available pre-merge target.

Minimum proof includes the exact diff inventory, top three production risks, verified
commands/observations, a complete NOT-verified list, and change-type evidence. UI work
needs a real-browser screenshot; schema work needs the repository-approved migration
evidence; API/background work needs observable request/result/state evidence.

If proof fails or a required gate is unverified, return to the builder (same one under the
context bound, a fresh one over it), fix, rerun
the full affected gate set, and regenerate proof.

**Browser and computer-use work is always delegated, in every phase.** Prefer a
repository-native API, CLI, or deterministic Playwright check when it proves the claim;
use computer use only for rendered interaction or visual judgment. Screenshots and
accessibility trees must never enter the orchestrator's context. The orchestrator writes
the checklist (URL, steps, expected text or state per step) and dispatches with a DISPATCH
block:

- Claude: `builder-opus-low` for scripted verification; `builder-opus` when diagnosis is
  required. Never Fable.
- Codex: Sol high for scripted verification; Sol xhigh when diagnosis is required. Never
  Astra.

The worker saves evidence under `.claude/proof/`, reports file paths plus pass/fail per
checklist item, and never pastes images or page dumps into its report. The browser pane
is shared per session: run browser workers one at a time, never in parallel.

## Phase 4 — Ship and drive delivery green

Steps 1–4 are the last part of the build phase when the builder's context is under the
bound; otherwise they go to a fresh `builder-opus-low` (Sol medium in Codex) briefed with
the exact path list, commit message, and PR body. Step 5's waiting goes to the mechanical
tier (see Cost controls).

1. Reconcile with the latest target branch according to repository policy.
2. Stage only task-owned paths and inspect the staged diff for secrets and unrelated work.
3. Commit conventionally, push, and open or update a non-draft PR. Every PR body carries
   a short **What users will see** section: what changed for a user and where to look,
   or "Nothing user-visible".
4. Enable the repository's normal auto-merge/merge-queue path when available.
5. Watch CI on the mechanical tier. Diagnose and fix on an implementation worker, push,
   and repeat until every required check is green. A red run is an intermediate state,
   not the handoff.
6. Merge only through the repository's required policy. Never bypass protection merely
   because a check is inconvenient.

If deployment is separate from merge, follow the repository runbook. Never infer that a
merge deploys production. For database or infrastructure changes, use only documented,
auditable deployment mechanisms.

## Phase 5 — Prove production

Run `/proof` again against the deployed target and capture durable evidence of the actual
promised behavior. Confirm deployment health as well as feature behavior. If production
proof fails, assess user impact, use the documented rollback when safer than fix-forward,
and continue until production is healthy or a genuine external gate requires the user.

Attach or link proof where the project expects it. Do not commit bulky proof artifacts
unless repository policy explicitly requires that.

## Phase 6 — Document decisions and reality

Update the repository's required release/change documentation. Resume, in-flight and
"what is owed" state goes in the PR body or a tracker issue comment, never in memory;
memory gets only a reusable lesson that would change how a future session works.
Record architectural facts in their owning current-state document rather than duplicating
them. If documentation is genuinely unnecessary, say `Docs: N/A because ...`.

Every loop must leave a `## Decisions` section in the appropriate durable record:

- user product choices and hard-stop "go"s, alternatives, selection, and why;
- every auto-made technical decision in ADR form: decision, choice, standard, rejected
  alternative, "what breaks next quarter" failure considered, reversal, and the
  risk-area review verdict when one ran;
- unresolved product questions or hard stops;
- agent or worker judgment calls that materially shaped behavior;
- scope or default deviations and why;
- `none` when no material decision was made.

## Phase 7 — Finish the tail, dispose, hand back

`/ship` means fully built out. Once the PR is proven in production, do not stop and do
not invoke `/next` (typed by hand it presents and waits). Loop:

1. **Capture** read-only with `/next`'s capture, prioritize, owner and tranche rules, and
   give every finding one disposition. Split it: the **tail** is every follow-up,
   finding, NOT-verified gap, deferred or out-of-scope item and TODO that came out of
   this shipment, including ones a tail item produces; the **backlog** is everything
   that existed before it.
2. **Record** the tail in one tracker issue, "Ship tail: <outcome>": a checklist line
   per item with its disposition, then its PR or the reason it is not buildable. It is
   the loop's state; a continuation session resumes from it. The last tail PR closes it
   (`Closes #N`); never leave it for the user to close. An empty tail opens none.
3. **Build** every buildable tail item in dependency order, `do-now` first, then
   `ticket-later`, as PR-sized tranches through Phases 1–6 under the original approval:
   no plan block, no question, the risk-area review where it applies.
4. **Repeat** after each tranche is proven. Stop when a capture adds no buildable item.

A tail item is buildable unless it is exactly one of: a product decision, a hard stop,
founder-only, waiting on something outside the repository (name it), or a product
priority the user already set. "Large", "tedious", "only technical" and "not urgent" are
not reasons. Record the reason on the issue, batch product decisions and hard stops into
one plain-language review, ask once, and keep building everything that does not depend
on the answer. An item that fails three correction rounds and one escalation is recorded
with its evidence and reported, not dropped.

Never build backlog under this approval. When the tail is drained, rank it, form
tranches, and raise one chip for each of the top three unblocked tranches (a standalone
packet ending "the user started this session from a /ship chip: ship exactly these
items"); list the rest. Chips are the gate: the user starts the ones they want.

Then run `/dispose` to remove only task-owned branches, worktrees, and scratch artifacts after
their work is safely merged and recoverable. Then report:

- production outcome and proof;
- PR/commit/deploy identifiers;
- checks run and anything still not verified;
- decisions and deviations;
- "Decisions made for you": one plain-language line per auto-made technical decision,
  so the user can object afterwards;
- the tail issue with each item's outcome, and what waits on the user (product review,
  "go"s, founder-only actions);
- risks and exact rollback route;
- cleanup completed or deliberately left in place;
- the backlog chips raised and the backlog items listed under them.
