-- CareNest SI-63/SI-64/SI-65: Care Log page entries (the "Current session log").
--
-- Builds on 20261016000000_carenest_care_logs.sql (frozen) and keeps every rule it set: RLS on
-- the table, explicit column grants, the stamp trigger sets the household, author, role, and time,
-- the membership check (visit_not_found), the shift window (visit_too_old), and append-only.
--
-- Decision: extend care_logs rather than add a parallel table. A Care Log entry is a care log
-- that is about a child instead of a checked task:
--   * category 'note' is new. A 'note' row has no task (task_id null) and a required note; the
--     three existing categories (meal, bottle, care) still require a task. The pairing is a CHECK
--     (care_logs_task_category), so a task-less meal/bottle/care row, or a note on a task, is
--     refused (23514). Rows written by the deployed client (task, meal/bottle/care, no child) are
--     accepted exactly as before.
--   * child_id (nullable) names the child the entry is about. A composite foreign key
--     (child_id, household_id) -> children (id, household_id) means a log can only name a child of
--     the shift's own family space (household_id is stamped from the shift by the trigger before
--     the key is checked). stamp_care_log() also checks it first and raises child_not_found, the
--     same code the appointments trigger uses. A 'note' entry needs a child (child_required) at
--     insert time; meal/bottle/care logs may name one or not.
--   * child_name is a snapshot of the child's name taken by the trigger (not insertable), like the
--     task snapshot on task_checks. Deleting a child sets child_id to null (ON DELETE SET NULL on
--     that column only) and the entry keeps the name it was written under: a log is a record of
--     what happened, so a parent removing a child does not erase past sessions.
--   * Window: a task-less entry is accepted while the shift's date is in the window, open or
--     ended, the same as a task log and the handoff note (an end-of-session recap is allowed).
--
-- Lock order on a live database: a client insert holds care_logs and then checks the foreign keys
-- (households, visits, tasks, and now children), so care_logs is locked first, then children,
-- with a 2 second lock timeout each; if a lock is not free in time the push fails cleanly (55P03)
-- with nothing changed and can be rerun.

do $$
begin
  set local lock_timeout = '2s';
  lock table public.care_logs, public.children in share row exclusive mode;
end;
$$;

-- ---------------------------------------------------------------------------
-- Columns and constraints
-- ---------------------------------------------------------------------------

alter table public.care_logs
  alter column task_id drop not null,
  add column child_id uuid,
  add column child_name text check (char_length(child_name) <= 200),
  add constraint care_logs_child_fkey foreign key (child_id, household_id)
    references public.children (id, household_id) on delete set null (child_id);

-- The inline category check of the first migration is named care_logs_category_check.
alter table public.care_logs
  drop constraint care_logs_category_check,
  add constraint care_logs_category_check
    check (category in ('meal', 'bottle', 'care', 'note')),
  -- A task log is meal/bottle/care; a Care Log page entry ('note') has no task.
  add constraint care_logs_task_category
    check ((task_id is null) = (category = 'note')),
  drop constraint care_logs_not_empty,
  add constraint care_logs_not_empty
    check (
      (category <> 'meal' or meal_amount is not null or note ~ '[^[:space:]]')
      and (category <> 'bottle' or bottle_oz is not null)
      and (category not in ('care', 'note') or note ~ '[^[:space:]]')
    );

-- Supports the ON DELETE SET NULL from children.
create index care_logs_child_id_idx on public.care_logs (child_id) where child_id is not null;

-- ---------------------------------------------------------------------------
-- Insert trigger (replaces the SI-28 version; the task path is unchanged)
-- ---------------------------------------------------------------------------

-- Error codes, in the order they are checked: not_authenticated; visit_not_found; visit_too_old;
-- for a task log: task_not_found, task_not_completed (as before); then child_not_found (the child
-- is not in the shift's family space, or does not exist) and child_required (a 'note' entry with
-- no child).
create or replace function public.stamp_care_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  caller_role text;
  visit_household_id uuid;
  visit_plan_id uuid;
  visit_day date;
  picked_child_name text;
begin
  if caller is null then
    raise exception 'not_authenticated';
  end if;

  select p.household_id, v.plan_id, v.visit_date
    into visit_household_id, visit_plan_id, visit_day
    from public.visits v
    join public.plans p on p.id = v.plan_id
   where v.id = new.visit_id
     for share of v;

  -- Visits in other households look the same as visits that do not exist.
  select m.role into caller_role
    from public.household_members m
   where m.household_id = visit_household_id and m.user_id = caller;
  if visit_household_id is null or caller_role is null then
    raise exception 'visit_not_found';
  end if;

  -- Open or ended, but only while the shift's date is in the window (same as the handoff note).
  if visit_day not between (now() at time zone 'utc')::date - 1
                       and (now() at time zone 'utc')::date + 1 then
    raise exception 'visit_too_old';
  end if;

  if new.task_id is not null then
    -- The task must belong to the shift's plan (see 20261016000000 for why this is not trusted
    -- from task_checks).
    perform 1
       from public.tasks t
      where t.id = new.task_id and t.plan_id = visit_plan_id;
    if not found then
      raise exception 'task_not_found';
    end if;

    -- The task must be checked in this shift now. The share lock waits for a concurrent uncheck.
    perform 1
       from public.task_checks c
      where c.visit_id = new.visit_id and c.task_id = new.task_id
        for share;
    if not found then
      raise exception 'task_not_completed';
    end if;
  end if;

  -- The child must be one of the shift's family space (the composite foreign key enforces the
  -- same; this gives the app a clear code). Its name is kept with the entry.
  if new.child_id is not null then
    select c.name into picked_child_name
      from public.children c
     where c.id = new.child_id and c.household_id = visit_household_id;
    if not found then
      raise exception 'child_not_found' using errcode = '23503';
    end if;
  elsif new.category = 'note' then
    raise exception 'child_required';
  end if;

  -- Whatever the client sent, these come from the server.
  new.household_id := visit_household_id;
  new.author_id := caller;
  new.author_role := caller_role;
  new.child_name := picked_child_name;
  new.created_at := clock_timestamp();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: the client may now also send child_id. child_name, like the author columns, is
-- set only by the trigger. stamp_care_log() is a trigger function and needs no EXECUTE grant.
-- ---------------------------------------------------------------------------

grant insert (child_id) on public.care_logs to authenticated;
