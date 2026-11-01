-- CareNest: appointments stay in their family space and plan; signed-in users get only the
-- privileges the schedule needs (SI-52). 20261026000000_carenest_appointments.sql is already
-- deployed, so it is fixed here rather than edited.
--
--   * The update policy checked only that the caller is a parent of the row's household, so a
--     parent could repoint an appointment's plan_id at another family's plan. Its with check now
--     also requires the plan to belong to the same household, exactly like the insert policy.
--   * Least privilege: the table-wide select/insert/update/delete grant becomes select, insert of
--     the columns the client sends, and update of only the booking details. household_id,
--     plan_id, id, and created_at are not updatable: an appointment never moves to another
--     family space or plan (the policy above is defence in depth if that grant ever widens).
--   * No client deletes appointments, so DELETE is not granted and its policy is dropped. A
--     future cancel feature adds both back.

drop policy "Parents can update appointments" on public.appointments;

create policy "Parents can update appointments"
  on public.appointments for update to authenticated
  using (public.is_parent(household_id))
  with check (
    public.is_parent(household_id)
    and exists (select 1 from public.plans p where p.id = appointments.plan_id and p.household_id = appointments.household_id)
  );

drop policy "Parents can cancel appointments" on public.appointments;

revoke all on public.appointments from authenticated;
grant select on public.appointments to authenticated;
grant insert (household_id, plan_id, appointment_date, start_time, end_time, note, activities)
  on public.appointments to authenticated;
grant update (appointment_date, start_time, end_time, note, activities)
  on public.appointments to authenticated;
