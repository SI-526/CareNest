# CareNest

A babysitter app for two phones. A parent sets up the family space and invites a babysitter by
email; the babysitter sees the child's schedule and care info and checks off tasks while the
parent watches progress live.

The site itself is plain HTML, CSS, and JavaScript served as static files (Vercel, no build
step). There is deliberately **no `package.json` at the repo root**; database tooling lives in
`tests/`, and `.vercelignore` keeps `supabase/` and `tests/` off the deployed site.

## Local database

The Supabase schema is in `supabase/migrations/`. Everything below runs against a **local**
Supabase stack in Docker; nothing here touches a hosted project.

```sh
cd tests
npm install          # pinned Supabase CLI + supabase-js
npm run db:start     # local stack; ports are 553xx so it never collides with Carekeeper's 543xx
npm run db:reset     # applies migrations, then supabase/seed.sql
npm run test:rls     # authorization tests (refuse to run against a non-local URL)
npm run db:lint      # supabase db lint
npm run db:stop
```

Local ports: API `55321`, Postgres `55322`, Studio `55323`, Mailpit `55324`.

### Demo family (local only)

`supabase/seed.sql` loads the demo family from `js/data.js` (Jack Thomas: the day's schedule,
care info, food and allergies, emergency steps, contacts, and the hospital) into a household
with id `00000000-0000-4000-8000-00000000c0de` that has **no members**. Users cannot be created
from SQL, so sign up on the local stack, then attach yourself as its parent in Studio's SQL
editor:

```sql
insert into public.household_members (household_id, user_id, role, email, display_name)
select '00000000-0000-4000-8000-00000000c0de', id, 'parent', lower(email), 'Mary'
from auth.users where email = 'you@example.test';
```

Seeds run only on a local `supabase db reset`; never run `seed.sql` against a hosted project.

## Data model

| Table | Holds | Who can write |
| --- | --- | --- |
| `households` | Family space name, child's name and age label | Created by `create_household`; parents edit name/child fields |
| `household_members` | Parent and caretaker roles (one household per user) | Added only by RPCs; parents remove caretakers |
| `invites` | Email-bound invites (token hash, 7-day expiry) | Created by `create_invite`; parents revoke |
| `care_items` | Preferences, where things are, instructions, emergency steps, food/allergies (with severity) | Parents |
| `contacts` | People and places to call (including the hospital, with address) | Parents |
| `plans`, `tasks` | The child's day: ordered tasks with time, detail, location, care note | Parents |
| `visits` | One babysitting shift per plan per date (yesterday, today, or tomorrow); start, handoff note, end | Members start and write the note; `end_visit` ends it; parents can `reopen_visit` |
| `task_checks` | Which tasks are done in a shift | Members, while the shift is open |

## Data and risk boundaries

- Every table has Row Level Security enabled and denies by default. Signed-out (anon) requests
  can read nothing and call no function in `public`. The browser will only ever hold the public publishable
  key; there is no service-role or secret key in the app.
- Signed-in users get only the table and column privileges the app needs, and RLS narrows rows
  to their own household. Only parents change care info, contacts, plans, and tasks. Caretakers
  read everything in their household, start shifts, check and uncheck tasks, and write the
  handoff note. Later migrations start closed too: new tables, sequences, and functions in
  `public` get no anon/authenticated privileges (schema-scoped default privileges revoked).
  Postgres also gives every new function `EXECUTE` to `PUBLIC` in every schema by default, which
  a schema-scoped revoke cannot remove, so the migration additionally revokes that globally for
  functions created by `postgres`: any function a later migration adds, in any schema, must be
  granted explicitly to be callable.
- Households, memberships, and invites are created only through `SECURITY DEFINER` functions with
  a fixed empty `search_path`. Creating a family space requires an explicit risk acknowledgement,
  stored as `households.risk_acknowledged_at`.
- Invite links carry a random 256-bit token. Only its SHA-256 hash is stored. Accepting requires
  the signed-in account's verified email to match the invite; invites expire after 7 days, can be
  revoked, are single-use, and a new invite to the same address revokes the previous one.
- A shift can only be started for yesterday, today, or tomorrow (database date, UTC on
  Supabase), so a client cannot claim a plan's far-off dates. It ends through `end_visit`, which
  records who ended it and when. After that its task checks are frozen; the handoff note stays
  editable. A parent (not a caretaker) can reopen an ended shift with `reopen_visit`, which
  clears the end so tasks can be checked again (for example, if the sitter ended it by mistake).
- A task check that races `end_visit` can land just after the end: each statement checks
  `ended_at` against its own snapshot. That is harmless for checks, but T3's photo lock must not
  rely on the same plain predicate: it must re-check `ended_at` under a row lock on the visit
  (`select ... for share`) or in a trigger.
- `delete_my_account` deletes every family space where you are the only parent (cascading all
  care info, contacts, plans, tasks, shifts, checks, and invites), removes your other
  memberships, and deletes your sign-in account. When a caretaker deletes their account, checks
  and notes they wrote stay in the family's history without their name.
- Known limitation (same as Carekeeper): Supabase Realtime does not apply RLS to DELETE events,
  so a signed-in user subscribed to `task_checks` also receives the primary keys (two random
  UUIDs, no content) of unchecks in other family spaces. Clients must ignore events for shifts
  they are not showing.

## Deploying to a hosted Supabase project

The migration does not depend on dashboard toggles, but two settings must match it:

- **Auth providers: Google only, with the Email provider OFF.** Invites trust the account's
  verified email. With email sign-up enabled (especially with "Confirm email" off), anyone could
  create a self-confirmed account under an invitee's address and accept their invite.
- **"Automatically expose new tables" OFF** (Data API settings), matching the migration's revoked
  default privileges, so a table added later is not exposed until a migration grants it.
