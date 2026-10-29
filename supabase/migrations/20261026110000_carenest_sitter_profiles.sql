-- CareNest: the sitter's public profile is saved in the database and parents see only the fields
-- the sitter chose to share (SI-51).
--
-- Until now profile.html was labelled "Visible to parents" but saved only to the sitter's own
-- browser (localStorage), so no parent ever saw it. This adds:
--
--   * public.sitter_profiles: one row per user, owned by that user. Only the owner reads or
--     writes it (RLS); parents have no direct access at all, because the row also holds the
--     unshared fields and the sitter's private wants_updates preference.
--   * Least privilege: authenticated gets select, plus insert/update of the editable columns
--     only. user_id is not insertable or updatable: it comes from its default, auth.uid(), so a
--     client cannot create or edit a profile for anyone else (the RLS with check repeats this as
--     defence in depth). No delete: deleting the account removes the row (on delete cascade).
--   * public.household_sitter_profiles(household): the only way parents read profiles. It returns
--     rows only to a parent of that household, only for people who are caretakers of it right
--     now, and returns bio, phone, and availability as NULL unless the sitter shares them. The
--     filtering happens in the database, so hidden fields never reach a parent's browser.
--
-- Not added to the realtime publication: parents load profiles when a page opens.

create table public.sitter_profiles (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  bio text not null default '' check (char_length(bio) <= 500),
  phone text not null default '' check (char_length(phone) <= 40),
  availability text not null default '' check (char_length(availability) <= 160),
  show_bio boolean not null default true,
  show_phone boolean not null default false,
  show_availability boolean not null default true,
  wants_updates boolean not null default true
);

alter table public.sitter_profiles enable row level security;

create policy "Users can read their own sitter profile"
  on public.sitter_profiles for select to authenticated
  using (user_id = (select auth.uid()));

create policy "Users can create their own sitter profile"
  on public.sitter_profiles for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "Users can update their own sitter profile"
  on public.sitter_profiles for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select on public.sitter_profiles to authenticated;
grant insert (display_name, bio, phone, availability, show_bio, show_phone, show_availability, wants_updates)
  on public.sitter_profiles to authenticated;
grant update (display_name, bio, phone, availability, show_bio, show_phone, show_availability, wants_updates)
  on public.sitter_profiles to authenticated;

create function public.household_sitter_profiles(target_household_id uuid)
returns table (user_id uuid, display_name text, bio text, phone text, availability text)
language sql
stable
security definer
set search_path = ''
as $$
  select sp.user_id,
         nullif(sp.display_name, ''),
         case when sp.show_bio then nullif(sp.bio, '') end,
         case when sp.show_phone then nullif(sp.phone, '') end,
         case when sp.show_availability then nullif(sp.availability, '') end
    from public.sitter_profiles sp
    join public.household_members m
      on m.user_id = sp.user_id
     and m.household_id = target_household_id
     and m.role = 'caretaker'
   where public.is_parent(target_household_id);
$$;

revoke all on function public.household_sitter_profiles(uuid) from public;
grant execute on function public.household_sitter_profiles(uuid) to authenticated;
