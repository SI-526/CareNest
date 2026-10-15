-- CareNest: photo messages (Linear SI-39, "View Moments Gallery").
--
-- A photo message is a chat message with a photo: kind 'chat', photo_path set, visit_id set (the
-- photo lives in that shift's folder), body optional. Only the sitter posts one, into an open,
-- in-window shift, with a photo they uploaded there, under the same rules as task proofs and
-- moments (stamp_message). It cannot be a reply. A parent can remove its photo with remove_photo
-- (the message stays as "Photo removed by ..."), and remove_all_photos already covers every
-- message with a photo. Saves (Album) and concept flags stay limited to proofs and moments.
-- A shift takes at most 20 live photo messages (stamp_message; a parent's removal frees room),
-- and the shift folder's upload cap grows by the same 20 (can_upload_photo: 2 per active task +
-- 10 + 20), so task photos and the moment keep their full room however many the sitter shares.
-- Reads are still decided by the shift folder.

-- The two chat checks from 20261015 are unnamed; Postgres named them messages_check and
-- messages_check1. Refuse to run if those names mean something else here.
do $$
begin
  if (select pg_get_constraintdef(c.oid) from pg_constraint c
       where c.conrelid = 'public.messages'::regclass and c.conname = 'messages_check')
     is distinct from 'CHECK (((kind <> ''chat''::text) OR (char_length(btrim(body)) >= 1)))'
  or (select pg_get_constraintdef(c.oid) from pg_constraint c
       where c.conrelid = 'public.messages'::regclass and c.conname = 'messages_check1')
     is distinct from 'CHECK (((kind <> ''chat''::text) OR ((photo_path IS NULL) AND (photo_removed_at IS NULL))))'
  then
    raise exception 'messages chat constraints are not the expected ones; fix this migration';
  end if;
end;
$$;

alter table public.messages
  drop constraint messages_check,
  drop constraint messages_check1,
  -- Text chat needs text; a photo message (or its removed-photo tombstone) may have none.
  add constraint messages_chat_has_content check (
    kind <> 'chat'
    or char_length(btrim(body)) >= 1
    or photo_path is not null
    or photo_removed_at is not null
  ),
  -- Chat is text only, or a photo message: in a shift, not a reply, with its photo or a removal
  -- record (never both).
  add constraint messages_chat_photo_shape check (
    kind <> 'chat'
    or (photo_path is null and photo_removed_at is null)
    or (visit_id is not null and reply_to is null and (photo_path is null) = (photo_removed_at is not null))
  );

-- stamp_message() from 20261015, plus: a photo message is the sitter's, follows the proof and
-- moment photo rules, and a shift takes at most 20 live ones. Grants and the trigger are kept
-- by create or replace.
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
    -- A photo a parent removed is never attached again.
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

-- remove_photo() from 20261015, now also for photo messages (never for text chat).
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

-- can_upload_photo() from 20261015, with room for the shift's photo messages: the folder cap is
-- 2 per active task + 10 (proofs, the moment, retakes) + 20 (stamp_message()'s photo-message
-- cap), so photo messages never eat into task photos or the moment. Security definer, the
-- search_path, the grant and the storage policy that calls it are kept by create or replace.
create or replace function public.can_upload_photo(object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target_household_id uuid;
  target_visit_id uuid;
  target_plan_id uuid;
  photo_cap int;
  photo_count int;
begin
  select p.household_id, v.id, v.plan_id
    into target_household_id, target_visit_id, target_plan_id
    from public.photo_path_parts(object_name) parts
    join public.visits v on v.id = parts.visit_id
    join public.plans p on p.id = v.plan_id and p.household_id = parts.household_id
   where v.ended_at is null
     and v.visit_date between (now() at time zone 'utc')::date - 1
                          and (now() at time zone 'utc')::date + 1
     and public.is_member(p.household_id);
  if not found then
    return false;
  end if;
  if exists (select 1 from public.messages m where m.photo_path = object_name)
     or exists (select 1 from public.removed_photos r where r.path = object_name) then
    return false;
  end if;

  -- + 20: room for stamp_message()'s photo-message cap; change both together.
  select 2 * count(*) + 10 + 20 into photo_cap
    from public.tasks t
   where t.plan_id = target_plan_id and t.archived_at is null;
  select count(*) into photo_count
    from storage.objects o
   where o.bucket_id = 'photos'
     and o.name like target_household_id::text || '/' || target_visit_id::text || '/%';
  if photo_count >= photo_cap then
    -- 42501 so storage-api passes the message through (403) instead of a generic database error.
    raise exception 'photo_limit_reached' using errcode = '42501';
  end if;
  return true;
end;
$$;
