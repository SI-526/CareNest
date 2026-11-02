# SI-45 slice A: technical decisions

Branch `claude/si-45-a-children-schema`, migration `20261102000000_carenest_children.sql`.
Product decisions came fixed from Kelvin and are not repeated here. These are the choices the
builder made. Each one is reversible with a new forward migration unless it says otherwise.

## D1. Tenant safety of care_items.child_id: composite foreign key
- **Decision:** how to guarantee a care item only points at a child of its own family.
- **Choice:** `unique (id, household_id)` on `children`, and `foreign key (child_id, household_id)`
  on `care_items`.
- **Standard:** SQL-92 composite referential integrity, the usual tenant-scoped foreign key in
  multi-tenant Postgres. It won because the database itself refuses the bad row whichever code
  path writes it.
- **Rejected:** plain `child_id -> children (id)` plus a trigger or an RLS check. It leaves the
  rule in code a later policy edit can drop, and a service-role write skips RLS entirely.
- **What breaks next quarter if wrong:** with a plain FK, a parent could attach an allergy note to
  another family's child id by editing one request, and the note would show on that child's page
  in slice C. Mutation C2 proves the tests catch exactly this.
- **Reverse:** drop the constraint, add a plain FK. No data change.

## D2. Deleting a child deletes that child's care items (needs Kelvin's eye, see report)
- **Decision:** what the foreign key does when a child row is deleted.
- **Choice:** `on delete cascade`.
- **Standard:** cascade is the normal SQL treatment of rows wholly owned by a parent row, and
  every other household-owned table here cascades the same way.
- **Rejected:** `no action` (delete refused while items exist: the household cascade would then
  depend on the order Postgres fires its triggers), `no action deferrable initially deferred`
  (what `task_checks` uses to fix that ordering: the household cascade would work, but a child
  delete would still fail at commit while the child has items, so a parent could not delete a
  child without clearing its items first), and `set null` (would null household_id too, and a
  column-list set null leaves allergy rows with no owner, shown on no page). Cascade still stands.
- **What breaks next quarter if wrong:** a mis-tap on a delete control in slice C silently removes
  a child's allergy list, with no undo. This is a consequence a user would see, so it is flagged
  as a product question for slice C, which owns the delete UI and its confirmation.
- **Reverse:** swap the FK to `no action`. Rows already cascaded away cannot be restored.

## D3. Transition triggers run as SECURITY DEFINER; no client can call them
- **Decision:** whose privileges the three trigger functions and the helper use.
- **Choice:** `security definer`, `set search_path = ''`, `revoke all ... from public`, no grant
  to `authenticated`, so the pinned list of callable functions in `tests/rls.test.mjs` is unchanged.
- **Standard:** PostgreSQL's documented rule for safe SECURITY DEFINER functions (fixed search
  path, revoked PUBLIC execute), and this repo's own `resolve_schedule_requests`.
- **Rejected:** SECURITY INVOKER. The helper would need EXECUTE for `authenticated`, making a
  row-creating function callable through the API, and an old-client save would start failing the
  day a later migration narrows a grant on `children`.
- **What breaks next quarter if wrong:** a definer function acting on a household the caller does
  not own. Covered: the care item trigger runs before the insert policy, so a stranger's write
  is refused and any child it made is rolled back with the statement.
- **Reverse:** `alter function ... security invoker` plus a grant.

## D4. A family with no children left: the next old-client write makes a new first child
- **Decision:** what the transition does after a parent deletes every child.
- **Choice:** `ensure_first_child` creates one from the household's columns, under a
  `for no key update` lock on the household so two tabs make one child, not two.
- **Standard:** double-checked locking on the parent row, the usual Postgres get-or-create when
  no unique constraint can express the rule. (`on conflict` cannot: "exactly one first child" is
  not a key.)
- **Rejected:** refusing to delete the last child (needs a trigger that also lets the household
  cascade through, and changes the agreed "parents delete"), and leaving child_id null (the
  spec's "the old client still works" would quietly stop being true: the item would have no
  child and would disappear from every child page in slice C).
- **What breaks next quarter if wrong:** slice C has to keep the default-child trigger through a
  grace period: if it drops the trigger as soon as the new pages ship, a tab still open on the old
  client saves a food item with no child, and that item is on no child's page. Slice C also has to
  live with one race: a new-page insert into `children` does not take this lock, so it can race an
  old-tab save on a childless family and make 2 children. Nothing is lost, and the parent can
  delete the extra one.
- **Reverse:** slice C drops the function with the triggers, after the grace period.

## D5. The sync trigger fires only on a real change, and copies only the column that changed
- **Decision:** when `households.child_name` and `child_age_label` copy to the first child, and
  which of them copies.
- **Choice:** `after update of child_name, child_age_label` with a `when` guard on
  `is distinct from`, and `sync_first_child` copies each column under its own `case`, on update
  only. The insert path never reads `old`: the child was just created from the same columns.
- **Standard:** the `WHEN` clause is PostgreSQL's documented way to skip no-op trigger runs.
- **Premise corrected:** the first version said `js/manage.js:375` sends all three columns on every
  save. It does not. `js/manage.js:372-373`, `js/secondary.js:484`, and `js/onboarding.js:70` send
  two, `child_name` and `child_age_label`, and no client updates `households.name`. So the real
  hazard was not a family rename: it was that a save changing one child column resends the other.
- **Rejected:** `update of` alone (a form resubmitted unchanged would undo a direct edit), and the
  guard alone with both columns copied (a save that changes only the age would undo a direct edit
  of the name). Mutations T3, T17, and T18 cover these.
- **What breaks next quarter if wrong:** a parent fixes the name on the new page, then changes the
  age in a still-open old tab, and the fixed name silently reverts.
- **Reverse:** recreate the trigger and function.

## D6. The copy runs one way, household to first child
- **Decision:** whether a direct child edit also updates the household columns.
- **Choice:** no, as the brief says.
- **Standard:** single writer per direction: the usual expand/contract transition, where the old
  shape feeds the new one until the old readers are gone.
- **Rejected:** two-way sync: it needs a loop guard, and it would let a slice C page rewrite the
  columns old tabs are using mid-edit.
- **What breaks next quarter if wrong:** an old tab still open after slice C shows the old name
  until reload. Slice C must not stop writing through this path before no old client remains.
- **Reverse:** add a trigger on `children`.

## D7. Trigger first, backfill second, inside the migration's locks
- **Decision:** ordering on a live database.
- **Choice:** the file opens with a DO block that runs `set local lock_timeout = '5s'` and
  `lock table public.care_items, public.contacts, public.households in access exclusive mode`,
  child tables first. Then triggers before the backfill, `alter table care_items` before its
  backfill, and `where not exists` on the children backfill.
- **Standard:** Postgres transactional DDL, and the common zero-downtime migration practice of a
  short `lock_timeout` on any statement that takes ACCESS EXCLUSIVE (the lock queue otherwise
  stalls every later reader behind one blocked migration), with locks taken in a fixed order so
  two sessions cannot wait on each other.
- **Verified by execution, CLI 2.118.0, `--db-url` and `--local`:** `supabase migration up` applies
  one file as one transaction. See "Review round 1" for the run that proves it.
- **Why a DO block:** the CLI's implicit transaction refuses a top-level `LOCK TABLE` (25P01).
  Inside a DO block the lock and the `set local` both last until the file commits.
- **Rejected:** backfill first, trigger after (a household created between them would have no
  child), and `households` first: a client write holds its own table and then waits on
  `households` for the foreign key check, so that order deadlocks with it.
- **What breaks next quarter if wrong:** a family created during the deploy has no child and its
  next food item has nowhere to go. The trigger fallback (D4) is the second line of defence. If a
  lock is not free in 5 seconds the push fails with 55P03, nothing changed, and it can be rerun.
- **Reverse:** not needed, this is ordering only. Once held, the locks block reads and writes on
  all three tables until commit, and so also the foreign key check of a write to any table that
  references `households`. Its duration against the hosted row counts was not measured.

## D8. Item trigger also covers a change of category or child (small addition to the brief)
- **Decision:** the brief says BEFORE INSERT. The trigger is
  `before insert or update of category, child_id`.
- **Choice:** cover both updates too.
- **Standard:** a defaulting rule must hold on every path that creates the state it guards.
- **Rejected:** insert only, and `update of category` alone. No client changes either column
  today, so this costs nothing, and the alternatives are a request that moves a `where` item to
  `food`, or sets `child_id = null` on a food item, leaving it with no child. Mutation T19 covers
  the second.
- **What breaks next quarter if wrong:** that item is on no child's page in slice C.
- **Reverse:** recreate the trigger for insert only.

## D9. Check constraint: family-wide categories have no child (small addition to the brief)
- **Decision:** whether the database enforces "where things are and emergency steps stay
  family-wide".
- **Choice:** `check (child_id is null or category in ('food', 'preferences', 'instructions'))`.
- **Standard:** declare invariants as constraints, the same way this table already pins
  `severity` to food items.
- **Rejected:** leave it to the client. The old client never sends child_id, so the constraint
  cannot affect it, and slice C's client gets a hard stop against a bug.
- **What breaks next quarter if wrong:** a slice C bug files an emergency step under one child and
  a sitter viewing a sibling does not see it. That is a safety problem, so it is worth one line.
- **Reverse:** drop the constraint.

## D10. Column-by-column SELECT on children, unlike every other table on Realtime
- **Decision:** table-level or column-level SELECT.
- **Choice:** column-level for select, insert, and update, as the brief says, delete table-level
  (Postgres has no column delete).
- **Standard:** PostgreSQL column privileges (SQL standard). This is the repo rule that a new
  table starts closed, extended to future columns.
- **Rejected:** `grant select on public.children`, the older repo habit. A column added later
  would be readable the moment it exists, which is what a sensitive field must not be.
- **What breaks next quarter if wrong:** Realtime and `select('*')` are the two things that could
  have broken: a new test proves a sitter receives a full event, and the shared table loop proves
  `select *` works. A future column on `children` needs its own select grant or `select *` fails
  loudly with 42501. That is the intended failure.
- **Reverse:** one grant.

## D11. is_primary and the label columns are NOT NULL
- **Decision:** nullable or not, where the brief says only `default`.
- **Choice:** `is_primary boolean not null default false`; `age_label`, `stage_label`, and
  `pinned_note` are `text not null default ''`.
- **Standard:** two-valued booleans, and the repo's empty-string convention on `households`.
- **Rejected:** nullable: three states for a yes/no, and the partial index would treat null and
  false the same while the client would not.
- **What breaks next quarter if wrong:** nothing expected; the old client omits the column and
  gets the default.
- **Reverse:** `alter column ... drop not null`.

## D12. "First child" tie-break: position, created_at, id
- **Decision:** which child is first when positions tie.
- **Choice:** `order by position, created_at, id`, in one function used everywhere.
- **Standard:** a deterministic total order, the normal requirement for "first row" queries.
- **Rejected:** position alone. Two children at position 0 (the column default) would make the
  old client's saves hop between them.
- **What breaks next quarter if wrong:** a reorder can still land an old tab's save on the wrong
  sibling, because the old tab only knows "the child", and the first child is whichever is lowest
  at save time. The per-column copy (D5) shrinks this to the column the parent actually changed,
  but it cannot remove it. The tie-break only makes the result predictable.
- **Reverse:** edit the function.

## D13. Backfill proof: the test runs the migration's own statements
- **Decision:** how to test a backfill that has already run by the time the suite starts.
- **Choice:** marker comments in the migration; a test reads those exact statements and runs them
  in a rolled-back psql transaction over rows that look pre-migration. A one-off real upgrade
  (old schema with data, then `migration up`) was run as well.
- **Standard:** test the artefact that ships, not a copy of it.
- **Rejected:** a copy of the SQL in the test: it would keep passing after the migration changed.
- **What breaks next quarter if wrong:** the markers are test scaffolding in a frozen file, which
  is harmless, since a merged migration never changes.
- **Reverse:** delete the test.

## Mutation check

63 deliberate breaks, one at a time, against the local stack: every policy, grant, trigger, function, constraint, the publication, and the backfill statements. 63 are caught by a named test. Row-by-row results, with the failing test names, are in `mutations-a.jsonl`.

Two survived the first pass and exposed weak tests, both fixed before the final gates:

- P5e (with check removed from the care item update policy): the read policy also runs on a filtered update, so nothing exercised the with check alone. Added a raw-SQL test.
- B1 (children backfill skips blank families): the care item backfill created the child anyway because the blank test family had items. The test now has a blank family with no items.

The harness also found that the Realtime test left a socket open, adding about a minute to every `test:rls`. Fixed.
