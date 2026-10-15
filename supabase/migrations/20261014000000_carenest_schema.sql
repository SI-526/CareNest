-- CareNest schema: households (family spaces with one child), members, email-bound invites,
-- care info (care_items, contacts), the day's schedule (plans, tasks), babysitting shifts
-- (visits), and task checks.
--
-- Ported from Carekeeper's schema; every security property is kept:
--   * Row Level Security is enabled on every table; with no matching policy, access is denied.
--   * anon gets no table privileges and cannot execute any function in public.
--   * authenticated gets only the table/column privileges the app needs; RLS narrows rows.
--   * Households, memberships, and invites are created only through SECURITY DEFINER RPCs,
--     each with a fixed empty search_path.
--   * Invite tokens are random 256-bit values; only their SHA-256 hash is stored.
-- Added for CareNest:
--   * Future tables, sequences, and functions in public start with no anon/authenticated
--     privileges (schema-scoped default privileges revoked), and functions that postgres creates
--     later in ANY schema no longer get Postgres's built-in EXECUTE for PUBLIC (global default
--     privilege revoked). A later migration must grant access explicitly.
--   * A shift can only be started for yesterday, today, or tomorrow (database date, UTC on
--     Supabase), and only a parent can reopen an ended shift (reopen_visit).

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  child_name text not null default '' check (char_length(child_name) <= 80),
  child_age_label text not null default '' check (char_length(child_age_label) <= 40),
  created_by uuid references auth.users (id) on delete set null,
  risk_acknowledged_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('parent', 'caretaker')),
  email text not null,
  display_name text,
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

-- Deliberate simplification: each user belongs to at most one household.
create unique index household_members_one_household_per_user
  on public.household_members (user_id);

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  email text not null check (email = lower(email) and char_length(email) between 3 and 320),
  token_hash text not null unique,
  created_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index invites_household_id_idx on public.invites (household_id);

-- Care info shown on the "Things to know" screens. Severity applies to food/allergy items only.
create table public.care_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  category text not null
    check (category in ('preferences', 'where', 'instructions', 'emergency', 'food')),
  title text not null check (char_length(btrim(title)) between 1 and 140),
  detail text not null default '' check (char_length(detail) <= 2000),
  severity text check (severity in ('Mild', 'Moderate', 'Severe')),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  check (severity is null or category = 'food')
);

create index care_items_household_category_idx
  on public.care_items (household_id, category, position);

-- People (and places, such as the hospital) the sitter may need to call.
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  role text not null default '' check (char_length(role) <= 40),
  phone text not null default '' check (char_length(phone) <= 40),
  address text not null default '' check (char_length(address) <= 200),
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create index contacts_household_id_idx on public.contacts (household_id, position);

-- A plan is the child's day: an ordered list of tasks. `schedule` is a display label
-- for the usual shift window (e.g. "3:00pm - 7:00pm").
create table public.plans (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 80),
  schedule text not null default '' check (char_length(schedule) <= 100),
  note text not null default '' check (char_length(note) <= 2000),
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create index plans_household_id_idx on public.plans (household_id);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 140),
  time_of_day time,
  detail text not null default '' check (char_length(detail) <= 1000),
  location text not null default '' check (char_length(location) <= 200),
  care_note text not null default '' check (char_length(care_note) <= 1000),
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create index tasks_plan_id_idx on public.tasks (plan_id);

-- A visit is one babysitting shift for a plan on a date. It ends once, through end_visit().
create table public.visits (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans (id) on delete cascade,
  visit_date date not null default current_date,
  started_by uuid default auth.uid() references auth.users (id) on delete set null,
  started_at timestamptz not null default now(),
  ended_by uuid references auth.users (id) on delete set null,
  ended_at timestamptz,
  handoff_note text not null default '' check (char_length(handoff_note) <= 3000),
  handoff_by uuid references auth.users (id) on delete set null,
  handoff_at timestamptz,
  unique (plan_id, visit_date),
  check (ended_at is null or ended_at >= started_at)
);

create table public.task_checks (
  visit_id uuid not null references public.visits (id) on delete cascade,
  task_id uuid not null references public.tasks (id) on delete cascade,
  checked_by uuid default auth.uid() references auth.users (id) on delete set null,
  checked_at timestamptz not null default now(),
  primary key (visit_id, task_id)
);

create index task_checks_task_id_idx on public.task_checks (task_id);

-- ---------------------------------------------------------------------------
-- Helper functions used by policies
-- ---------------------------------------------------------------------------

create function public.is_member(target_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.household_members m
    where m.household_id = target_household_id
      and m.user_id = (select auth.uid())
  );
$$;

create function public.is_parent(target_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.household_members m
    where m.household_id = target_household_id
      and m.user_id = (select auth.uid())
      and m.role = 'parent'
  );
$$;

-- Records who wrote the handoff note and when, whatever the client sends.
create function public.stamp_handoff()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.handoff_note is distinct from old.handoff_note then
    new.handoff_by := auth.uid();
    new.handoff_at := now();
  end if;
  return new;
end;
$$;

create trigger visits_stamp_handoff
  before update on public.visits
  for each row execute function public.stamp_handoff();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.invites enable row level security;
alter table public.care_items enable row level security;
alter table public.contacts enable row level security;
alter table public.plans enable row level security;
alter table public.tasks enable row level security;
alter table public.visits enable row level security;
alter table public.task_checks enable row level security;

-- households: members read; parents edit the name and child fields (column grants);
-- creation and deletion go through RPCs.
create policy "Members can read their household"
  on public.households for select to authenticated
  using (public.is_member(id));

create policy "Parents can update their household"
  on public.households for update to authenticated
  using (public.is_parent(id))
  with check (public.is_parent(id));

-- household_members: members read their household's roster; parents remove caretakers.
create policy "Members can read their household roster"
  on public.household_members for select to authenticated
  using (public.is_member(household_id));

create policy "Parents can remove caretakers"
  on public.household_members for delete to authenticated
  using (role = 'caretaker' and public.is_parent(household_id));

-- invites: parents read and revoke; creation and acceptance go through RPCs.
create policy "Parents can read invites"
  on public.invites for select to authenticated
  using (public.is_parent(household_id));

create policy "Parents can revoke pending invites"
  on public.invites for update to authenticated
  using (public.is_parent(household_id) and accepted_at is null)
  with check (public.is_parent(household_id) and revoked_at is not null);

-- care_items: members read; parents write.
create policy "Members can read care items"
  on public.care_items for select to authenticated
  using (public.is_member(household_id));

create policy "Parents can create care items"
  on public.care_items for insert to authenticated
  with check (public.is_parent(household_id));

create policy "Parents can update care items"
  on public.care_items for update to authenticated
  using (public.is_parent(household_id))
  with check (public.is_parent(household_id));

create policy "Parents can delete care items"
  on public.care_items for delete to authenticated
  using (public.is_parent(household_id));

-- contacts: members read; parents write.
create policy "Members can read contacts"
  on public.contacts for select to authenticated
  using (public.is_member(household_id));

create policy "Parents can create contacts"
  on public.contacts for insert to authenticated
  with check (public.is_parent(household_id));

create policy "Parents can update contacts"
  on public.contacts for update to authenticated
  using (public.is_parent(household_id))
  with check (public.is_parent(household_id));

create policy "Parents can delete contacts"
  on public.contacts for delete to authenticated
  using (public.is_parent(household_id));

-- plans: members read; parents write.
create policy "Members can read plans"
  on public.plans for select to authenticated
  using (public.is_member(household_id));

create policy "Parents can create plans"
  on public.plans for insert to authenticated
  with check (public.is_parent(household_id));

create policy "Parents can update plans"
  on public.plans for update to authenticated
  using (public.is_parent(household_id))
  with check (public.is_parent(household_id));

create policy "Parents can delete plans"
  on public.plans for delete to authenticated
  using (public.is_parent(household_id));

-- tasks: members read; parents write.
create policy "Members can read tasks"
  on public.tasks for select to authenticated
  using (exists (
    select 1 from public.plans p
    where p.id = tasks.plan_id and public.is_member(p.household_id)
  ));

create policy "Parents can create tasks"
  on public.tasks for insert to authenticated
  with check (exists (
    select 1 from public.plans p
    where p.id = tasks.plan_id and public.is_parent(p.household_id)
  ));

create policy "Parents can update tasks"
  on public.tasks for update to authenticated
  using (exists (
    select 1 from public.plans p
    where p.id = tasks.plan_id and public.is_parent(p.household_id)
  ))
  with check (exists (
    select 1 from public.plans p
    where p.id = tasks.plan_id and public.is_parent(p.household_id)
  ));

create policy "Parents can delete tasks"
  on public.tasks for delete to authenticated
  using (exists (
    select 1 from public.plans p
    where p.id = tasks.plan_id and public.is_parent(p.household_id)
  ));

-- visits: members read, start, and write the handoff note (column grants limit updates;
-- ending a shift goes through end_visit(), reopening through reopen_visit()). A shift can be
-- started only for yesterday, today, or tomorrow, so a client cannot claim (and, by ending
-- it, block) a plan's far-future or past dates.
create policy "Members can read visits"
  on public.visits for select to authenticated
  using (exists (
    select 1 from public.plans p
    where p.id = visits.plan_id and public.is_member(p.household_id)
  ));

create policy "Members can start visits"
  on public.visits for insert to authenticated
  with check (
    started_by = (select auth.uid())
    and visit_date between current_date - 1 and current_date + 1
    and exists (
      select 1 from public.plans p
      where p.id = visits.plan_id and public.is_member(p.household_id)
    )
  );

create policy "Members can write handoff notes"
  on public.visits for update to authenticated
  using (exists (
    select 1 from public.plans p
    where p.id = visits.plan_id and public.is_member(p.household_id)
  ))
  with check (exists (
    select 1 from public.plans p
    where p.id = visits.plan_id and public.is_member(p.household_id)
  ));

-- task_checks: members read; while the shift is open, members check (as themselves) and
-- uncheck tasks. Once a shift has ended its checks are frozen.
create policy "Members can read task checks"
  on public.task_checks for select to authenticated
  using (exists (
    select 1 from public.visits v
    join public.plans p on p.id = v.plan_id
    where v.id = task_checks.visit_id and public.is_member(p.household_id)
  ));

create policy "Members can check tasks"
  on public.task_checks for insert to authenticated
  with check (
    checked_by = (select auth.uid())
    and exists (
      select 1 from public.visits v
      join public.tasks t on t.plan_id = v.plan_id
      join public.plans p on p.id = v.plan_id
      where v.id = task_checks.visit_id
        and t.id = task_checks.task_id
        and v.ended_at is null
        and public.is_member(p.household_id)
    )
  );

create policy "Members can uncheck tasks"
  on public.task_checks for delete to authenticated
  using (exists (
    select 1 from public.visits v
    join public.plans p on p.id = v.plan_id
    where v.id = task_checks.visit_id
      and v.ended_at is null
      and public.is_member(p.household_id)
  ));

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

create function public.create_household(household_name text, acknowledged boolean)
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

  return new_household_id;
end;
$$;

-- Returns the plain invite token once; only its SHA-256 hash is stored.
create function public.create_invite(target_household_id uuid, invite_email text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_email text := lower(btrim(invite_email));
  token text;
begin
  if not public.is_parent(target_household_id) then
    raise exception 'not_parent';
  end if;
  if normalized_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid_email';
  end if;
  if exists (
    select 1 from public.household_members
    where household_id = target_household_id and email = normalized_email
  ) then
    raise exception 'already_member';
  end if;

  -- Replace any pending invite for the same person so only the newest link works.
  update public.invites
     set revoked_at = now()
   where household_id = target_household_id
     and email = normalized_email
     and accepted_at is null
     and revoked_at is null;

  token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.invites (household_id, email, token_hash, created_by)
  values (
    target_household_id,
    normalized_email,
    encode(sha256(convert_to(token, 'UTF8')), 'hex'),
    auth.uid()
  );

  return token;
end;
$$;

create function public.accept_invite(invite_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  caller_email text := lower(auth.jwt() ->> 'email');
  caller_name text;
  invite public.invites;
begin
  if caller is null then
    raise exception 'not_authenticated';
  end if;

  select * into invite
    from public.invites
   where token_hash = encode(sha256(convert_to(coalesce(invite_token, ''), 'UTF8')), 'hex')
   for update;

  if not found then
    raise exception 'invite_not_found';
  elsif invite.revoked_at is not null then
    raise exception 'invite_revoked';
  elsif invite.accepted_at is not null then
    raise exception 'invite_used';
  elsif invite.expires_at <= now() then
    raise exception 'invite_expired';
  end if;

  -- The signed-in account must own the invited address and have it verified.
  if caller_email is distinct from invite.email or not exists (
    select 1 from auth.users u
    where u.id = caller and u.email_confirmed_at is not null
  ) then
    raise exception 'invite_wrong_email';
  end if;

  if exists (select 1 from public.household_members where user_id = caller) then
    raise exception 'already_member';
  end if;

  select coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name')
    into caller_name
    from auth.users u
   where u.id = caller;

  insert into public.household_members (household_id, user_id, role, email, display_name)
  values (invite.household_id, caller, 'caretaker', caller_email, caller_name);

  update public.invites
     set accepted_at = now(), accepted_by = caller
   where id = invite.id;

  return invite.household_id;
end;
$$;

-- Ends a shift once. Any member of the household (parent or sitter) may end it; who and when
-- are recorded server-side. Returns the end time.
create function public.end_visit(target_visit_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  visit_household_id uuid;
  already_ended_at timestamptz;
  result timestamptz;
begin
  if caller is null then
    raise exception 'not_authenticated';
  end if;

  select p.household_id, v.ended_at
    into visit_household_id, already_ended_at
    from public.visits v
    join public.plans p on p.id = v.plan_id
   where v.id = target_visit_id
   for update of v;

  -- Visits in other households look the same as visits that do not exist.
  if not found or not public.is_member(visit_household_id) then
    raise exception 'visit_not_found';
  end if;
  if already_ended_at is not null then
    raise exception 'visit_already_ended';
  end if;

  update public.visits
     set ended_at = greatest(now(), started_at), ended_by = caller
   where id = target_visit_id
  returning ended_at into result;

  return result;
end;
$$;

-- Reopens an ended shift so its tasks can be checked again (e.g. a sitter ended it by mistake).
-- Parents only; the handoff note and existing checks are kept.
create function public.reopen_visit(target_visit_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  visit_household_id uuid;
  current_ended_at timestamptz;
begin
  if caller is null then
    raise exception 'not_authenticated';
  end if;

  select p.household_id, v.ended_at
    into visit_household_id, current_ended_at
    from public.visits v
    join public.plans p on p.id = v.plan_id
   where v.id = target_visit_id
   for update of v;

  -- Visits in other households look the same as visits that do not exist.
  if not found or not public.is_member(visit_household_id) then
    raise exception 'visit_not_found';
  end if;
  if not public.is_parent(visit_household_id) then
    raise exception 'not_parent';
  end if;
  if current_ended_at is null then
    raise exception 'visit_not_ended';
  end if;

  update public.visits
     set ended_at = null, ended_by = null
   where id = target_visit_id;
end;
$$;

-- Deletes households where the caller is the only parent (cascading all their data),
-- the caller's remaining memberships, and finally the caller's auth account.
create function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception 'not_authenticated';
  end if;

  delete from public.households h
   where exists (
           select 1 from public.household_members m
           where m.household_id = h.id and m.user_id = caller and m.role = 'parent'
         )
     and not exists (
           select 1 from public.household_members m
           where m.household_id = h.id and m.user_id <> caller and m.role = 'parent'
         );

  delete from public.household_members where user_id = caller;
  delete from auth.users where id = caller;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges (explicit, so they do not depend on the project's default grants)
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;
grant all on all tables in schema public to service_role;

grant select on all tables in schema public to authenticated;
grant update (name, child_name, child_age_label) on public.households to authenticated;
grant insert, update, delete on public.care_items, public.contacts to authenticated;
grant insert, update, delete on public.plans, public.tasks to authenticated;
grant insert (plan_id, visit_date) on public.visits to authenticated;
grant update (handoff_note) on public.visits to authenticated;
grant insert (visit_id, task_id), delete on public.task_checks to authenticated;
grant update (revoked_at) on public.invites to authenticated;
grant delete on public.household_members to authenticated;

revoke execute on all functions in schema public from public, anon;
revoke execute on function public.reopen_visit(uuid) from public, anon;
grant execute on function
  public.is_member(uuid),
  public.is_parent(uuid),
  public.create_household(text, boolean),
  public.create_invite(uuid, text),
  public.accept_invite(text),
  public.end_visit(uuid),
  public.reopen_visit(uuid),
  public.delete_my_account()
to authenticated;

-- Objects created by later migrations start closed: no anon/authenticated access until a
-- migration grants it explicitly (service_role keeps Supabase's default).
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;
-- EXECUTE for PUBLIC is a built-in default that applies in every schema, so a schema-scoped
-- revoke cannot remove it (it is a no-op). This global revoke does: every function postgres
-- creates from here on, in any schema, needs an explicit grant to be callable by other roles.
alter default privileges for role postgres
  revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Realtime: shifts and checks stream to household members (RLS applies).
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.visits, public.task_checks;
