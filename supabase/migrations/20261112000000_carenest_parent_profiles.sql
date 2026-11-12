-- CareNest: a parent's own personal details (account.html): name and phone number, and whether
-- the family's sitters may see that phone number.
--
-- Until now a parent's name was copied into household_members once, when they joined, and could
-- not be changed; parents had no phone number at all. This adds:
--
--   * public.parent_profiles: one row per user, owned by that user, modelled on sitter_profiles.
--     Only the owner reads or writes it (RLS). Only someone who is a parent in at least one
--     family space may create one. Least privilege: authenticated gets select, plus insert/update
--     of the editable columns only; user_id comes from its default, auth.uid(), so a client
--     cannot create or edit anyone else's row (the RLS with check repeats this). No delete:
--     deleting the account removes the row (on delete cascade).
--   * share_phone defaults to true: the family's sitters see the parent's number on the Children
--     page, where it stands in as the primary contact until a parent picks one in Family info.
--     Turning it off hides the number from everyone but the parent.
--   * A trigger copies a non-blank display_name into the parent's household_members rows, so the
--     new name shows everywhere the app already reads the roster (header, schedule requests,
--     People page). A blank name leaves the roster name as it was.
--   * public.household_parent_phones(household): the only way other members read a parent's
--     phone. It returns rows only to a member of that household, only for people who are parents
--     of it right now, and only when they share their phone. The filtering happens in the
--     database, so an unshared number never reaches anyone else's browser.
--
-- The email address is not stored here: it is the sign-in address (Supabase Auth) and the app
-- shows it read-only. Not added to the realtime publication: pages load it when they open.

create table public.parent_profiles (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  phone text not null default '' check (char_length(phone) <= 40),
  share_phone boolean not null default true
);

alter table public.parent_profiles enable row level security;

create policy "Users can read their own parent profile"
  on public.parent_profiles for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Parents can create their own parent profile"
  on public.parent_profiles for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.household_members m
       where m.user_id = (select auth.uid()) and m.role = 'parent'
    )
  );

create policy "Users can update their own parent profile"
  on public.parent_profiles for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select on public.parent_profiles to authenticated;
grant insert (display_name, phone, share_phone) on public.parent_profiles to authenticated;
grant update (display_name, phone, share_phone) on public.parent_profiles to authenticated;

-- Keep the roster name in step with the profile name.
create function public.sync_parent_display_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if btrim(new.display_name) <> '' then
    update public.household_members
       set display_name = btrim(new.display_name)
     where user_id = new.user_id
       and role = 'parent'
       and display_name is distinct from btrim(new.display_name);
  end if;
  return null;
end;
$$;

revoke all on function public.sync_parent_display_name() from public;

create trigger parent_profiles_sync_display_name
  after insert or update of display_name on public.parent_profiles
  for each row execute function public.sync_parent_display_name();

create function public.household_parent_phones(target_household_id uuid)
returns table (user_id uuid, display_name text, phone text)
language sql
stable
security definer
set search_path = ''
as $$
  select pp.user_id,
         coalesce(nullif(btrim(pp.display_name), ''), nullif(btrim(m.display_name), ''), split_part(m.email, '@', 1)),
         pp.phone
    from public.parent_profiles pp
    join public.household_members m
      on m.user_id = pp.user_id
     and m.household_id = target_household_id
     and m.role = 'parent'
   where public.is_member(target_household_id)
     and pp.share_phone
     and btrim(pp.phone) <> ''
   order by m.created_at, pp.user_id;
$$;

revoke all on function public.household_parent_phones(uuid) from public;
grant execute on function public.household_parent_phones(uuid) to authenticated;
