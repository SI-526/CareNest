-- CareNest: the client knows about children (SI-45, slice C of 3).
--
-- Slice A added public.children with transitional triggers, because the client then knew only
-- households.child_name and child_age_label. The slice C client reads and writes children
-- directly. Tabs still open on the old client keep writing the old way until they reload, so this
-- removes only the transition step the new client no longer needs, and keeps the rest:
--
--   * create_household now creates the family's first child itself, blank, in the same
--     transaction as the household. Onboarding then names that child. Its signature, grants, and
--     every refusal are unchanged.
--   * households_create_first_child is dropped. It ran on every households insert; with
--     create_household making the child, nothing a client can do creates a household without
--     one. (A service-role insert, e.g. seed.sql, now has to add its own child.)
--   * care_items_per_child_has_child: food, preferences, and instructions must name a child.
--     It is the reverse of slice A's care_items_family_wide_categories, so together a care item
--     belongs to a child exactly when its category is per-child. Added NOT VALID here, so this
--     file does not scan care_items while it holds its lock; the next migration validates it
--     under a lock that does not block reads or writes. New and changed rows are checked from
--     this migration on.
--
-- Kept on purpose (a later migration removes them once no old tab can be open):
--   * households_sync_first_child: an old tab saving the child's name or age still reaches the
--     first child, column by column.
--   * care_items_default_child: an old tab saving a food, preferences, or instructions item with
--     no child still files it under the first child. It also makes the new check above safe for
--     those saves: the trigger fills child_id before the check runs.
--   * public.ensure_first_child, which both triggers use.
--
-- Locks: as in 20261102000000, the file opens by taking care_items, then households, with a
-- 5 second lock timeout (55P03 and nothing changed if they are busy; rerun it). The same
-- reverse-order deadlock with delete_my_account applies (40P01: a cancelled push changed
-- nothing). Both locks are held only for the catalog changes below; nothing here scans a table.

do $$
begin
  set local lock_timeout = '5s';
  lock table public.care_items, public.households in access exclusive mode;
end;
$$;

-- Same body as 20261014000000, plus the first child. A family space always starts with one
-- child row, so the client never has to create one before showing or saving anything.
create or replace function public.create_household(household_name text, acknowledged boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  caller_email text;
  caller_name text;
  new_household_id uuid;
begin
  if caller is null then
    raise exception 'not_authenticated';
  end if;
  if acknowledged is not true then
    raise exception 'risk_not_acknowledged';
  end if;
  if exists (select 1 from public.household_members where user_id = caller) then
    raise exception 'already_member';
  end if;

  select lower(u.email),
         coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name')
    into caller_email, caller_name
    from auth.users u
   where u.id = caller;

  insert into public.households (name, created_by, risk_acknowledged_at)
  values (btrim(household_name), caller, now())
  returning id into new_household_id;

  insert into public.household_members (household_id, user_id, role, email, display_name)
  values (new_household_id, caller, 'parent', coalesce(caller_email, ''), caller_name);

  insert into public.children (household_id) values (new_household_id);

  return new_household_id;
end;
$$;

drop trigger households_create_first_child on public.households;

alter table public.care_items
  add constraint care_items_per_child_has_child check (
    child_id is not null or category not in ('food', 'preferences', 'instructions')
  ) not valid;
