-- CareNest: a family can have several children (SI-45, slice A of 3).
--
-- Until now the child was two columns on households. This adds the data model for several
-- children, additively: the live site and old tabs keep writing households.child_name,
-- child_age_label, and care_items with no child id, and those writes keep working unchanged.
--
--   * public.children: one row per child, in one household. Members read; parents insert,
--     update, and delete. Select, insert, and update are granted by column, so a future column
--     starts closed; delete is table-level, since Postgres has no column delete. household_id,
--     id, and created_at are not client-writable: a child never moves to another family.
--     unique (id, household_id) is the target of the composite foreign key below. Realtime DELETE
--     events are not RLS-filtered (README known limitation): a delete emits one random UUID and
--     no content.
--   * Backfill: exactly one child per household, including blank ones, from child_name and
--     child_age_label. A family's food, preferences, and instructions move to that child.
--     Where things are, contacts, emergency steps, schedule, and shifts stay family-wide.
--   * public.care_items.child_id: nullable, and the composite foreign key (child_id, household_id)
--     means a care item can only point at a child of its own household. Parents already have
--     table-level insert and update on care_items, so no new grant is needed; moving an item to
--     another household stays refused by the existing with check (is_parent), and pointing it
--     at another family's child is refused by the foreign key (23503). The check constraint
--     keeps family-wide categories family-wide. Deleting a child deletes that child's items.
--   * public.households.home_address: optional, parents write it (a column grant under the
--     existing update policy), and only current members read it (the existing select policy,
--     so a removed sitter loses access as soon as their membership row is gone).
--   * public.contacts.is_primary: at most one primary contact per household (partial unique
--     index). The existing table grant and parent-only policies already cover the new column.
--
-- TRANSITIONAL (slice C removes these three triggers and public.ensure_first_child): the old
-- client has no idea children exist, so
--   * a new household gets a first child (households_create_first_child),
--   * a change to households.child_name or child_age_label copies that column to the first child,
--     the lowest position (households_sync_first_child),
--   * a food, preferences, or instructions item saved with no child goes to the first child
--     (care_items_default_child).
-- If a parent has deleted every child, the next such write creates a new first child. In a race
-- with the delete of the last child, an old tab's care item save gets a visible error and a retry
-- works; a name or age save stays on the household's columns, which seed the next first child.
--
-- Order matters on a live database. `db push` sends the file as one implicit transaction, and the
-- first statement sets a 5 second lock timeout and locks care_items, contacts, and households, in
-- that order. It is a DO block because that kind of transaction refuses a top-level LOCK TABLE
-- (25P01). The locks still last until commit. Child tables come first because a client write holds
-- its own table and then waits on households for the foreign key check, so taking households first
-- deadlocks with that write. If a lock is not free in 5 seconds the push fails cleanly (55P03) with
-- nothing changed, and it can be rerun. Once held, these locks block reads and writes on all three
-- tables until commit, and so also the foreign key check of a write to any table that references
-- households. The triggers exist before the backfill, so no write can land between them.
--
-- Deliberately not changed here (slice B): household_members_one_household_per_user,
-- create_household, accept_invite.

do $$
begin
  set local lock_timeout = '5s';
  lock table public.care_items, public.contacts, public.households in access exclusive mode;
end;
$$;

-- ---------------------------------------------------------------------------
-- Home address and primary contact
-- ---------------------------------------------------------------------------

alter table public.households
  add column home_address text check (char_length(home_address) <= 200);

grant update (home_address) on public.households to authenticated;

alter table public.contacts
  add column is_primary boolean not null default false;

create unique index contacts_one_primary_per_household
  on public.contacts (household_id)
  where is_primary;

-- ---------------------------------------------------------------------------
-- Children
-- ---------------------------------------------------------------------------

create table public.children (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  name text not null default '' check (char_length(name) <= 80),
  age_label text not null default '' check (char_length(age_label) <= 40),
  -- e.g. "Preschooler".
  stage_label text not null default '' check (char_length(stage_label) <= 40),
  -- e.g. "Currently recovering from a cold".
  pinned_note text not null default '' check (char_length(pinned_note) <= 200),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  unique (id, household_id)
);

create index children_household_position_idx on public.children (household_id, position);

alter table public.children enable row level security;

create policy "Members can read children"
  on public.children for select to authenticated
  using (public.is_member(household_id));

create policy "Parents can create children"
  on public.children for insert to authenticated
  with check (public.is_parent(household_id));

create policy "Parents can update children"
  on public.children for update to authenticated
  using (public.is_parent(household_id))
  with check (public.is_parent(household_id));

create policy "Parents can delete children"
  on public.children for delete to authenticated
  using (public.is_parent(household_id));

grant select (id, household_id, name, age_label, stage_label, pinned_note, position, created_at)
  on public.children to authenticated;
grant insert (household_id, name, age_label, stage_label, pinned_note, position)
  on public.children to authenticated;
grant update (name, age_label, stage_label, pinned_note, position)
  on public.children to authenticated;
grant delete on public.children to authenticated;

alter publication supabase_realtime add table public.children;

-- ---------------------------------------------------------------------------
-- Transition: keep the old client's writes correct (slice C removes this section)
-- ---------------------------------------------------------------------------

-- The household's first child: lowest position, then oldest, with id as the final tie-break so
-- every caller agrees. Creates one from the household's own columns if none exists. The lock
-- makes two concurrent old-client writes create one child, not two; a direct insert into children
-- does not take it. Runs only inside the triggers below and the care item backfill; no client role
-- can execute it.
create function public.ensure_first_child(target_household_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  child_id uuid;
begin
  select c.id into child_id
    from public.children c
   where c.household_id = target_household_id
   order by c.position, c.created_at, c.id
   limit 1;
  if found then
    return child_id;
  end if;

  perform 1 from public.households h where h.id = target_household_id for no key update;
  if not found then
    -- No such household: the caller's foreign key refuses the row.
    return null;
  end if;

  -- Re-read: another transaction may have created the child while this one waited for the lock.
  select c.id into child_id
    from public.children c
   where c.household_id = target_household_id
   order by c.position, c.created_at, c.id
   limit 1;
  if found then
    return child_id;
  end if;

  insert into public.children (household_id, name, age_label)
  select h.id, h.child_name, h.child_age_label
    from public.households h
   where h.id = target_household_id
  returning id into child_id;
  return child_id;
end;
$$;

revoke all on function public.ensure_first_child(uuid) from public;

-- Security definer so an old-client save does not depend on the caller's grants on children; it
-- touches only the household being written, which RLS has already allowed the caller to update.
-- Copies only the column that changed: an old tab sends both, so copying both would undo a direct
-- edit of whichever one the parent left alone.
create function public.sync_first_child()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  first_child_id uuid := public.ensure_first_child(new.id);
begin
  -- On insert, ensure_first_child has just created the child from these same columns.
  if tg_op = 'UPDATE' then
    update public.children
       set name = case when old.child_name is distinct from new.child_name
                       then new.child_name else name end,
           age_label = case when old.child_age_label is distinct from new.child_age_label
                            then new.child_age_label else age_label end
     where id = first_child_id;
  end if;
  return null;
end;
$$;

revoke all on function public.sync_first_child() from public;

create trigger households_create_first_child
  after insert on public.households
  for each row execute function public.sync_first_child();

-- The old client sends child_name and child_age_label together on every save, changed or not, so
-- the WHEN guard keeps a resubmitted form from running the copy at all. That matters most in a
-- family with no children, where a save that changed nothing must not create one.
create trigger households_sync_first_child
  after update of child_name, child_age_label on public.households
  for each row
  when (old.child_name is distinct from new.child_name
        or old.child_age_label is distinct from new.child_age_label)
  execute function public.sync_first_child();

-- SI-45 backfill: children start
insert into public.children (household_id, name, age_label)
select h.id, h.child_name, h.child_age_label
  from public.households h
 where not exists (select 1 from public.children c where c.household_id = h.id);
-- SI-45 backfill: children end

-- ---------------------------------------------------------------------------
-- Care items belong to a child, by category
-- ---------------------------------------------------------------------------

alter table public.care_items
  add column child_id uuid,
  add constraint care_items_child_fkey foreign key (child_id, household_id)
    references public.children (id, household_id) on delete cascade,
  add constraint care_items_family_wide_categories check (
    child_id is null or category in ('food', 'preferences', 'instructions')
  );

create index care_items_child_id_idx on public.care_items (child_id) where child_id is not null;

-- Runs before the insert policy's with check, so a caller from another family gets the same
-- refusal as before. Update of category or child_id is covered too: an item that moves into a
-- per-child category, or has its child cleared, must not stay ownerless.
create function public.default_care_item_child()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.child_id is null and new.category in ('food', 'preferences', 'instructions') then
    new.child_id := public.ensure_first_child(new.household_id);
  end if;
  return new;
end;
$$;

revoke all on function public.default_care_item_child() from public;

create trigger care_items_default_child
  before insert or update of category, child_id on public.care_items
  for each row execute function public.default_care_item_child();

-- SI-45 backfill: care items start
update public.care_items i
   set child_id = public.ensure_first_child(i.household_id)
 where i.child_id is null
   and i.category in ('food', 'preferences', 'instructions');
-- SI-45 backfill: care items end
