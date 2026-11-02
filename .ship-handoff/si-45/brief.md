# SI-45 to SI-49 handoff brief

## Background

CareNest is a static HTML/JS site on Vercel (no root package.json; `main` auto-deploys to https://carenest-zeta-three.vercel.app) with a Supabase backend (project `carenest`, ref `ibwshlbhszznfhmeckda`, Google sign-in). Repo SI-526/CareNest is PUBLIC, so never commit secrets.

This continues a `/ship` run for Kelvin's Sprint 3 tasks: SI-45 (parent story, several children per family and sitters serving several families), SI-46 Children list, SI-47 child detail, SI-48 and SI-49 empty states. SI-50 to SI-53 and PRs #39 and #41 are already shipped.

Product decisions already made by Kelvin, do not reopen: one family at a time in the UI with a switcher; food, preferences and instructions are per child, while where things are, contacts, emergency steps, schedule and shifts stay family-wide; home address is optional, this family only, visible to current members.

Delivery rules: migrations are forward-only and applied only by `supabase db push`; push the migration first, then merge the frontend immediately. RLS deny-by-default, column-level grants, SECURITY DEFINER with empty search_path. PRs merge with merge commits. NEVER rebase or force push: use `git merge origin/main`. Never `git add -A`, never bare `git stash`, never stage secrets or `.env`.

Hard stops needing Kelvin's plain-language "go": any production `supabase db push` (one go per migration; the PR #39 go does not carry over), spending real money, irreversible production data changes, login or secrets. Technical decisions are made, not asked, and recorded ADR-style in the PR body. Product decisions go to Kelvin in plain language with one "Recommended:". Any risk-area decision (migrations, data model, auth, tenant boundaries) gets a fresh-context independent review of the diff plus decision record before merge. No em dashes or AI-sounding phrasing in prose Kelvin reads. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; PR bodies end with the Claude Code generated line. Do not write course journal or reflection prose.

## State

Work on branch `claude/si-45-a-children-schema`.

Slice A is a tested additive schema: `supabase/migrations/20261102000000_carenest_children.sql`, `tests/rls.test.mjs`, `README.md`. An independent review of c1964b1 said APPROVE WITH FIXES with no P0 or P1. Commit 31c2143 is WIP: the fixes are partly applied and NOTHING on this tree has been verified. Read `decisions-a.md` in this folder, including any "Review round 1" section. `mutate-a.py` and `mutations-a.jsonl` are here too. Delete this whole folder before the PR merges, moving the decision record into the PR body.

## Step 0: check the environment first

Slice A's gates need Docker for the local Supabase stack. Run `docker ps`. If Docker is unavailable here, do NOT claim any database test passed. Stop and tell Kelvin plainly that this cloud environment cannot run the gates, and what remains for his computer.

## Step 1: confirm or finish each fix

Read the whole migration once and confirm no deliberate test mutation was left in it.

- F1: `sync_first_child` copies only the changed column. The function also runs on INSERT, where `old` is unassigned, so handle TG_OP correctly. The reorder test must expect "Age 2".
- F2: the migration opens with `set local lock_timeout = '5s'` and `lock table public.care_items, public.contacts, public.households in access exclusive mode`, child tables first. The header must explain why. Prove it with `db reset --version 20261026120000` then `supabase migration up --local`.
- F3: trigger fires on `update of category, child_id`. A test must prove `update care_items set child_id = null` on a food item ends with the first child set. Add it if missing.
- F5: Realtime isolation test: after the stranger hears its own event, write once more to the family, wait for the sitter to hear that exact write, then assert the stranger saw no event for this household.
- F6: the "two old-client saves at once" test must really overlap, with one transaction held open while the other waits. Run mutations T20 and T21 in `mutate-a.py`; each must be caught by a named test.
- F7: comments must be true. Delete is table-level; an old-tab save racing the last child's delete gets a visible error, so it is not "never lost"; the migration blocks reads and foreign key checks on tables referencing households too; the backfill also calls `ensure_first_child`; `js/manage.js:372-373` and `js/secondary.js:488` send two columns and no client updates `households.name`.
- F9: "a removed sitter's open Realtime subscription" test must pass on two clean runs. Otherwise remove it and soften the README sentence.

Decision record D2, D4, D5, D7, D8 and D12 should already be amended; confirm.

## Step 2: gates

From `tests/`: `npm ci`, `npm run db:reset`, `npm run db:lint`, `npm run test:unit`, `npm run test:rls`, each with a captured exit code. Then commit and push with a normal push.

## Step 3: slice A PR and production

Open a non-draft PR with the decision record, diff summary, top three risks, Verified and NOT verified. Then ask Kelvin for one plain-language "go" before production. Production `db push` may need credentials this environment lacks; if so, say so and leave that step for Kelvin's computer. After the push, merge at once and prove the live site still works. Rollback: the migration is additive and the live client ignores it; a forward migration undoes it.

## Step 4: slice B

Active-family client: auth context, switcher, realtime, and all pages. Code that assumes one family: `js/auth.js:170-215`, `:220-231`, `:16-29`, `:367`; `js/family-data.js`; `js/shift-data.js`; `js/manage.js`; `js/people.js`; `js/app.js:356`, `:1928-1990`; `js/invite.js:65-75`; `js/onboarding.js`.

Migration: replace `household_members_one_household_per_user` with a parent-only partial unique index and relax `accept_invite` for sitters. `create_household` stays blocked. Check `can_read_photo`, `can_upload_photo`, `can_delete_photo` and the delete flows with several memberships. The migration and client must ship together. Independent review, then a separate production go.

## Step 5: slice C

SI-46 Children list, SI-47 child detail, SI-48 and SI-49 empty states, parent forms on Family info for children, address and primary contact, and privacy policy update (`privacy.html:41-42`: home address, stage label, pinned note).

Figma file `13VwwDCOFlBRYSxHJCCgmh`: frames `210:155` list, `267:1320` empty state, `255:790` child detail, `259:1100` sparse child. Missing from Figma: parent add-child flow, Where things are and Instructions detail, "View all". Use "No information provided" per the story, not Figma's "No allergies or dietary restrictions", which falsely implies a medical negative. Initials, not child photos.

Keep `care_items_default_child` through a grace period, because a tab left open outlives a deploy. Create the child in `create_household` before dropping `households_create_first_child`. Then add the reverse constraint with NOT VALID, then VALIDATE. Remove the transitional triggers and `ensure_first_child` only in that order.

Product question to ask Kelvin before the delete control ships: deleting a child removes their allergy and care info immediately with no undo. Recommended: keep the delete with a clear confirmation naming what will be lost.

## Step 6: finish

Update SI-46 to SI-49 and SI-45 in Linear if Linear is available here. Update README and durable docs. Open a "Ship tail" issue covering: which name parents see on request notices (product question, Recommended: profile display name); booking deletions not reaching open pages live; one unexplained blank `auth-pending` load after a booking delete; booking form prefills 15:00 to 19:00; stale item 2 of GitHub issue #16; the missing Figma pages. Tell Kelvin SI-41 is founder-only: Google Cloud console login and client secret, and the team kept sharing on Oct 14 with a decision due before outside pilots.

Kelvin's local cleanup stays local: the `si-45-a` worktree, branches `claude/schedule-tail-fixes` and `claude/ship-tail-fixes-43c666`, and stale Docker volumes. List them in your final report rather than attempting them.

Done means SI-45 to SI-49 are live and proven on production, or each remaining step names what blocks it. The final report has "Decisions made for you", Diff, Top-3 risks, Verified, NOT verified. UI changes need a screenshot; signed-in browser proof needs Kelvin's dev sign-in on localhost, so if this environment has no browser, say so under NOT verified.
