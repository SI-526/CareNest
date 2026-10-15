-- CareNest SI-28: care logs ("Logging Care Details").
--
-- Builds on 20261014000000_carenest_schema.sql and 20261015000000_carenest_photos_messages.sql
-- and keeps their rules: RLS on every table, explicit minimal grants (new tables and functions
-- start closed), SECURITY DEFINER functions with a fixed empty search_path.
--
--   * care_logs: after a task is completed in a shift, a member (sitter or parent) attaches a
--     structured log to it: `meal` (what the child ate: optional amount all/most/some/none
--     and/or a note), `bottle` (ounces required, optional note), or `care` (any other care
--     activity; note required). An empty entry is refused by CHECK constraints.
--   * Append-only: an edit is a new row under the same task. Clients never update or delete a
--     log, and logging never touches the task's check (task_checks keeps its own time).
--   * A log is accepted only while the shift's date is in the window (database UTC date ±1),
--     whether the shift is open or ended (an end-of-session recap, like the handoff note), and
--     only for a task of the shift's plan that is checked in that shift at insert time. The author, the author's
--     role, the household, and the time are set by the database, whatever the client sent.
--   * Members of the household read every log of their household; nobody else does.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

-- One structured care entry about a completed task in a shift. Written only by members through
-- a plain insert (column grants below); stamp_care_log() fills household_id, author_id,
-- author_role, and created_at and enforces the rules that need other rows (membership, the date
-- window, and the task's check). There is no foreign key to task_checks: a log is a record of
-- what happened, so a later uncheck leaves it in place (the share lock in the trigger only
-- serialises the insert with a concurrent uncheck). Append-only: members have no UPDATE or
-- DELETE privilege; "editing" is a new row, and the app lists every log of a task oldest first
-- (later ones labelled "Update").
-- created_at uses clock_timestamp(), taken after the trigger holds its locks, so time order
-- matches the order the logs landed. A deleted member's logs stay with author_id null ("a former
-- member"). task_id has no cascade, for the same reason as task_checks: a logged task can never
-- be deleted out from under its history; deferred to commit so deleting a whole family space
-- (delete_my_account), whose shifts cascade these logs away in the same transaction, still works.
create table public.care_logs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  visit_id uuid not null references public.visits (id) on delete cascade,
  task_id uuid not null references public.tasks (id) on delete no action
    deferrable initially deferred,
  category text not null check (category in ('meal', 'bottle', 'care')),
  note text not null default '' check (char_length(note) <= 1000),
  meal_amount text,
  -- numeric(3, 1) rounds the value to 0.1 on input, before any CHECK runs: 16.04 is stored and
  -- checked as 16.0 (accepted), 16.05 as 16.1 (refused), 0.04 as 0.0 (refused). The client
  -- rounds to 0.1 too, so what the sitter sees is what is stored.
  bottle_oz numeric(3, 1),
  author_id uuid references auth.users (id) on delete set null,
  author_role text not null check (author_role in ('parent', 'caretaker')),
  created_at timestamptz not null default clock_timestamp(),
  constraint care_logs_meal_amount_check
    check (meal_amount is null
           or (category = 'meal' and meal_amount in ('all', 'most', 'some', 'none'))),
  constraint care_logs_bottle_oz_check
    check (bottle_oz is null or (category = 'bottle' and bottle_oz > 0 and bottle_oz <= 16)),
  -- "No information provided": a note counts only if it has a non-whitespace character.
  constraint care_logs_not_empty
    check (
      (category <> 'meal' or meal_amount is not null or note ~ '[^[:space:]]')
      and (category <> 'bottle' or bottle_oz is not null)
      and (category <> 'care' or note ~ '[^[:space:]]')
    )
);

create index care_logs_visit_id_idx on public.care_logs (visit_id, created_at);
create index care_logs_task_id_idx on public.care_logs (task_id);
-- Supports the ON DELETE CASCADE from households and household-scoped reads in time order.
create index care_logs_household_id_idx on public.care_logs (household_id, created_at);

-- ---------------------------------------------------------------------------
-- Insert trigger
-- ---------------------------------------------------------------------------

-- Stamps the server-controlled columns of every new care log and enforces the rules that need
-- other rows. Runs as the owner so it can read the visit, the membership, and the check. It
-- needs no EXECUTE grant: trigger functions are not checked for EXECUTE when they fire.
-- Every insert needs a signed-in member (the service role has no auth.uid() and is refused too).
-- Error codes, in the order they are checked: not_authenticated; visit_not_found (no such shift,
-- or a shift in another household: the two look the same, as in complete_task, end_visit, and
-- reopen_visit, so a log attempt cannot probe for shifts of other families); visit_too_old;
-- task_not_found (the task is not in the shift's plan, as in complete_task, whether it exists
-- elsewhere or not); task_not_completed (the task is not checked in this shift right now).
create function public.stamp_care_log()
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

  -- The task must belong to the shift's plan. task_checks has no such constraint (a row written
  -- by the service role or the superuser could pair a shift with another family's task), so it
  -- is checked here rather than trusted from the check below.
  perform 1
     from public.tasks t
    where t.id = new.task_id and t.plan_id = visit_plan_id;
  if not found then
    raise exception 'task_not_found';
  end if;

  -- The task must be checked in this shift now. The share lock waits for a concurrent uncheck
  -- (which holds the row for its delete) and then sees that the row is gone.
  perform 1
     from public.task_checks c
    where c.visit_id = new.visit_id and c.task_id = new.task_id
      for share;
  if not found then
    raise exception 'task_not_completed';
  end if;

  -- Whatever the client sent, these come from the server.
  new.household_id := visit_household_id;
  new.author_id := caller;
  new.author_role := caller_role;
  new.created_at := clock_timestamp();
  return new;
end;
$$;

create trigger care_logs_stamp
  before insert on public.care_logs
  for each row execute function public.stamp_care_log();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.care_logs enable row level security;

-- Members read every log of their household; members add logs (column grants + stamp_care_log).
-- No UPDATE or DELETE policy (and no privilege): logs are append-only for clients.
create policy "Members can read care logs"
  on public.care_logs for select to authenticated
  using (public.is_member(household_id));

create policy "Members can add care logs"
  on public.care_logs for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and public.is_member(household_id)
  );

-- ---------------------------------------------------------------------------
-- Privileges (new tables and functions start closed; grant exactly what the app needs).
-- is_member() is already granted to authenticated by the first migration; stamp_care_log() is a
-- trigger function and needs no grant. Nothing to anon.
-- ---------------------------------------------------------------------------

grant all on public.care_logs to service_role;

grant select on public.care_logs to authenticated;
grant insert (visit_id, task_id, category, note, meal_amount, bottle_oz)
  on public.care_logs to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: new logs stream to household members (RLS applies). Logs are never deleted by
-- clients; they go only with their household, plan, or shift (see README for the known
-- DELETE-event limitation).
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.care_logs;
