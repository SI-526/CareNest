-- CareNest T3a: photos, messages, moments, read state, saved photos, and concept flags.
--
-- Builds on 20261014000000_carenest_schema.sql and keeps its rules: RLS on every table,
-- explicit minimal grants (new tables and functions start closed), SECURITY DEFINER functions
-- with a fixed empty search_path.
--
--   * Photos live in a PRIVATE Storage bucket `photos` (5 MB, JPEG/PNG/WebP) at
--     `<household_id>/<visit_id>/<uuid>.<jpg|png|webp>`. Members of the household read them.
--     A member uploads only into an open shift of their household whose date is in the window
--     (database UTC date ±1), at most 2 photos per active task + 10 per shift folder
--     (photo_limit_reached), never at a path a message uses or a parent removed. Nobody
--     overwrites a photo. A photo is readable only while its path's shift still exists in that
--     household and no parent removed it. Deletion: a photo no message uses, by its uploader or
--     by a parent of the household; a used photo first goes through remove_photo() (parents
--     only, which keeps the message as "Photo removed by ..." and records the path in
--     removed_photos); a removed photo only by a parent. Account deletion uses
--     remove_all_photos() (the same removal for every photo of the caller's sole-parent
--     households), then the Storage API delete, then delete_my_account().
--   * messages: chat, task proofs, and moments. The sender, the sender's role, the time, and the
--     moment's `late` flag are always set by the database (trigger), never by the client.
--     Proofs and moments need an open, in-window shift, checked under a share lock on the visit,
--     so they cannot race end_visit(). Chat stays open after a shift ends.
--   * A task is completed only through complete_task(), the only path that creates a task
--     check: it locks the visit (FOR SHARE) and re-checks the end, the date window, and that the
--     task is not archived. Caretakers must attach a photo (the check and the proof message are
--     written together); parents may check off without one. Clients cannot insert task_checks.
--   * Archived tasks are frozen: parents cannot edit (or un-archive) them.
--   * visits.moment_at: one BeReal-style prompt per shift at a random time chosen by the
--     database when the shift starts: between 30 minutes after the start and 30 minutes before
--     the plan's usual end (from its schedule label), or 30 minutes to 3 hours after the start
--     when the usual hours are unknown. trigger_moment_now() (parents) moves it to 1-5 minutes
--     from now for demos. A moment's photo must be uploaded at or after the prompt
--     (moment_photo_too_early). A moment posted more than 2 minutes after the prompt is late.
--   * message_reads (per user, private), photo_saves (per parent, private), concept_flags
--     (parent-set demo control, readable by members, CONCEPT ONLY: nothing analyses photos).

-- ---------------------------------------------------------------------------
-- Columns on existing tables
-- ---------------------------------------------------------------------------

-- Moment prompt time. Set by visits_set_moment_at on insert; clients have no write grant.
alter table public.visits add column moment_at timestamptz;
update public.visits set moment_at = started_at + interval '3 minutes' where moment_at is null;
alter table public.visits alter column moment_at set not null;

-- Snapshot of the task as it was when it was checked, so a past shift shows what the sitter saw
-- even after a parent edits the task. Filled by the task_checks_lock_visit trigger on every
-- insert; clients cannot insert or update task_checks at all.
alter table public.task_checks
  add column task_title text,
  add column task_time_of_day time,
  add column task_detail text,
  add column task_location text,
  add column task_care_note text;
update public.task_checks c
   set task_title = t.title, task_time_of_day = t.time_of_day, task_detail = t.detail,
       task_location = t.location, task_care_note = t.care_note
  from public.tasks t
 where t.id = c.task_id;
alter table public.task_checks
  alter column task_title set not null,
  alter column task_detail set not null,
  alter column task_location set not null,
  alter column task_care_note set not null;

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
  -- Set by remove_photo(): a parent erased this proof's or moment's photo. The message, its
  -- task check, and the shift history stay ("Photo removed by Mary").
  photo_removed_by uuid references auth.users (id) on delete set null,
  photo_removed_at timestamptz,
  -- Chat has text and no photo; proofs and moments belong to a shift and have a photo until a
  -- parent removes it.
  check (kind <> 'chat' or char_length(btrim(body)) >= 1),
  check (kind <> 'chat' or (photo_path is null and photo_removed_at is null)),
  check (kind = 'chat' or (photo_path is null) = (photo_removed_at is not null)),
  check (photo_removed_by is null or photo_removed_at is not null),
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

-- Every Storage path a parent removed with remove_photo() or remove_all_photos(). A removed path
-- is never readable again (only a parent may still delete its object), never uploaded to again,
-- and never attached to a message again. Rows go with their household. Internal: clients have no
-- privileges; the SECURITY DEFINER functions below read and write it.
create table public.removed_photos (
  path text primary key,
  household_id uuid not null references public.households (id) on delete cascade,
  removed_at timestamptz not null default now()
);

create index removed_photos_household_id_idx on public.removed_photos (household_id);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- The usual hours in a plan's schedule label, e.g. "3:00pm - 7:00pm", "3-7pm", "9am to 1pm",
-- "15:00–19:00", "9-5" (9am-5pm). Nulls when the label is empty or not understood. Never raises:
-- only ASCII digits are matched ([0-9], not \d, which also matches full-width and other
-- scripts' digits under an ICU locale), and any failure falls back to nulls, so an odd label can
-- never block starting a shift.
create function public.schedule_hours(label text, out start_time time, out end_time time)
language plpgsql
immutable
set search_path = ''
as $$
declare
  parts text[];
  h1 int;
  m1 int;
  h2 int;
  m2 int;
  ap1 text;
  ap2 text;
begin
  parts := regexp_match(
    coalesce(label, ''),
    '^\s*([0-9]{1,2})(?::([0-9]{2}))?\s*([ap]\.?m\.?)?\s*(?:-|–|—|to)\s*([0-9]{1,2})(?::([0-9]{2}))?\s*([ap]\.?m\.?)?\s*$',
    'i'
  );
  if parts is null then
    return;
  end if;
  h1 := parts[1]::int;
  m1 := coalesce(parts[2], '0')::int;
  ap1 := lower(left(parts[3], 1));
  h2 := parts[4]::int;
  m2 := coalesce(parts[5], '0')::int;
  ap2 := lower(left(parts[6], 1));
  if m1 > 59 or m2 > 59 then
    return;
  end if;
  -- "9-5" (no am/pm, both 12 or less, end before start) is a day shift: 9am-5pm, not overnight.
  if ap1 is null and ap2 is null and h1 <= 12 and h2 <= 12
     and make_time(h2, m2, 0) < make_time(h1, m1, 0) then
    h2 := h2 + 12;
  end if;
  -- "3-7pm" is 3pm-7pm; "11-1pm" is 11am-1pm; "3pm-7" is 3pm-7pm.
  if ap1 is null and ap2 is not null then
    ap1 := case when h1 % 12 <= h2 % 12 then ap2 else (case when ap2 = 'p' then 'a' else 'p' end) end;
  elsif ap2 is null and ap1 is not null then
    ap2 := ap1;
  end if;
  if ap1 is not null then
    if h1 not between 1 and 12 or h2 not between 1 and 12 then
      return;
    end if;
    h1 := h1 % 12 + case when ap1 = 'p' then 12 else 0 end;
    h2 := h2 % 12 + case when ap2 = 'p' then 12 else 0 end;
  elsif h1 > 23 or h2 > 23 then
    return;
  end if;
  start_time := make_time(h1, m1, 0);
  end_time := make_time(h2, m2, 0);
exception
  when others then
    -- Unparseable after all: unknown hours (the caller uses the default timing).
    start_time := null;
    end_time := null;
end;
$$;

-- BeReal-style prompt delay from the shift's start: a random time between 30 minutes after the
-- start and 30 minutes before the usual end. The usual end is the start plus the usual shift
-- length from the plan's schedule label (no household time zone is stored, so a clock time
-- cannot be placed on the timeline). Unknown hours: 30 minutes to 3 hours. A usual shift of an
-- hour or less gets the prompt 30 minutes in.
create function public.moment_delay(schedule_label text)
returns interval
language plpgsql
volatile
set search_path = ''
as $$
declare
  usual_start time;
  usual_end time;
  usual_length interval;
  latest interval := interval '3 hours';
begin
  select h.start_time, h.end_time into usual_start, usual_end
    from public.schedule_hours(schedule_label) h;
  if usual_start is not null and usual_end is not null then
    usual_length := usual_end - usual_start;
    if usual_length <= interval '0' then
      usual_length := usual_length + interval '24 hours'; -- overnight, e.g. "10pm - 6am"
    end if;
    latest := greatest(usual_length - interval '30 minutes', interval '30 minutes');
  end if;
  return interval '30 minutes' + random() * (latest - interval '30 minutes');
end;
$$;

-- Chooses the shift's moment time when it starts. Runs as the owner so it can read the plan and
-- call moment_delay(); the insert policy still decides whether the row lands.
create function public.set_moment_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.moment_at := new.started_at + public.moment_delay(
    (select p.schedule from public.plans p where p.id = new.plan_id)
  );
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

create trigger messages_stamp
  before insert on public.messages
  for each row execute function public.stamp_message();

-- A save or concept flag needs the message's photo to still be there. The RLS check alone reads
-- a snapshot, so a save racing remove_photo() (which holds the message FOR UPDATE) could land on
-- a just-removed photo. This trigger locks the message FOR SHARE, which waits for that removal
-- to commit, then re-reads photo_path. Runs as the owner (row locks need more than SELECT).
create function public.require_message_photo()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_path text;
begin
  select m.photo_path into current_path
    from public.messages m
   where m.id = new.message_id
     for share;
  if current_path is null then
    raise exception 'photo_removed';
  end if;
  return new;
end;
$$;

create trigger photo_saves_require_photo
  before insert on public.photo_saves
  for each row execute function public.require_message_photo();

create trigger concept_flags_require_photo
  before insert on public.concept_flags
  for each row execute function public.require_message_photo();

-- Every task check a signed-in user creates (today only complete_task(); any future path too)
-- locks its visit FOR SHARE and re-reads it. FOR SHARE waits for a concurrent end_visit() (which
-- holds the row FOR UPDATE) and then sees the committed end, so a check cannot land on a shift
-- that ended while the insert was in flight. Also re-checks the date window. Writes with no
-- signed-in user (service role, migrations, seed) skip the shift checks. Every insert, from
-- anyone, gets the task snapshot (title, time, detail, location, care note) from the task row,
-- whatever the writer sent.
create function public.lock_visit_for_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  visit_ended_at timestamptz;
  visit_day date;
begin
  select t.title, t.time_of_day, t.detail, t.location, t.care_note
    into new.task_title, new.task_time_of_day, new.task_detail, new.task_location,
         new.task_care_note
    from public.tasks t
   where t.id = new.task_id;
  if not found then
    raise exception 'task_not_found';
  end if;
  if auth.uid() is null then
    return new;
  end if;
  select v.ended_at, v.visit_date into visit_ended_at, visit_day
    from public.visits v
   where v.id = new.visit_id
     for share;
  if not found then
    raise exception 'visit_not_found';
  end if;
  if visit_ended_at is not null then
    raise exception 'visit_ended';
  end if;
  if visit_day not between (now() at time zone 'utc')::date - 1
                       and (now() at time zone 'utc')::date + 1 then
    raise exception 'visit_too_old';
  end if;
  return new;
end;
$$;

create trigger task_checks_lock_visit
  before insert on public.task_checks
  for each row execute function public.lock_visit_for_check();

-- tasks.archived_at is stamped by the database: setting it (from null) records the current time,
-- whatever value the client sent, and it never changes again (no un-archive, no back-dating).
-- Also applies to inserts: a task created already archived gets the current time.
create function public.stamp_task_archived_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.archived_at is not null then
      new.archived_at := clock_timestamp();
    end if;
  elsif old.archived_at is null and new.archived_at is not null then
    new.archived_at := clock_timestamp();
  elsif new.archived_at is distinct from old.archived_at then
    raise exception 'task_archived';
  end if;
  return new;
end;
$$;

create trigger tasks_stamp_archived_at
  before insert or update on public.tasks
  for each row execute function public.stamp_task_archived_at();

-- Correction to a comment in 20261014000000 (that file is frozen): log_original_uncheck's note
-- that deleting a task, plan, or visit cascades checks away describes paths members cannot take
-- while checks exist (no DELETE on tasks or visits; a plan with shifts cannot be deleted). The
-- only member-reachable cascade that removes checks is delete_my_account (a sole parent's
-- whole family space); the service role can delete visits directly.

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.messages enable row level security;
alter table public.message_reads enable row level security;
alter table public.photo_saves enable row level security;
alter table public.concept_flags enable row level security;
-- removed_photos: no policies and no client privileges (internal to the functions below).
alter table public.removed_photos enable row level security;

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
        and m.photo_path is not null
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
        and m.photo_path is not null
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

-- The only way to create a task check. Locks the visit FOR SHARE (so it waits for a concurrent
-- end_visit(), which holds the row FOR UPDATE, and then sees the committed end), re-checks the
-- end and the date window, and locks the task FOR SHARE (so it cannot be archived mid-way) and
-- refuses archived tasks. A caretaker must attach a photo: the check and the task_proof message
-- (optional note and tag) are written together, and stamp_message() verifies the photo. A
-- parent may check off without a photo ("Done by Mary"): only the check is written. Returns the
-- proof message id, or null when a parent checked off without a photo.
create function public.complete_task(
  target_visit_id uuid,
  target_task_id uuid,
  proof_photo_path text default null,
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
  caller_role text;
  visit_household_id uuid;
  visit_plan_id uuid;
  visit_ended_at timestamptz;
  visit_day date;
  task_archived_at timestamptz;
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
  select m.role into caller_role
    from public.household_members m
   where m.household_id = visit_household_id and m.user_id = caller;
  if visit_household_id is null or caller_role is null then
    raise exception 'visit_not_found';
  end if;
  if visit_ended_at is not null then
    raise exception 'visit_ended';
  end if;
  if visit_day not between (now() at time zone 'utc')::date - 1
                       and (now() at time zone 'utc')::date + 1 then
    raise exception 'visit_too_old';
  end if;

  select t.archived_at into task_archived_at
    from public.tasks t
   where t.id = target_task_id and t.plan_id = visit_plan_id
     for share;
  if not found then
    raise exception 'task_not_found';
  end if;
  if task_archived_at is not null then
    raise exception 'task_archived';
  end if;
  if proof_photo_path is null and caller_role <> 'parent' then
    raise exception 'photo_required';
  end if;

  insert into public.task_checks (visit_id, task_id, checked_by)
  values (target_visit_id, target_task_id, caller)
  on conflict do nothing;
  if not found then
    raise exception 'task_already_done';
  end if;

  if proof_photo_path is null then
    return null;
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

-- A parent removes a photo from a proof or moment (any sender's). The message stays with
-- photo_path cleared and photo_removed_by/at set ("Photo removed by Mary"); its task check and
-- the shift history are untouched. Saves of the photo (every parent's album) and its concept
-- flag go with it. The path is recorded in removed_photos, so from now on nobody can read it,
-- upload to it, or attach it to a message. Returns the Storage path, which the client then
-- deletes with the Storage API (only a parent may delete a removed photo). Locks the message so
-- two removals, or a removal and a save/flag, cannot interleave.
create function public.remove_photo(target_message_id uuid)
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
   where m.id = target_message_id and m.kind in ('task_proof', 'moment')
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

-- Demo/dev control: a parent moves an open, in-window shift's moment prompt to 1-5 minutes from
-- now (the old demo timing). Refused once the moment is posted. Holds the visit FOR UPDATE, so
-- it serializes with a moment being posted (stamp_message() holds it FOR SHARE). Returns the
-- new moment_at.
create function public.trigger_moment_now(target_visit_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  visit_household_id uuid;
  visit_ended_at timestamptz;
  visit_day date;
  result timestamptz;
begin
  if caller is null then
    raise exception 'not_authenticated';
  end if;

  select p.household_id, v.ended_at, v.visit_date
    into visit_household_id, visit_ended_at, visit_day
    from public.visits v
    join public.plans p on p.id = v.plan_id
   where v.id = target_visit_id
     for update of v;
  if not found or not public.is_member(visit_household_id) then
    raise exception 'visit_not_found';
  end if;
  if not public.is_parent(visit_household_id) then
    raise exception 'not_parent';
  end if;
  if visit_ended_at is not null then
    raise exception 'visit_ended';
  end if;
  if visit_day not between (now() at time zone 'utc')::date - 1
                       and (now() at time zone 'utc')::date + 1 then
    raise exception 'visit_too_old';
  end if;
  if exists (
    select 1 from public.messages m where m.visit_id = target_visit_id and m.kind = 'moment'
  ) then
    raise exception 'moment_already_posted';
  end if;

  update public.visits
     set moment_at = now() + make_interval(secs => 60 + floor(random() * 241))
   where id = target_visit_id
  returning moment_at into result;
  return result;
end;
$$;

-- Step 1 of deleting an account. In every household where the caller is the only parent (the
-- ones delete_my_account() will remove), removes every photo exactly as remove_photo() does
-- (messages stay marked "Photo removed by ...", paths recorded in removed_photos, saves and
-- concept flags deleted), so even if the account is then kept, no message points at a missing
-- photo. Returns every Storage path in those households' shift folders, which the client deletes
-- with the Storage API (step 2) before calling delete_my_account() (step 3); Storage objects are
-- not removed by database cascades. Does nothing (returns an empty list) for a caretaker or a
-- parent who shares the household with another parent.
create function public.remove_all_photos()
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

-- Members of the household in the path's first folder, while the path's shift still exists in
-- that household and no parent removed the photo. Objects left behind by a deleted shift or
-- family space are readable by nobody (only the service role) until they are cleaned up.
create function public.can_read_photo(object_name text)
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
     where public.is_member(p.household_id)
       and not exists (select 1 from public.removed_photos r where r.path = object_name)
  );
$$;

-- A removed photo is unreadable, but a parent must still be able to delete its object, and a
-- Storage delete has to see the row (SELECT policy) to delete it. So a parent of the household
-- sees a removed photo only inside a Storage API delete request: storage-api sets
-- storage.operation() to 'storage.object.delete' / 'storage.object.delete_many' for those
-- routes (a download or a signed URL is a different operation). If the setting is missing, this
-- is false (fails closed).
create function public.can_delete_removed_photo(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(storage.operation(), '') in ('storage.object.delete', 'storage.object.delete_many')
     and exists (select 1 from public.removed_photos r where r.path = object_name)
     and public.is_parent((public.photo_path_parts(object_name)).household_id);
$$;

-- A member, into an open shift of their household whose date is in the window, at a path no
-- message uses and no parent removed, while the shift's folder holds fewer than 2 photos per
-- active task of the plan + 10 (a shift needs one photo per task and one moment; the margin
-- allows retakes). Over the cap it raises photo_limit_reached (only for a caller who could
-- otherwise upload there, so it reveals nothing to others) so the app can say "Photo limit
-- reached for this shift." (A message that uses the photo re-checks the shift under a lock in
-- stamp_message().)
create function public.can_upload_photo(object_name text)
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

  select 2 * count(*) + 10 into photo_cap
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

-- A photo no message uses. Not removed: its uploader (while still a member, whether or not the
-- shift is open) or any parent of the household. Removed by a parent (remove_photo() or
-- remove_all_photos()): only a parent of the household. A photo a message uses is never deleted
-- directly.
create function public.can_delete_photo(object_name text, object_owner_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    not exists (select 1 from public.messages m where m.photo_path = object_name)
    and (
      public.is_parent((public.photo_path_parts(object_name)).household_id)
      or (
        not exists (select 1 from public.removed_photos r where r.path = object_name)
        and object_owner_id = (select auth.uid())::text
        and public.is_member((public.photo_path_parts(object_name)).household_id)
      )
    );
$$;

-- Policy names on storage.objects are shared by all buckets, hence the prefix. No UPDATE policy:
-- nobody overwrites or moves a photo (this also refuses upsert uploads).
create policy "carenest photos: members read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'photos'
    and (public.can_read_photo(name) or public.can_delete_removed_photo(name))
  );

create policy "carenest photos: members upload to an open shift"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.can_upload_photo(name));

create policy "carenest photos: uploader or parent deletes"
  on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and public.can_delete_photo(name, owner_id));

-- ---------------------------------------------------------------------------
-- Privileges (new tables and functions start closed; grant exactly what the app needs)
-- ---------------------------------------------------------------------------

grant all on public.messages, public.message_reads, public.photo_saves, public.concept_flags,
  public.removed_photos
  to service_role;

grant select on public.messages to authenticated;
grant insert (household_id, visit_id, kind, body, photo_path, reply_to)
  on public.messages to authenticated;
grant select, insert (message_id) on public.message_reads to authenticated;
grant select, insert (message_id), delete on public.photo_saves to authenticated;
grant select, insert (message_id, text), delete on public.concept_flags to authenticated;

-- A task is completed only through complete_task(), the one path that creates a check under the
-- visit's share lock. (Revoking the table privilege also revokes the column grant from the first
-- migration.) Unchecking (delete) is unchanged.
revoke insert on public.task_checks from authenticated;

-- Archived tasks are frozen: a parent edits only active tasks (archiving is the last edit), so a
-- past shift's tasks cannot be relabelled and nothing is un-archived (re-create the task).
alter policy "Parents can update tasks" on public.tasks
  using (
    archived_at is null
    and exists (
      select 1 from public.plans p
      where p.id = tasks.plan_id and public.is_parent(p.household_id)
    )
  );

grant execute on function
  public.complete_task(uuid, uuid, text, text, text),
  public.remove_photo(uuid),
  public.trigger_moment_now(uuid),
  public.remove_all_photos(),
  public.photo_path_parts(text),
  public.can_read_photo(text),
  public.can_delete_removed_photo(text),
  public.can_upload_photo(text),
  public.can_delete_photo(text, text)
to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: new messages, and remove_photo() updates, stream to household members (RLS
-- applies). Messages are never deleted by clients; they go only with their household, plan, or
-- shift (see README for the known DELETE-event limitation).
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table public.messages;
