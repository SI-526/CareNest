-- CareNest: hourly cleanup of orphaned photos in the private `photos` bucket (issue #7).
--
-- Database cascades never delete Storage objects, and Storage refuses SQL deletes on
-- storage.objects (its protect_objects_delete trigger: the row would go, the file would stay).
-- So pg_cron runs sweep_orphan_photos() every hour, which asks the Storage API, through pg_net,
-- to delete up to 1000 orphans per run, oldest first. An object is kept only while all of these
-- hold; everything else in the bucket is an orphan:
--   * its path names a shift that still exists in that household (so objects of a deleted
--     family space, plan, or shift go, including photos uploaded while an account was being
--     deleted);
--   * no parent removed it (removed_photos), so a removal whose client-side delete failed is
--     finished here;
--   * a message uses it, or its shift can still use it: stamp_message() attaches a photo only
--     while the shift's date is within the UTC day before or after today, so an unused upload
--     goes once that window has closed and it is over 24 hours old (1 to 3 days after upload).
--     Attaching runs in one short API transaction (statement_timeout is seconds), and the job
--     runs at :17, so no attach that passed the date check can still commit when it runs.
--
-- One-time setup per project (not in this file, because it holds a secret): two Vault secrets,
-- `carenest_project_url` (https://<ref>.supabase.co) and `carenest_photo_cleanup_key` (a secret
-- API key). See README "Photo cleanup". Until both exist every run fails with
-- photo_cleanup_not_configured (cron.job_run_details); HTTP results are in net._http_response.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- `create extension if not exists` never upgrades an installed pg_net; fail the push rather than
-- every run if it predates net.http_delete(..., body).
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'net' and p.proname = 'http_delete' and 'body' = any (p.proargnames)
  ) then
    raise exception 'pg_net too old: net.http_delete has no body parameter (alter extension pg_net update)';
  end if;
end;
$$;

-- Every orphaned object in the photos bucket, oldest first. Mirrors can_read_photo()'s shift
-- check, so whatever members can no longer read is an orphan.
create function public.photo_orphans()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select o.name
    from storage.objects o
    left join lateral (
      select v.visit_date
        from public.photo_path_parts(o.name) parts
        join public.visits v on v.id = parts.visit_id
        join public.plans p on p.id = v.plan_id and p.household_id = parts.household_id
    ) shift on true
   where o.bucket_id = 'photos'
     and (
       shift.visit_date is null
       or exists (select 1 from public.removed_photos r where r.path = o.name)
       or (
         o.created_at < now() - interval '24 hours'
         and shift.visit_date < (now() at time zone 'utc')::date - 1
         and not exists (select 1 from public.messages m where m.photo_path = o.name)
       )
     )
   order by o.created_at, o.name;
$$;

-- Queues one Storage API bulk delete (at most 1000 paths, its limit) and returns the pg_net
-- request id, or null when there is nothing to delete. Whatever is left goes in the next run.
create function public.sweep_orphan_photos()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  base_url text;
  api_key text;
  paths text[];
begin
  select s.decrypted_secret into base_url
    from vault.decrypted_secrets s where s.name = 'carenest_project_url';
  select s.decrypted_secret into api_key
    from vault.decrypted_secrets s where s.name = 'carenest_photo_cleanup_key';
  if coalesce(base_url, '') = '' or coalesce(api_key, '') = '' then
    raise exception 'photo_cleanup_not_configured';
  end if;

  paths := array(select public.photo_orphans() limit 1000);
  if cardinality(paths) = 0 then
    return null;
  end if;

  return net.http_delete(
    url := rtrim(base_url, '/') || '/storage/v1/object/photos',
    headers := jsonb_build_object('apikey', api_key, 'Content-Type', 'application/json'),
    body := jsonb_build_object('prefixes', to_jsonb(paths)),
    timeout_milliseconds := 30000
  );
end;
$$;

-- Internal: only postgres (pg_cron) runs these.
revoke execute on function public.photo_orphans(), public.sweep_orphan_photos()
  from public, anon, authenticated, service_role;

comment on function public.photo_path_parts(text) is
  'Objects in the photos bucket whose name does not match this format are deleted by the hourly cleanup (photo_orphans). Change both together.';

-- Re-running schedule() with the same name updates the job.
select cron.schedule('carenest-photo-cleanup', '17 * * * *', 'select public.sweep_orphan_photos()');
