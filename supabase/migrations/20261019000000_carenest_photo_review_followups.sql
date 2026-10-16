-- CareNest: photo follow-ups from the final schema review (issue #10).
--
-- 1. remove_all_photos() records every returned path in removed_photos, not only the paths
--    messages used. A sitter can no longer attach a returned unused photo, or upload to its
--    path, between the photo removal and delete_my_account(). It also returns photos left
--    behind by deleted shifts, so the parent can delete them too.
-- 2. remove_all_photos() reads only the sole households' folders (o.name like '<household>/%'),
--    not the whole bucket.
-- 3. delete_my_account() refuses with photos_remaining while any photo is still in Storage under
--    a household it would delete (a sitter uploaded one after remove_all_photos(), or the client
--    skipped the Storage step). The app's retry repeats both steps, so that photo goes too.
-- 4. require_message_photo() first checks that the caller is a member of the message's
--    household. An outsider now gets the RLS refusal whether or not a message has a photo, and
--    never waits on the message's row lock.
-- 5. can_read_photo() refuses signed URLs (storage.object.sign / sign_many). The app only uses
--    authenticated downloads, so no member can mint a link that outlives a photo's removal or
--    their membership.
-- Each function is its latest body plus the change. create or replace keeps security definer,
-- the search_path, grants, triggers and the storage policies that call them.

create or replace function public.remove_all_photos()
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

  -- Every object in those households' folders, including ones of deleted shifts.
  select coalesce(array_agg(o.name order by o.name), '{}') into result
    from storage.objects o
    join unnest(sole_households) as h (id) on o.name like h.id::text || '/%'
   where o.bucket_id = 'photos';

  -- Recorded as removed: never attached or uploaded to again, and deletable by the parent
  -- (can_delete_removed_photo) even when its shift is gone.
  insert into public.removed_photos (path, household_id)
  select r.path, split_part(r.path, '/', 1)::uuid
    from unnest(result) as r (path)
  on conflict (path) do nothing;

  return result;
end;
$$;

create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception 'not_authenticated';
  end if;

  -- Storage objects do not go with the household's rows. Refuse while one is left in a
  -- household this would delete; the app then repeats remove_all_photos() and the Storage step.
  -- Only well-formed photo paths count (the only ones clients can upload, and the ones a parent
  -- can delete), so a stray object can never block account deletion.
  if exists (
       select 1
         from public.households h
         join storage.objects o
           on o.bucket_id = 'photos' and o.name like h.id::text || '/%'
        where exists (
                select 1 from public.household_members m
                where m.household_id = h.id and m.user_id = caller and m.role = 'parent'
              )
          and not exists (
                select 1 from public.household_members m
                where m.household_id = h.id and m.user_id <> caller and m.role = 'parent'
              )
          and (public.photo_path_parts(o.name)).household_id = h.id
     ) then
    raise exception 'photos_remaining';
  end if;

  delete from public.households h
   where exists (
           select 1 from public.household_members m
           where m.household_id = h.id and m.user_id = caller and m.role = 'parent'
         )
     and not exists (
           select 1 from public.household_members m
           where m.household_id = h.id and m.user_id <> caller and m.role = 'parent'
         );

  delete from public.household_members where user_id = caller;
  delete from auth.users where id = caller;
end;
$$;

create or replace function public.require_message_photo()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_path text;
begin
  -- Not a member: leave the refusal to RLS, so a known message id reveals nothing.
  if not exists (
       select 1 from public.messages m
        where m.id = new.message_id and public.is_member(m.household_id)
     ) then
    return new;
  end if;
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

create or replace function public.can_read_photo(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(storage.operation(), '') not in ('storage.object.sign', 'storage.object.sign_many')
     and exists (
    select 1
      from public.photo_path_parts(object_name) parts
      join public.visits v on v.id = parts.visit_id
      join public.plans p on p.id = v.plan_id and p.household_id = parts.household_id
     where public.is_member(p.household_id)
       and not exists (select 1 from public.removed_photos r where r.path = object_name)
  );
$$;
