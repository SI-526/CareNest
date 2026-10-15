-- CareNest: photo messages (Linear SI-39, "View Moments Gallery").
--
-- A photo message is a chat message with a photo: kind 'chat', photo_path set, visit_id set (the
-- photo lives in that shift's folder), body optional. Only the sitter posts one, into an open,
-- in-window shift, with a photo they uploaded there, under the same rules as task proofs and
-- moments (stamp_message). It cannot be a reply. A parent can remove its photo with remove_photo
-- (the message stays as "Photo removed by ..."), and remove_all_photos already covers every
-- message with a photo. Saves (Album) and concept flags stay limited to proofs and moments.
-- Storage needs no change: uploads and reads are decided by the shift folder, and the upload cap
-- (2 per active task + 10 per shift) counts these photos too.

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

-- stamp_message() from 20261015, plus: a photo message is the sitter's and follows the proof
-- and moment photo rules. Grants and the trigger are kept by create or replace.
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
