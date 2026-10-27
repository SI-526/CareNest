-- CareNest: a sitter's "Request Schedule" sends a real in-app reminder to the family's parents
-- (SI-50).
--
-- Until now the button on schedule.html only showed "Schedule request sent to the parent." and
-- sent nothing. This adds:
--
--   * public.schedule_requests: one row per reminder, for one household and one calendar date.
--     A caretaker (a member who is not a parent) asks; every member reads; a parent dismisses
--     (sets resolved_at). At most one open request per household and date (partial unique index),
--     so a second tap gets 23505 and the app treats it as "already sent".
--   * Least privilege: authenticated gets select, insert of (household_id, request_date) only,
--     and update of resolved_at only. requested_by is not insertable: it comes from its default,
--     auth.uid() (the insert policy repeats this as defence in depth), so nobody can send a
--     request in someone else's name. No delete: a family-space delete removes the rows (cascade).
--   * Dates: from yesterday (UTC, the same window edge shifts use) up to a year ahead (today
--     + 366), so nobody files requests for long-past or far-future days; and not for a day that
--     already has an appointment (the schedule exists, so there is nothing to ask for).
--   * Auto-clear: when a parent books an appointment for that date, or moves one to it, a trigger
--     resolves the open request, so the reminder disappears once the schedule exists.
--   * Published to Realtime so the parent's pages show a new request without a reload. Realtime
--     DELETE events are not RLS-filtered (README known limitation): a cascade delete emits one
--     random UUID per row and no content.
--
-- In-app only: no email, no push, no new service.

create table public.schedule_requests (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  request_date date not null,
  requested_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create unique index schedule_requests_one_open_per_day
  on public.schedule_requests (household_id, request_date)
  where resolved_at is null;

alter table public.schedule_requests enable row level security;

create policy "Members can read schedule requests"
  on public.schedule_requests for select to authenticated
  using (public.is_member(household_id));

create policy "Caretakers can request a schedule"
  on public.schedule_requests for insert to authenticated
  with check (
    public.is_member(household_id)
    and not public.is_parent(household_id)
    and request_date >= (now() at time zone 'utc')::date - 1
    and request_date <= (now() at time zone 'utc')::date + 366
    and requested_by = (select auth.uid())
    -- A day that already has a session needs no reminder. Runs as the caller, so appointments
    -- RLS applies: a member reads their own household's appointments, which is all this needs.
    and not exists (
      select 1 from public.appointments a
       where a.household_id = schedule_requests.household_id
         and a.appointment_date = schedule_requests.request_date
    )
  );

create policy "Parents can dismiss schedule requests"
  on public.schedule_requests for update to authenticated
  using (public.is_parent(household_id))
  -- Dismiss only: a resolved request is not reopened (the sitter asks again instead).
  with check (public.is_parent(household_id) and resolved_at is not null);

grant select on public.schedule_requests to authenticated;
grant insert (household_id, request_date) on public.schedule_requests to authenticated;
grant update (resolved_at) on public.schedule_requests to authenticated;

alter publication supabase_realtime add table public.schedule_requests;

-- Booking (or moving) an appointment onto a requested date resolves that date's open request.
-- Security definer so it can update rows the booking parent's own grants would also allow, and
-- without depending on them; it touches only the appointment's own household and date.
create function public.resolve_schedule_requests()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.schedule_requests
     set resolved_at = now()
   where household_id = new.household_id
     and request_date = new.appointment_date
     and resolved_at is null;
  return null;
end;
$$;

revoke all on function public.resolve_schedule_requests() from public;

create trigger appointments_resolve_schedule_requests
  after insert or update of appointment_date on public.appointments
  for each row execute function public.resolve_schedule_requests();
