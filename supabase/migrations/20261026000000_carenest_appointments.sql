-- Parent-booked care appointments. These are deliberately distinct from visits:
-- a visit is created when a sitter starts a shift, whereas an appointment reserves care ahead
-- of time and is visible to both parents and caretakers in the schedule.
create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  plan_id uuid not null references public.plans (id) on delete cascade,
  appointment_date date not null,
  start_time time not null,
  end_time time not null,
  note text not null default '' check (char_length(note) <= 2000),
  -- Activities are session-specific. A newly booked session starts with no activities.
  activities jsonb not null default '[]'::jsonb check (jsonb_typeof(activities) = 'array'),
  created_at timestamptz not null default now(),
  check (end_time > start_time),
  unique (plan_id, appointment_date, start_time)
);

create index appointments_household_date_idx on public.appointments (household_id, appointment_date, start_time);

alter table public.appointments enable row level security;

create policy "Members can read appointments"
  on public.appointments for select to authenticated
  using (public.is_member(household_id));

create policy "Parents can book appointments"
  on public.appointments for insert to authenticated
  with check (
    public.is_parent(household_id)
    and exists (select 1 from public.plans p where p.id = appointments.plan_id and p.household_id = appointments.household_id)
  );

create policy "Parents can update appointments"
  on public.appointments for update to authenticated
  using (public.is_parent(household_id))
  with check (public.is_parent(household_id));

create policy "Parents can cancel appointments"
  on public.appointments for delete to authenticated
  using (public.is_parent(household_id));

grant select, insert, update, delete on public.appointments to authenticated;

alter publication supabase_realtime add table public.appointments;
