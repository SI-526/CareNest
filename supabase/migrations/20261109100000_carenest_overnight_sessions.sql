-- CareNest: overnight sessions (SI-80). 20261026000000_carenest_appointments.sql is already
-- pushed, so it stays frozen and this migration changes what it set up.
--
--   * A session may run past midnight. An end time earlier than the start time means the
--     session ends the next day (7:00 PM to 1:00 AM is six hours), the usual calendar convention
--     for a date-night booking. appointment_date stays the day the session starts, which is the
--     day it is listed under. An end time equal to the start time is still refused (it would be
--     either an empty session or a 24-hour one), so a session is always shorter than 24 hours.
--   * The original rule was the unnamed table check `check (end_time > start_time)`, which
--     Postgres named appointments_check. It is dropped by that name, so a database where the
--     name differs fails here instead of keeping the same-day rule silently.
--   * Nothing else in the database assumes a same-day session: the database never checked
--     overlaps between sessions (only unique (plan_id, appointment_date, start_time)), and the
--     schedule_requests rules (a day with a session cannot be requested; booking a day resolves
--     its request) work on appointment_date alone, the day a session starts. Grants, policies,
--     and triggers are unchanged; this migration adds no function.
--   * Existing rows all have end_time > start_time, so they satisfy the new rule, and the
--     current site (which still refuses an end before the start itself) keeps working.
--   * The constraint swap takes an exclusive lock on appointments. lock_timeout makes it give up
--     (and the migration fail, to be retried) rather than wait behind a long transaction while
--     every app read of appointments queues behind it.
set lock_timeout = '5s';

alter table public.appointments drop constraint appointments_check;

alter table public.appointments
  add constraint appointments_end_differs_from_start check (end_time <> start_time);

comment on column public.appointments.end_time is
  'When the session ends. Earlier than start_time means it ends the next day (overnight, SI-80); never equal to start_time.';
