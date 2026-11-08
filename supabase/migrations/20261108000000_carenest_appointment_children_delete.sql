-- CareNest: Schedule Details editing (SI-74).
--
--   * SI-75: a session records which children it is for. `child_ids` holds ids from the
--     family's `children` table. Activities already live in the `activities` jsonb array, and
--     each activity's own children go there too (as `child_ids` inside each activity object), so
--     only the session needs a column. The ids are a selection, not a relationship: a child
--     deleted later simply stops showing on the session, so there is no foreign key (Postgres
--     cannot put one on array elements) and no cascade to write.
--     Every id must be a child of the appointment's own family space; a trigger checks that on
--     insert and whenever the array changes, so a parent cannot point a session at another
--     family's child id (ids are random UUIDs, but the check keeps the data honest).
--   * SI-79: parents can delete a session. 20261026100000 removed DELETE because no client
--     deleted appointments ("a future cancel feature adds both back"); this is that feature.
--     Only parents of the appointment's family space can delete it. Caretakers still only read.

alter table public.appointments
  add column child_ids uuid[] not null default '{}'
    check (cardinality(child_ids) <= 50 and array_position(child_ids, null) is null);

create function public.check_appointment_children()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from unnest(new.child_ids) as picked(id)
    where not exists (
      select 1 from public.children c where c.id = picked.id and c.household_id = new.household_id
    )
  ) then
    raise exception 'child_not_found' using errcode = '23503';
  end if;
  return new;
end;
$$;

create trigger appointments_check_children
  before insert or update of child_ids on public.appointments
  for each row
  when (cardinality(new.child_ids) > 0)
  execute function public.check_appointment_children();

grant insert (child_ids), update (child_ids) on public.appointments to authenticated;

create policy "Parents can delete appointments"
  on public.appointments for delete to authenticated
  using (public.is_parent(household_id));

grant delete on public.appointments to authenticated;
