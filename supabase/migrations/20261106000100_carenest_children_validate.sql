-- CareNest: validate care_items_per_child_has_child (SI-45, slice C).
--
-- 20261106000000 added the check NOT VALID, so it already holds for every new or changed row.
-- This checks the rows from before it. It is its own migration because each file runs in its own
-- transaction: VALIDATE takes only SHARE UPDATE EXCLUSIVE on care_items, which does not block
-- reads or writes, so the scan never holds the stronger lock the previous file took.
--
-- Expected to pass: slice A's backfill gave every food, preferences, and instructions item a
-- child, and its care_items_default_child trigger has done so for every save since. If a row
-- breaks the rule anyway, this migration fails (23514) with nothing changed, the previous one
-- stays applied, and the check still guards new rows.

-- A DO block, as in 20261102000000: the CLI's implicit transaction ignores a top-level SET LOCAL.
do $$
begin
  set local lock_timeout = '5s';
end;
$$;

alter table public.care_items validate constraint care_items_per_child_has_child;
