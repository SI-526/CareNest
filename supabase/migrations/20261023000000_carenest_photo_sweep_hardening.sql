-- CareNest: photo cleanup hardening (issue #27). Three changes to the hourly sweep of
-- 20261020000000_carenest_photo_cleanup.sql:
--
--   * Failures are loud. pg_net answers after the sweep's transaction has committed, so a wrong
--     or revoked key used to show only in net._http_response (kept 6 hours) while
--     cron.job_run_details said succeeded. The sweep now records each request it queues
--     (photo_sweep_requests), and a second job, carenest-photo-cleanup-check at :47, fails with
--     photo_cleanup_failed (status and response in its return_message) while a request was
--     rejected, errored, or got no answer within 10 minutes. It is a separate, read-only job
--     because raising inside the sweep would roll back the request it queues and the
--     bookkeeping below. The next sweep settles the request, so each failed request fails
--     exactly one check run.
--   * A rejected batch no longer blocks the rest. The sweep sent the oldest 1000 orphans every
--     run, so a batch Storage refused was retried forever and newer orphans never went. Paths of
--     a failed request are now skipped until their retry_at (photo_sweep_failures): exponential
--     backoff, 2^failures hours capped at 24, with "equal jitter" (half fixed, half random; AWS
--     Architecture Blog, "Exponential Backoff And Jitter"). The first retry window is
--     [1 h, 2 h), so a failed batch's paths retry together once; from the second failure the
--     jitter spreads them over different later batches, so a path Storage always refuses ends
--     up alone after about five failures (about two days).
--   * A plan's household can no longer change. Parents could update any column of their plan,
--     including household_id; photo paths name the household, so moving a plan made all its
--     shifts' photos orphans, and the sweep would delete them. Clients now update only
--     `schedule`, the one column the app edits (js/manage.js).

-- ---------------------------------------------------------------------------
-- Sweep bookkeeping (internal: no policies and no client privileges, like removed_photos)
-- ---------------------------------------------------------------------------

-- Bulk deletes queued through pg_net and not yet settled by a later sweep.
create table public.photo_sweep_requests (
  request_id bigint primary key,
  paths text[] not null,
  created_at timestamptz not null default now()
);

-- Orphans whose delete failed; the sweep skips them until retry_at.
create table public.photo_sweep_failures (
  path text primary key,
  failures integer not null,
  last_status integer,
  retry_at timestamptz not null
);

alter table public.photo_sweep_requests enable row level security;
alter table public.photo_sweep_failures enable row level security;
-- Default privileges may grant new public tables to the API roles; take them back.
revoke all on public.photo_sweep_requests, public.photo_sweep_failures from anon, authenticated;

-- ---------------------------------------------------------------------------
-- The sweep: settle earlier requests, then queue the next batch
-- ---------------------------------------------------------------------------

-- `create or replace` keeps the revoke of 20261020000000 (only postgres runs it).
create or replace function public.sweep_orphan_photos()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  base_url text;
  api_key text;
  batch text[];
  sent_id bigint;
  req record;
begin
  -- 1. Settle requests that have a response, or have had none for 10 minutes (pg_net's
  --    timeout here is 30 seconds, so none is coming). 2xx clears the paths' failures;
  --    anything else (an error status, a timeout, no response) backs them off.
  for req in
    select q.request_id as id, q.paths, r.status_code
      from public.photo_sweep_requests q
      -- pg_net's ids and responses are unlogged, so ids can repeat after crash recovery; a
      -- response older than the request belongs to another request.
      left join net._http_response r on r.id = q.request_id and r.created >= q.created_at
     where r.id is not null or q.created_at < now() - interval '10 minutes'
       for update of q skip locked
  loop
    if req.status_code between 200 and 299 then
      delete from public.photo_sweep_failures f where f.path = any (req.paths);
    else
      insert into public.photo_sweep_failures as f (path, failures, last_status, retry_at)
      select distinct p.path, 1, req.status_code, now() from unnest(req.paths) as p(path)
      on conflict (path) do update
        set failures = f.failures + 1, last_status = excluded.last_status;
      update public.photo_sweep_failures f
         set retry_at = now()
           + interval '1 hour' * least(2 ^ least(f.failures, 5), 24) * (0.5 + random() / 2)
       where f.path = any (req.paths);
    end if;
    delete from public.photo_sweep_requests q where q.request_id = req.id;
  end loop;

  -- 2. Forget failures of objects that are gone (deleted later, or by a parent).
  delete from public.photo_sweep_failures f
   where not exists (
     select 1 from storage.objects o where o.bucket_id = 'photos' and o.name = f.path
   );

  -- 3. Configuration.
  select s.decrypted_secret into base_url
    from vault.decrypted_secrets s where s.name = 'carenest_project_url';
  select s.decrypted_secret into api_key
    from vault.decrypted_secrets s where s.name = 'carenest_photo_cleanup_key';
  if coalesce(base_url, '') = '' or coalesce(api_key, '') = '' then
    raise exception 'photo_cleanup_not_configured';
  end if;

  -- 4. Up to 1000 orphans (the Storage API's limit), oldest first, minus those backing off.
  batch := array(
    select o.path
      from public.photo_orphans() with ordinality as o(path, n)
     where not exists (
       select 1 from public.photo_sweep_failures f where f.path = o.path and f.retry_at > now()
     )
     order by o.n
     limit 1000
  );
  if cardinality(batch) = 0 then
    return null;
  end if;

  -- 5. Queue the delete and remember it for the next run and the check job.
  sent_id := net.http_delete(
    url := rtrim(base_url, '/') || '/storage/v1/object/photos',
    headers := jsonb_build_object('apikey', api_key, 'Content-Type', 'application/json'),
    body := jsonb_build_object('prefixes', to_jsonb(batch)),
    timeout_milliseconds := 30000
  );
  insert into public.photo_sweep_requests (request_id, paths) values (sent_id, batch);
  return sent_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- The check: fails while an unsettled request failed
-- ---------------------------------------------------------------------------

-- Read-only, so raising loses nothing; the sweep settles (and forgets) the request afterwards.
create function public.check_photo_sweep()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  details text;
begin
  select string_agg(
           format('request %s: %s %s', q.request_id,
                  coalesce(r.status_code::text, r.error_msg, 'no response'),
                  coalesce(left(r.content, 200), '')),
           '; ' order by q.request_id)
    into details
    from public.photo_sweep_requests q
    left join net._http_response r on r.id = q.request_id and r.created >= q.created_at
   where (r.id is not null and coalesce(r.status_code not between 200 and 299, true))
      or (r.id is null and q.created_at < now() - interval '10 minutes');
  if details is not null then
    raise exception 'photo_cleanup_failed: %', details;
  end if;
end;
$$;

-- Internal: only postgres (pg_cron) runs it.
revoke execute on function public.check_photo_sweep() from public, anon, authenticated, service_role;

-- 30 minutes after the sweep at :17. Re-running schedule() with the same name updates the job.
select cron.schedule('carenest-photo-cleanup-check', '47 * * * *', 'select public.check_photo_sweep()');

-- ---------------------------------------------------------------------------
-- Plans: only the schedule label is editable
-- ---------------------------------------------------------------------------

-- A plan's household never changes: its shifts' photo paths name that household, so a moved
-- plan's photos would become orphans and be swept. Parents only edit the schedule label
-- (js/manage.js). Least privilege: a column the app makes editable later needs its own grant.
revoke update on public.plans from authenticated;
grant update (schedule) on public.plans to authenticated;
