-- CareNest T3a: photos, messages, moments, read state, saved photos, and concept flags.
--
-- Builds on 20261014000000_carenest_schema.sql and keeps its rules: RLS on every table,
-- explicit minimal grants (new tables and functions start closed), SECURITY DEFINER functions
-- with a fixed empty search_path.
--
--   * Photos live in a PRIVATE Storage bucket `photos` (5 MB, JPEG/PNG/WebP) at
--     `<household_id>/<visit_id>/<uuid>.<jpg|png|webp>`. Members of the household read them.
--     A member uploads only into an open shift of their household whose date is in the window
--     (database UTC date ±1). Nobody overwrites a photo. Deletion: the uploader, while the shift
--     is open and before the photo is attached to a message (a cancelled upload), or the sole
--     parent during account deletion (after start_account_deletion()).
--   * messages: chat, task proofs, and moments. The sender, the sender's role, the time, and the
--     moment's `late` flag are always set by the database (trigger), never by the client.
--     Proofs and moments need an open, in-window shift, checked under a share lock on the visit,
--     so they cannot race end_visit(). Chat stays open after a shift ends.
--   * A task is completed only through complete_task(), which requires a photo: it writes the
--     task check and the proof message together. Clients can no longer insert task_checks.
--   * visits.moment_at: one BeReal-style prompt per shift at a random time chosen by the
--     database when the shift starts. A moment posted more than 2 minutes after it is late.
--   * message_reads (per user, private), photo_saves (per parent, private), concept_flags
--     (parent-set demo control, readable by members, CONCEPT ONLY: nothing analyses photos).

-- ---------------------------------------------------------------------------
-- Columns on existing tables
-- ---------------------------------------------------------------------------

-- Moment prompt time. Set by visits_set_moment_at on insert; clients have no write grant.
alter table public.visits add column moment_at timestamptz;
update public.visits set moment_at = started_at + interval '3 minutes' where moment_at is null;
alter table public.visits alter column moment_at set not null;

-- Set by start_account_deletion(); lets the departing sole parent delete the household's photos
-- from Storage for a short time before delete_my_account() removes the household.
alter table public.households add column deletion_started_at timestamptz;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- One row per chat message, task proof, or moment. Proofs and moments carry a photo in the
-- `photos` bucket under this message's household and visit (enforced by the path check).
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  visit_id uuid references public.visits (id) on delete cascade,
  kind text not null check (kind in ('chat', 'task_proof', 'moment')),
  body text not null default '' check (char_length(body) <= 2000),
  photo_path text unique,
  task_id uuid references public.tasks (id) on delete set null,
  tag text,
  reply_to uuid references public.messages (id) on delete set null,
  sender_id uuid default auth.uid() references auth.users (id) on delete set null,
  sender_role text not null check (sender_role in ('parent', 'caretaker')),
  created_at timestamptz not null default now(),
  late boolean not null default false,
  -- Chat has text and no photo; proofs and moments have a photo and belong to a shift.
  check (kind <> 'chat' or char_length(btrim(body)) >= 1),
  check ((kind = 'chat') = (photo_path is null)),
  check (kind = 'chat' or visit_id is not null),
  -- The photo is in this message's household/visit folder.
  check (
    photo_path is null
    or (
      photo_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$'
      and split_part(photo_path, '/', 1) = household_id::text
      and split_part(photo_path, '/', 2) = visit_id::text
    )
  ),
  -- task_id is required for a new proof (trigger); it becomes null if the task is deleted later.
  check (task_id is null or kind = 'task_proof'),
  check (tag is null or (kind = 'task_proof'
                         and tag in ('Meal', 'Nap', 'Play', 'Outing', 'Milestone', 'Other'))),
  check (reply_to is null or kind = 'chat'),
  check (not late or kind = 'moment')
);

create index messages_household_created_idx on public.messages (household_id, created_at);
create index messages_visit_task_idx on public.messages (visit_id, task_id);
create index messages_reply_to_idx on public.messages (reply_to);
create unique index messages_one_moment_per_visit
  on public.messages (visit_id) where kind = 'moment';

-- "Seen" state per user and message. Private: each user reads only their own rows.
create table public.message_reads (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create index message_reads_user_id_idx on public.message_reads (user_id);

-- A parent's album: photo messages they saved. Private per parent.
create table public.photo_saves (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  saved_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create index photo_saves_user_id_idx on public.photo_saves (user_id);

-- CONCEPT ONLY. The "child seems off" alert is a fake: nothing analyses the photo. A parent sets
-- the text by hand as a demo control. concept_only is always true so no reader can mistake a row
-- for a real analysis.
create table public.concept_flags (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null unique references public.messages (id) on delete cascade,
  set_by uuid default auth.uid() references auth.users (id) on delete set null,
  text text not null check (char_length(btrim(text)) between 1 and 280),
  concept_only boolean not null default true check (concept_only),
  created_at timestamptz not null default now()
);

comment on table public.concept_flags is
  'CONCEPT ONLY (demo). A parent-set "child seems off" alert on a photo message. Nothing '
  'analyses photos; the text is typed by a parent. Never present it as a real assessment.';
comment on column public.concept_flags.concept_only is
  'Always true: marks every row as a demo concept, not a real analysis.';
comment on column public.concept_flags.text is
  'Typed by a parent as a demo control (CONCEPT ONLY), not produced by any analysis.';

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- BeReal-style prompt: a random time 1-5 minutes after the shift starts (the demo app's timing).
create function public.set_moment_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.moment_at := new.started_at + make_interval(secs => 60 + floor(random() * 241));
  return new;
end;
$$;

create trigger visits_set_moment_at
  before insert on public.visits
  for each row execute function public.set_moment_at();

-- Stamps the server-controlled columns of every new message and enforces the rules that need
-- other rows. Runs as the owner so it can lock the visit and see the Storage object.
create function public.stamp_message()
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

  if new.kind in ('task_proof', 'moment') then
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
    -- The photo must exist, uploaded by the sender, in this household/visit folder (the path
    -- check constraint ties the folder to household_id and visit_id).
    if not exists (
      select 1 from storage.objects o
       where o.bucket_id = 'photos'
         and o.name = new.photo_path
         and o.owner_id = caller::text
    ) then
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

create trigger messages_stamp
  before insert on public.messages
  for each row execute function public.stamp_message();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.messages enable row level security;
alter table public.message_reads enable row level security;
alter table public.photo_saves enable row level security;
alter table public.concept_flags enable row level security;

-- messages: members read; members post chat and moments (column grants + stamp_message);
-- task proofs only through complete_task(). Messages are never edited or deleted by clients.
create policy "Members can read messages"
  on public.messages for select to authenticated
  using (public.is_member(household_id));

create policy "Members can post chat and moments"
  on public.messages for insert to authenticated
  with check (
    kind in ('chat', 'moment')
    and sender_id = (select auth.uid())
    and public.is_member(household_id)
  );

-- message_reads: each user marks and reads only their own, for messages they can see.
create policy "Users read their own read marks"
  on public.message_reads for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Members mark messages read"
  on public.message_reads for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.messages m
      where m.id = message_reads.message_id and public.is_member(m.household_id)
    )
  );

-- photo_saves: parents save photo messages of their household; each sees only their own.
create policy "Parents read their own saved photos"
  on public.photo_saves for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Parents save photos"
  on public.photo_saves for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.messages m
      where m.id = photo_saves.message_id
        and m.kind in ('task_proof', 'moment')
        and public.is_parent(m.household_id)
    )
  );

create policy "Parents unsave their own photos"
  on public.photo_saves for delete to authenticated
  using (user_id = (select auth.uid()));

-- concept_flags: members read; only parents set and clear them (demo control).
create policy "Members can read concept flags"
  on public.concept_flags for select to authenticated
  using (exists (
    select 1 from public.messages m
    where m.id = concept_flags.message_id and public.is_member(m.household_id)
  ));

create policy "Parents set concept flags"
  on public.concept_flags for insert to authenticated
  with check (
    set_by = (select auth.uid())
    and exists (
      select 1 from public.messages m
      where m.id = concept_flags.message_id
        and m.kind in ('task_proof', 'moment')
        and public.is_parent(m.household_id)
    )
  );

create policy "Parents clear concept flags"
  on public.concept_flags for delete to authenticated
  using (exists (
    select 1 from public.messages m
    where m.id = concept_flags.message_id and public.is_parent(m.household_id)
  ));

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Completes a task with a photo (required), an optional note, and an optional tag. Writes the
-- task check and the task_proof message in one transaction; stamp_message() re-checks the shift
-- under a share lock and verifies the photo. Returns the proof message id.
create function public.complete_task(
  target_visit_id uuid,
  target_task_id uuid,
  proof_photo_path text,
  proof_note text default '',
  proof_tag text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  visit_household_id uuid;
  visit_plan_id uuid;
  visit_ended_at timestamptz;
  visit_day date;
  message_id uuid;
begin
  if caller is null then
    raise exception 'not_authenticated';
  end if;

  select p.household_id, v.plan_id, v.ended_at, v.visit_date
    into visit_household_id, visit_plan_id, visit_ended_at, visit_day
    from public.visits v
    join public.plans p on p.id = v.plan_id
   where v.id = target_visit_id
     for share of v;

  -- Visits in other households look the same as visits that do not exist.
  if not found or not public.is_member(visit_household_id) then
    raise exception 'visit_not_found';
  end if;
  if visit_ended_at is not null then
    raise exception 'visit_ended';
  end if;
  if visit_day not between (now() at time zone 'utc')::date - 1
                       and (now() at time zone 'utc')::date + 1 then
    raise exception 'visit_too_old';
  end if;
  if not exists (
    select 1 from public.tasks t where t.id = target_task_id and t.plan_id = visit_plan_id
  ) then
    raise exception 'task_not_found';
  end if;
  if proof_photo_path is null then
    raise exception 'photo_required';
  end if;

  insert into public.task_checks (visit_id, task_id, checked_by)
  values (target_visit_id, target_task_id, caller)
  on conflict do nothing;
  if not found then
    raise exception 'task_already_done';
  end if;

  insert into public.messages (household_id, visit_id, kind, body, photo_path, task_id, tag)
  values (
    visit_household_id,
    target_visit_id,
    'task_proof',
    coalesce(btrim(proof_note), ''),
    proof_photo_path,
    target_task_id,
    nullif(btrim(proof_tag), '')
  )
  returning id into message_id;

  return message_id;
end;
$$;

-- Step 1 of deleting an account: marks every household where the caller is the only parent
-- (the ones delete_my_account() will remove) and returns their ids. For the next hour the caller
-- may delete those households' photos from Storage (folder = household id). Then the client
-- calls delete_my_account(). Storage objects are not removed by database cascades.
create function public.start_account_deletion()
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  result uuid[];
begin
  if caller is null then
    raise exception 'not_authenticated';
  end if;

  with marked as (
    update public.households h
       set deletion_started_at = now()
     where exists (
             select 1 from public.household_members m
             where m.household_id = h.id and m.user_id = caller and m.role = 'parent'
           )
       and not exists (
             select 1 from public.household_members m
             where m.household_id = h.id and m.user_id <> caller and m.role = 'parent'
           )
    returning h.id
  )
  select coalesce(array_agg(id), '{}') into result from marked;

  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Storage: private `photos` bucket and its policies
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- '<household uuid>/<visit uuid>/<uuid>.<jpg|png|webp>' -> household and visit ids, or nulls.
create function public.photo_path_parts(object_name text, out household_id uuid, out visit_id uuid)
language plpgsql
immutable
set search_path = ''
as $$
begin
  if object_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$' then
    household_id := split_part(object_name, '/', 1)::uuid;
    visit_id := split_part(object_name, '/', 2)::uuid;
  end if;
end;
$$;

-- Members of the household in the path's first folder.
create function public.can_read_photo(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.is_member((public.photo_path_parts(object_name)).household_id), false);
$$;

-- A member, into an open shift of their household whose date is in the window. (A message that
-- uses the photo re-checks this under a lock in stamp_message().)
create function public.can_upload_photo(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.photo_path_parts(object_name) parts
      join public.visits v on v.id = parts.visit_id
      join public.plans p on p.id = v.plan_id and p.household_id = parts.household_id
     where v.ended_at is null
       and v.visit_date between (now() at time zone 'utc')::date - 1
                            and (now() at time zone 'utc')::date + 1
       and public.is_member(p.household_id)
  );
$$;

-- The uploader may delete a photo that no message uses yet while the shift is still open (a
-- cancelled upload). The sole parent may delete the household's photos within an hour of
-- start_account_deletion(). Nothing else deletes photos.
create function public.can_delete_photo(object_name text, object_owner_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (
      object_owner_id = (select auth.uid())::text
      and public.can_upload_photo(object_name)
      and not exists (select 1 from public.messages m where m.photo_path = object_name)
    )
    or exists (
      select 1
        from public.households h
       where h.id = (public.photo_path_parts(object_name)).household_id
         and h.deletion_started_at > now() - interval '1 hour'
         and public.is_parent(h.id)
         and not exists (
               select 1 from public.household_members m
               where m.household_id = h.id
                 and m.user_id <> (select auth.uid())
                 and m.role = 'parent'
             )
    );
$$;

-- Policy names on storage.objects are shared by all buckets, hence the prefix. No UPDATE policy:
-- nobody overwrites or moves a photo (this also refuses upsert uploads).
create policy "carenest photos: members read"
  on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.can_read_photo(name));

create policy "carenest photos: members upload to an open shift"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.can_upload_photo(name));

create policy "carenest photos: uploader or departing sole parent deletes"
  on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and public.can_delete_photo(name, owner_id));

-- ---------------------------------------------------------------------------
-- Privileges (new tables and functions start closed; grant exactly what the app needs)
-- ---------------------------------------------------------------------------

grant all on public.messages, public.message_reads, public.photo_saves, public.concept_flags
  to service_role;

grant select on public.messages to authenticated;
grant insert (household_id, visit_id, kind, body, photo_path, reply_to)
  on public.messages to authenticated;
grant select, insert (message_id) on public.message_reads to authenticated;
grant select, insert (message_id), delete on public.photo_saves to authenticated;
grant select, insert (message_id, text), delete on public.concept_flags to authenticated;

-- A task is completed only through complete_task(), which requires a photo. (Revoking the
-- table privilege also revokes the column grant from the first migration.) Unchecking (delete)
-- is unchanged.
revoke insert on public.task_checks from authenticated;

grant execute on function
  public.complete_task(uuid, uuid, text, text, text),
  public.start_account_deletion(),
  public.photo_path_parts(text),
  public.can_read_photo(text),
  public.can_upload_photo(text),
  public.can_delete_photo(text, text)
to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: new messages stream to household members (RLS applies). Messages are never deleted
-- by clients; they go only with their household, plan, or shift (see README for the known
-- DELETE-event limitation).
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.messages;
