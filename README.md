# CareNest

A babysitter app for two phones. A parent sets up the family space and invites a babysitter by
email; the babysitter sees the child's schedule and care info and checks off tasks while the
parent watches progress live.

The site itself is plain HTML, CSS, and JavaScript served as static files (Vercel, no build
step). There is deliberately **no `package.json` at the repo root**; database tooling lives in
`tests/`, and `.vercelignore` keeps `supabase/` and `tests/` off the deployed site.

## Accounts and sign-in

Pages: `signin.html` (Google sign-in, the data notice), `onboarding.html` (create a family space;
requires ticking the at-your-own-risk acknowledgement), `people.html` (parents: invite a sitter,
revoke invites, remove sitters), `invite.html#<token>` (accept an invite), and `privacy.html` /
`terms.html`. Every app page (`index`, `parent`, `people`, `messages`, `info`,
`food-allergies`) loads `js/auth.js`, which keeps the page hidden until it has checked the
session: signed out goes to `signin.html`, no family space goes to `onboarding.html`, a parent's
home is `parent.html`, a sitter's is `index.html`, and a page for the other role redirects to the
right one. The Account item in the nav signs out or deletes the account and its data. In this
slice the schedule, care info, photos, and messages still come from `js/data.js` and
`js/store.js`; only names (child, parent, sitter) come from the family space.

`?demo=1` (remembered for the browser tab) shows the sample family from `js/data.js` with a
"Demo mode" banner, as before accounts existed. It does not sign anyone in or out: signed out, the
banner links to sign-in; signed in, it reads "Demo mode — signed in as <name> · Exit demo" (Exit
demo clears the flag). Sign-in, `invite.html`, and `onboarding.html` also clear it. Demo mode never
reads the database (signed-out requests can read nothing anyway) and never reads an account's
device data.

Device data (`js/store.js`: task photos, moments, messages, check-offs) is still localStorage
only until T3. It is keyed per person: `carenest:demo:v1` for demo mode and
`carenest:v1:<user id>` for each account, picked by the auth guard; signed-out visitors get no key.
Signing out, or the guard finding no family space, removes that account's key; deleting the
account removes every `carenest:*` key in that browser. The pre-accounts shared key `carenest:v1`
is discarded on load (it can't be attributed to one account).

Security headers (CSP with Google Identity Services' documented sources, `frame-ancestors
'none'`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`) are set for every route in
`vercel.json`. `style-src` includes `'unsafe-inline'` because Google's sign-in script injects
its own `<style>` element and `style` attributes (the button renders broken without it);
`script-src` has no inline allowance. `python3 -m http.server` does not send these headers.

Config is in `js/config.js` and is public by design: the Supabase URL, the publishable key, and
the Google OAuth client ID. On `localhost`/`127.0.0.1` the app uses the local stack
(`http://127.0.0.1:55321`, the CLI's built-in local publishable key) and shows a password
"Local development sign-in" form; every other host uses the hosted project. Run it locally with
`python3 -m http.server 8000` from the repo root and open `http://localhost:8000/signin.html`.

### Sign-in architecture

Google is the only sign-in method, through Supabase Auth with Google Identity Services (GIS):

- `signin.html` and `invite.html` load `https://accounts.google.com/gsi/client` and render
  Google's button on our own origin (`js/signin-widget.js`), popup or FedCM only: no One Tap and
  no auto-select. Google returns an ID token; `supabase.auth.signInWithIdToken` exchanges it for a
  session. No redirect, so no tokens ever appear in the URL (`detectSessionInUrl: false`).
- Nonce: each page load makes a random 256-bit raw nonce and its SHA-256 hex. Google gets the
  **hash** (it copies it into the ID token); Supabase gets the **raw** value, hashes it, and
  compares, so an ID token from another page load is rejected.
- supabase-js is the UMD build from jsDelivr pinned to an exact version (2.117.2, matching
  `tests/package.json`) with a Subresource Integrity hash, so a changed file is refused. Google's
  GIS script is evergreen and cannot be pinned or hashed.
- Invite links put the token in the URL **fragment** (`invite.html#<token>`), which browsers never
  send to a server, and `invite.html` sets `<meta name="referrer" content="strict-origin">` so only
  the origin ever leaves in a Referer. After accepting, the page `replace`s itself, so the token
  leaves the tab's history.
- Hosted project setup: Supabase → Auth → Providers → Google enabled with this client ID listed;
  the Email provider OFF (see below). The Google OAuth client must list each site origin (the
  Vercel URL, and `http://localhost:8000` for local Google testing) as an authorized JavaScript
  origin.

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
| `plans`, `tasks` | The child's day (one plan per family space): ordered tasks with time, detail, location, care note | Parents |
| `visits` | One babysitting shift per plan per date (yesterday, today, or tomorrow); start, handoff note, current end | Members start and write the note (dates in the window only); any member can `end_visit` and `reopen_visit` |
| `task_checks` | Which tasks are done in a shift, by whom, and when (`checked_at`) | Members, while the shift is open and dated yesterday, today, or tomorrow |
| `shift_events` | Append-only shift history: ends, reopens, and unchecks of original-shift tasks after a reopen, with who, which task, and when | Nobody directly; only `end_visit`, `reopen_visit`, and the uncheck trigger write it. Members read |

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
- **Note for T3 and later migrations:** every function created by `postgres` in a later migration
  is NOT executable by `anon` or `authenticated` until it is explicitly granted
  (`grant execute on function ... to authenticated`). This also covers helpers used in column
  defaults, `CHECK` constraints, RLS or storage policies, and functions from extensions created
  by `postgres`. The migration author must add the grant; a missing grant fails closed with
  `42501` (permission denied).
- Households, memberships, and invites are created only through `SECURITY DEFINER` functions with
  a fixed empty `search_path`. Creating a family space requires an explicit risk acknowledgement,
  stored as `households.risk_acknowledged_at`.
- Invite links carry a random 256-bit token. Only its SHA-256 hash is stored. Accepting requires
  the signed-in account's verified email to match the invite; invites expire after 7 days, can be
  revoked, are single-use, and a new invite to the same address revokes the previous one.
- **Shift window.** A shift can only be started for yesterday, today, or tomorrow (the
  database's UTC date, `(now() at time zone 'utc')::date`, which ignores the client-settable
  session time zone, including PostgREST's `Prefer: timezone`), so a client cannot claim a
  plan's far-off dates. A shift dated outside that window is **read-only even if nobody ended
  it**: no check, no uncheck, no handoff-note edit, no reopen.
- **Ending.** A shift ends through `end_visit`, which records who ended it and when (one
  timestamp, read under the visit's row lock, is used for `visits.ended_at`, the `ended` event,
  and the return value). After that its task checks are frozen. `end_visit` also works on an
  open shift outside the window, so a forgotten shift can still be closed for the record. The
  handoff note stays editable after the end while the shift's date is in the window.
- **Reopening.** Any member, the sitter or a parent, can reopen an ended shift with
  `reopen_visit` (for example, if the sitter ended it by mistake), but only while its date is in
  the window; otherwise `visit_too_old`, so old days cannot be backfilled. Reopening clears the
  current end on `visits` so tasks can be checked again; nothing else is erased.
- **Shift history.** Every end and every reopen is appended to `shift_events` (kind, who,
  when), so the app can show "Ended 5:02pm by Bethany · reopened 5:10pm by Bethany". Members
  read it; no client can insert, update, or delete it (no table or column write privilege);
  only `end_visit`, `reopen_visit`, and the uncheck trigger (all `SECURITY DEFINER`, empty
  `search_path`) write it. It is published to Realtime so the parent's page can alert them when
  a shift is reopened. Append-only is enforced against members' direct writes; deleting a plan
  (a parent) or a family space (`delete_my_account`) cascades its shifts and their history away.
- **"Added after reopen".** A task check is labelled so only when the shift has a `reopened`
  event **and** the check's `checked_at` (set by the database; clients cannot write it) is later
  than the shift's first `ended` event. A check that raced the first end without any reopen is
  not labelled.
- **Unchecks after a reopen.** Unchecking is allowed after a reopen. When a member unchecks a
  task that was checked in the original shift (`checked_at` no later than the first `ended`
  event), an `unchecked` event with the task and the member is appended. Unchecking a task that
  was checked after the reopen, or before any end, is not logged. Checks removed because a task,
  plan, shift, or family space was deleted are not unchecks and are not logged. If the task is
  later deleted, its `unchecked` events stay with no task (`task_id` null).
- A task check that races `end_visit` can land just after the end: each statement checks
  `ended_at` against its own snapshot. That is harmless for checks, but T3's photo lock must not
  rely on the same plain predicate: it must re-check `ended_at` under a row lock on the visit
  (`select ... for share`) or in a trigger.
- `delete_my_account` deletes every family space where you are the only parent (cascading all
  care info, contacts, plans, tasks, shifts, checks, and invites), removes your other
  memberships, and deletes your sign-in account. When a caretaker deletes their account, checks,
  notes, and shift-history entries they made stay in the family's history without their name
  (the user column becomes null, shown as a former member).
- Known limitation (same as Carekeeper): Supabase Realtime does not apply RLS to DELETE events,
  so a signed-in user subscribed to `task_checks` also receives the primary keys (two random
  UUIDs, no content) of unchecks in other family spaces. The same applies to `visits` and
  `shift_events` rows removed when a family space or plan is deleted (one random UUID each).
  Clients must ignore events for shifts they are not showing.

## Deploying to a hosted Supabase project

The migration does not depend on dashboard toggles, but two settings must match it:

- **Auth providers: Google only, with the Email provider OFF.** Invites trust the account's
  verified email. With email sign-up enabled (especially with "Confirm email" off), anyone could
  create a self-confirmed account under an invitee's address and accept their invite.
- **"Automatically expose new tables" OFF** (Data API settings), matching the migration's revoked
  default privileges, so a table added later is not exposed until a migration grants it.
