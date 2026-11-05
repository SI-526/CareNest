-- CareNest: a sitter can belong to several families (SI-45, slice B of 3).
--
-- Until now household_members_one_household_per_user allowed each account one membership in
-- total. This replaces it with a rule that only limits parents:
--
--   * household_members_one_parent_household_per_user: a unique index on user_id where
--     role = 'parent'. An account is a parent in at most one family, and can be a sitter
--     (role 'caretaker') in any number of others, including while it is a parent elsewhere.
--     The primary key (household_id, user_id) still allows one row per family per account.
--   * accept_invite: refuses only when the caller is already a member of the invited family
--     (already_member), not when they belong to any family. The insert uses on conflict on the
--     primary key, so two acceptances of different invites to the same family at once end with
--     one membership and an already_member error, not a raw unique violation.
--   * create_household: unchanged. It still refuses anyone who is already a member of any family
--     (already_member), so a sitter cannot start a family of their own from the app yet. The new
--     index is what still refuses a second parent family if two create_household calls race.
--
-- Checked and left unchanged, because each already takes the family from its argument or the
-- photo path and asks is_member or is_parent of that family, never "the caller's family":
-- is_member, is_parent, can_read_photo, can_upload_photo, can_delete_photo,
-- can_delete_removed_photo, create_invite, household_sitter_profiles, every RLS policy, the
-- message and care log stamp triggers (which read the caller's role in the row's own family).
-- remove_all_photos and delete_my_account already loop over every family where the caller is the
-- only parent, then delete all of the caller's memberships, so an account in several families
-- loses all of them and only a family where it was the sole parent is deleted.
--
-- Order on a live database: the new index is built before the old one is dropped, so there is no
-- moment with no rule at all. Both take locks on household_members (the build blocks writes, the
-- drop blocks reads), so a 2 second lock timeout makes a busy table fail the push cleanly (55P03)
-- with nothing changed, instead of queueing every sign-in behind it. The table has one row per
-- membership, so the build itself is short.
--
-- Rollback: a forward migration that recreates the old unique index on (user_id). It fails while
-- any account has two memberships, which is the point: those would have to be resolved first.

do $$
begin
  set local lock_timeout = '2s';
end;
$$;

create unique index household_members_one_parent_household_per_user
  on public.household_members (user_id)
  where role = 'parent';

drop index public.household_members_one_household_per_user;

-- Latest body (20261014000000) with the membership check narrowed to the invited family.
-- create or replace keeps security definer, the search_path, and the existing grants.
create or replace function public.accept_invite(invite_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  caller_email text := lower(auth.jwt() ->> 'email');
  caller_name text;
  invite public.invites;
begin
  if caller is null then
    raise exception 'not_authenticated';
  end if;

  select * into invite
    from public.invites
   where token_hash = encode(sha256(convert_to(coalesce(invite_token, ''), 'UTF8')), 'hex')
   for update;

  if not found then
    raise exception 'invite_not_found';
  elsif invite.revoked_at is not null then
    raise exception 'invite_revoked';
  elsif invite.accepted_at is not null then
    raise exception 'invite_used';
  elsif invite.expires_at <= now() then
    raise exception 'invite_expired';
  end if;

  -- The signed-in account must own the invited address and have it verified.
  if caller_email is distinct from invite.email or not exists (
    select 1 from auth.users u
    where u.id = caller and u.email_confirmed_at is not null
  ) then
    raise exception 'invite_wrong_email';
  end if;

  select coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name')
    into caller_name
    from auth.users u
   where u.id = caller;

  -- Membership elsewhere (as a sitter or as a parent) is fine; a second row in this family is not.
  insert into public.household_members (household_id, user_id, role, email, display_name)
  values (invite.household_id, caller, 'caretaker', caller_email, caller_name)
  on conflict (household_id, user_id) do nothing;
  if not found then
    raise exception 'already_member';
  end if;

  update public.invites
     set accepted_at = now(), accepted_by = caller
   where id = invite.id;

  return invite.household_id;
end;
$$;
