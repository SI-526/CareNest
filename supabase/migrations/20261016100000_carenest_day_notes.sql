-- CareNest: "Important today" day notes (Linear SI-29).
--
-- Builds on 20261014000000_carenest_schema.sql and 20261015000000_carenest_photos_messages.sql
-- and keeps their rules: RLS on every table, explicit minimal grants (new tables and functions
-- start closed), functions with a fixed empty search_path.
--
--   * day_notes: parent-written notes for one calendar date of a family space (routine change,
--     special instruction, schedule change, food or medication reminder, other). The sitter's
--     page shows the notes for the shift's local date. Members read; parents add, edit, delete.
--   * Who wrote a note and when, and who last edited it and when, are set by the database
--     (trigger), never by the client: a note shows "Updated" only when updated_at > created_at,
--     and updated_at moves only when the date, category, title, or detail actually change.
--   * A note never moves to another family space (household_id is not updatable).

create table public.day_notes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  note_date date not null,
  category text not null
    check (category in ('routine', 'instructions', 'schedule', 'food_meds', 'other')),
  title text not null check (char_length(btrim(title)) between 1 and 140),
  detail text not null default '' check (char_length(detail) <= 2000),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

create index day_notes_household_date_idx on public.day_notes (household_id, note_date);

alter table public.day_notes enable row level security;

-- Members read; parents write (same rules as care_items).
create policy "Members can read day notes"
  on public.day_notes for select to authenticated
  using (public.is_member(household_id));

create policy "Parents can create day notes"
  on public.day_notes for insert to authenticated
  with check (public.is_parent(household_id));

create policy "Parents can update day notes"
  on public.day_notes for update to authenticated
  using (public.is_parent(household_id))
  with check (public.is_parent(household_id));

create policy "Parents can delete day notes"
  on public.day_notes for delete to authenticated
  using (public.is_parent(household_id));

-- Stamps authorship and edit time, whatever the client sends. On insert the note is new
-- (updated_at = created_at, no editor). On update the original author and time are kept, and
-- the editor and time move only when the content changes, so "Updated" cannot be forged.
-- A NULL author or editor is let through on update: that is the `on delete set null` FK action
-- when the auth user is deleted (writing the old id back would violate the FK and fail the
-- account deletion). Clients cannot send it: authenticated has no UPDATE grant on those columns.
create function public.stamp_day_note()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    new.updated_by := null;
    new.updated_at := new.created_at;
    return new;
  end if;

  new.household_id := old.household_id;
  new.created_by := case when new.created_by is null then null else old.created_by end;
  new.created_at := old.created_at;
  if new.note_date is distinct from old.note_date
     or new.category is distinct from old.category
     or new.title is distinct from old.title
     or new.detail is distinct from old.detail then
    new.updated_by := auth.uid();
    new.updated_at := now();
  else
    new.updated_by := case when new.updated_by is null then null else old.updated_by end;
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;

create trigger day_notes_stamp
  before insert or update on public.day_notes
  for each row execute function public.stamp_day_note();

-- Grants: the table starts closed (default privileges); give authenticated only what the app
-- needs. The trigger function needs no EXECUTE grant: Postgres checks EXECUTE on a trigger
-- function when the trigger is created, not when it fires.
grant select on public.day_notes to authenticated;
grant insert (household_id, note_date, category, title, detail) on public.day_notes to authenticated;
grant update (note_date, category, title, detail) on public.day_notes to authenticated;
grant delete on public.day_notes to authenticated;

-- Realtime: note changes stream to household members (RLS applies; see README for the known
-- DELETE-event limitation).
alter publication supabase_realtime add table public.day_notes;
