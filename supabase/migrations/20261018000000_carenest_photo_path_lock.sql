-- CareNest: close the photo removal re-attach race.
--
-- stamp_message() checked removed_photos against its snapshot. While remove_photo() was
-- committing, an insert re-using the path passed that check, waited on the photo_path unique
-- index, and then took the path once the removal committed: the photo stayed unreadable, but
-- the parent's Storage delete was refused because a message used it. Now stamp_message(),
-- remove_photo() and remove_all_photos() take a per-path advisory lock (held to the end of the
-- transaction) before they check or remove a path, so the check runs after a removal commits.
-- The bodies are the current ones (stamp_message and remove_photo from 20261017,
-- remove_all_photos from 20261015) plus the lock. Grants and the trigger are kept by
-- create or replace.

create or replace function public.stamp_message()
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
  visit_ended_at timestamptz;
  visit_day date;
  visit_moment_at timestamptz;
  parent_kind text;
  parent_household_id uuid;
  photo_created_at timestamptz;
  -- Live photo messages a shift takes. can_upload_photo() adds the same 20 to the folder cap,
  -- so change both together.
  photo_message_cap constant int := 20;
begin
  if caller is null then
    raise exception 'not_authenticated';
  end if;

  select m.role into caller_role
    from public.household_members m
   where m.household_id = new.household_id and m.user_id = caller;
  if not found then
    raise exception 'household_not_found';
  end if;

  -- Whatever the client sent, these come from the server.
  new.sender_id := caller;
  new.sender_role := caller_role;
  new.created_at := now();
  new.late := false;
  new.photo_removed_by := null;
  new.photo_removed_at := null;

  -- Photo messages are the sitter's way to share a photo (the gallery's "+").
  if new.kind = 'chat' and new.photo_path is not null and caller_role <> 'caretaker' then
    raise exception 'not_caretaker';
  end if;

  if new.visit_id is not null then
    -- The share lock waits for a concurrent end_visit() (which holds the row for update) and
    -- then reads the committed end, so a proof or moment cannot slip in after the end.
    select p.household_id, v.plan_id, v.ended_at, v.visit_date, v.moment_at
      into visit_household_id, visit_plan_id, visit_ended_at, visit_day, visit_moment_at
      from public.visits v
      join public.plans p on p.id = v.plan_id
     where v.id = new.visit_id
       for share of v;
    if not found or visit_household_id <> new.household_id then
      raise exception 'visit_not_found';
    end if;
  end if;

  if new.kind in ('task_proof', 'moment') or new.photo_path is not null then
    if new.visit_id is null then
      raise exception 'visit_not_found';
    end if;
    if visit_ended_at is not null then
      raise exception 'visit_ended';
    end if;
    if visit_day not between (now() at time zone 'utc')::date - 1
                         and (now() at time zone 'utc')::date + 1 then
      raise exception 'visit_too_old';
    end if;
    -- A photo a parent removed is never attached again. The path lock waits for a concurrent
    -- remove_photo() or remove_all_photos() (which take it before removing), so the check
    -- below reads the committed removal instead of this statement's older snapshot.
    if new.photo_path is not null then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('carenest:photo_path:' || new.photo_path, 0));
    end if;
    if exists (select 1 from public.removed_photos r where r.path = new.photo_path) then
      raise exception 'photo_removed';
    end if;
    -- The photo must exist, uploaded by the sender, in this household/visit folder (the path
    -- check constraint ties the folder to household_id and visit_id). Storage stamps
    -- created_at (column default now(), not client-settable) when the object is uploaded.
    select o.created_at into photo_created_at
      from storage.objects o
     where o.bucket_id = 'photos'
       and o.name = new.photo_path
       and o.owner_id = caller::text;
    if not found then
      raise exception 'photo_not_found';
    end if;
  end if;

  -- At most photo_message_cap live photo messages per shift (a removed one frees room). The
  -- visit's share lock does not serialize two inserts, so a per-visit advisory lock (held to the
  -- end of the transaction) makes the count and the insert one step.
  if new.kind = 'chat' and new.photo_path is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('carenest:photo_msgs:' || new.visit_id::text, 0));
    if (select count(*) from public.messages m
         where m.visit_id = new.visit_id and m.kind = 'chat' and m.photo_path is not null)
       >= photo_message_cap then
      raise exception 'photo_limit_reached';
    end if;
  end if;

  if new.kind = 'task_proof' then
    if new.task_id is null or not exists (
      select 1 from public.tasks t where t.id = new.task_id and t.plan_id = visit_plan_id
    ) then
      raise exception 'task_not_found';
    end if;
  elsif new.kind = 'moment' then
    if caller_role <> 'caretaker' then
      raise exception 'not_caretaker';
    end if;
    if now() < visit_moment_at then
      raise exception 'moment_not_due';
    end if;
    if exists (
      select 1 from public.messages m where m.visit_id = new.visit_id and m.kind = 'moment'
    ) then
      raise exception 'moment_already_posted';
    end if;
    -- BeReal-style: the moment's photo is taken after the prompt, not picked from earlier ones.
    if photo_created_at < visit_moment_at then
      raise exception 'moment_photo_too_early';
    end if;
    new.late := now() > visit_moment_at + interval '2 minutes';
  end if;

  -- Replies point at a photo (proof or moment) in the same household.
  if new.reply_to is not null then
    select m.kind, m.household_id into parent_kind, parent_household_id
      from public.messages m
     where m.id = new.reply_to;
    if not found
       or parent_household_id <> new.household_id
       or parent_kind not in ('task_proof', 'moment') then
      raise exception 'reply_not_found';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.remove_photo(target_message_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  message_household_id uuid;
  old_path text;
begin
  if caller is null then
    raise exception 'not_authenticated';
  end if;

  select m.household_id, m.photo_path
    into message_household_id, old_path
    from public.messages m
   where m.id = target_message_id
     and (m.kind in ('task_proof', 'moment')
          or (m.kind = 'chat' and (m.photo_path is not null or m.photo_removed_at is not null)))
     for update;
  if not found or not public.is_member(message_household_id) then
    raise exception 'message_not_found';
  end if;
  if not public.is_parent(message_household_id) then
    raise exception 'not_parent';
  end if;
  if old_path is null then
    raise exception 'photo_already_removed';
  end if;

  -- Serializes with stamp_message() attaching this path (see there).
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('carenest:photo_path:' || old_path, 0));
  update public.messages
     set photo_path = null, photo_removed_by = caller, photo_removed_at = now()
   where id = target_message_id;
  insert into public.removed_photos (path, household_id)
  values (old_path, message_household_id)
  on conflict (path) do nothing;
  delete from public.photo_saves where message_id = target_message_id;
  delete from public.concept_flags where message_id = target_message_id;

  return old_path;
end;
$$;

create or replace function public.remove_all_photos()
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  sole_households uuid[];
  target record;
  result text[];
begin
  if caller is null then
    raise exception 'not_authenticated';
  end if;

  select coalesce(array_agg(h.id), '{}') into sole_households
    from public.households h
   where exists (
           select 1 from public.household_members m
           where m.household_id = h.id and m.user_id = caller and m.role = 'parent'
         )
     and not exists (
           select 1 from public.household_members m
           where m.household_id = h.id and m.user_id <> caller and m.role = 'parent'
         );

  for target in
    select m.id, m.household_id, m.photo_path
      from public.messages m
     where m.household_id = any (sole_households) and m.photo_path is not null
     order by m.id
       for update
  loop
    -- Serializes with stamp_message() attaching this path (see there).
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('carenest:photo_path:' || target.photo_path, 0));
    update public.messages
       set photo_path = null, photo_removed_by = caller, photo_removed_at = now()
     where id = target.id;
    insert into public.removed_photos (path, household_id)
    values (target.photo_path, target.household_id)
    on conflict (path) do nothing;
  end loop;

  delete from public.photo_saves s
   using public.messages m
   where m.id = s.message_id and m.household_id = any (sole_households);
  delete from public.concept_flags f
   using public.messages m
   where m.id = f.message_id and m.household_id = any (sole_households);

  select coalesce(array_agg(o.name order by o.name), '{}') into result
    from storage.objects o
    cross join lateral public.photo_path_parts(o.name) parts
    join public.visits v on v.id = parts.visit_id
    join public.plans p on p.id = v.plan_id and p.household_id = parts.household_id
   where o.bucket_id = 'photos' and parts.household_id = any (sole_households);

  return result;
end;
$$;
