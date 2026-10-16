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
`terms.html`. Every app page (`index`, `parent`, `people`, `messages`, `gallery`, `info`,
`food-allergies`) loads `js/auth.js`, which keeps the page hidden until it has checked the
session: signed out goes to `signin.html`, no family space goes to `onboarding.html`, a parent's
home is `parent.html`, a sitter's is `index.html`, and a page for the other role redirects to the
right one. The Account item in the nav signs out or deletes the account and its data. The child's
name and age, the schedule, care info (Good to know, food and allergies, emergency steps) and
contacts come from the family space in Supabase (`js/family-data.js` loads them into the shape
`js/data.js` defines); parents edit them on `manage.html` ("Family info" in the parent nav).
The top of the sitter's page (`index.html`) is an "Important today" section: the parent's notes
for that day (`day_notes`: routine change, special instruction, schedule change, food or
medication, other), each opening in place to its details and marked "Updated <time>" after a
parent edits it, or "No special updates for today." The day is today's local date (the browser's,
re-checked at local midnight); while a shift that started on an earlier local date is still open
(overnight, or never ended), the notes for that start date are shown too, under "Today" and the
start date's own heading. Parents pick the date for each note in the "Important today" card on
`manage.html`. The notes refresh live (Realtime), and if they
fail to load only that section says so.
The shift (start, end, reopen, history), task check-offs with photo proofs, moments, and the message thread are in Supabase (`js/shift-data.js`: Postgres, the private `photos` Storage bucket, and Realtime) for both roles; `?demo=1` keeps them in this browser (`js/store.js`). The parent's Today page (`parent.html`) shows today's shift status (not started / active / reopened / ended) with its history, "x of y done", the schedule (a parent can mark a task done without a photo, "Done by <name>", and end or reopen the shift), and a live feed of the shift's proofs and moments (Late, "Added after reopen", "Photo removed by <name>", replies, "New" until seen via `message_reads`). New photos (proofs, moments, and the sitter's photo messages) and shift events raise an in-app banner and a polite live announcement (no push notifications); View scrolls to a new feed photo, or opens the Gallery when only photo messages are new (they stay out of the Today feed). Save photo uses the Web Share API with files on touch devices, otherwise a JPEG download, and adds it to the parent's Album (`#album`, `photo_saves`). Remove photo calls `remove_photo` and then deletes the object from Storage. The concept alert (`concept_flags`) and "Bring moment forward" (`trigger_moment_now`) are demo controls shown only on localhost or with `?demo=1`; the concept alert is labelled "Concept — not real analysis". The Gallery (`gallery.html`, both roles; parents at `gallery.html?as=parent`) shows every photo of the family's shifts, oldest first with the newest at the bottom, under a heading per shift date, each labelled Task update, Photo message, or Moment, with a filter (native radios styled as chips); removed photos are skipped. The sitter's "+" (Add a photo) opens the phone's camera or library (`<input type="file" accept="image/*">`), then a dialog with the preview and an optional caption, and sends a photo message; it is disabled with the reason when the shift isn't open. A shift takes up to 20 photo messages; past that the sitter sees "Photo limit reached for this shift." Parents get "Remove photo" on each photo. Photo messages also show in the Messages thread. On `manage.html`, "Remove from schedule" archives a task (`archived_at`, stamped by the database); past shifts keep it.
Outside demo mode the bundled sample family is discarded before anything renders, so a
signed-in person never sees sample content; an empty family shows "No information provided".

`?demo=1` (remembered for the browser tab) shows the sample family from `js/data.js` with a
"Demo mode" banner, as before accounts existed. It does not sign anyone in or out: signed out, the
banner links to sign-in; signed in, it reads "Demo mode — signed in as <name> · Exit demo" (Exit
demo clears the flag). Sign-in, `invite.html`, and `onboarding.html` also clear it. Demo mode never
reads the database (signed-out requests can read nothing anyway) and never reads an account's
device data.

Demo data (`js/store.js`, `?demo=1` only: task photos, moments, messages, check-offs) is
localStorage. Signed-in people's photos and messages are not kept on the device. It is keyed per person: `carenest:demo:v1` for demo mode and
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
npm run test:unit    # care-log age parser, config port override (no database needed)
npm run db:lint      # supabase db lint
npm run db:stop
npm run db:env       # which stack this checkout uses, and its ports
```

Local ports: API `55321`, Postgres `55322`, Studio `55323`, Mailpit `55324`.

### Parallel worktrees

Every `npm run db:*` and `test:rls` goes through `tests/stack.sh`. In the main checkout it changes
nothing. In a linked git worktree (`git worktree add ../CareNest-x`) it runs a separate stack:
project `carenest-<worktree folder>` with its own containers and volumes, and every port shifted
by a slot (1-40) derived from the folder name, so one session's `db reset` cannot wipe another's
data. `npm run db:env` prints the slot and ports. If two worktrees land on the same slot,
`db:start` fails with "port is already allocated"; pick a free one with
`CARENEST_STACK_SLOT=<n> npm run db:start` and use the same variable for that worktree's other
commands. Stop stacks you are done with (`npm run db:stop`); each one holds a few GB of Docker
memory. When Docker is short on memory and `db:start` times out on health checks, start only what
the tests need: `npm run db:start -- -x studio,logflare,vector,edge-runtime,imgproxy,postgres-meta`.

To point the site at a worktree's stack, serve that checkout on its own port and open it once
with `?supabasePort=<API port>` (for example `http://localhost:8001/?supabasePort=57521`). The
page remembers it for that origin; `?supabasePort=` (empty) goes back to `55321`. The override
works only on localhost and only changes the port on `127.0.0.1`.

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
| `day_notes` | "Important today": notes for one calendar date (category, title, detail); who wrote and last edited each, and when | Parents add, edit, delete; members read. Authorship and edit times are set by the database (a trigger), so "Updated" cannot be forged; a note never moves to another family space |
| `plans`, `tasks` | The child's day (one plan per family space): ordered tasks with time, detail, location, care note, usual hours | Parents; archived tasks are frozen |
| `visits` | One babysitting shift per plan per date (yesterday, today, or tomorrow); start, handoff note, current end, moment time | Members start and write the note (dates in the window only); any member can `end_visit` and `reopen_visit` |
| `task_checks` | Which tasks are done in a shift, by whom, and when (`checked_at`) | Only `complete_task` (photo required for caretakers, optional for parents), while the shift is open and in the window; members uncheck |
| `shift_events` | Append-only shift history: ends, reopens, and unchecks of original-shift tasks after a reopen, with who, which task, and when | Nobody directly; only `end_visit`, `reopen_visit`, and the uncheck trigger write it. Members read |
| `care_logs` | Structured care details on a task completed in a shift: `meal` (amount all/most/some/none and/or a note), `bottle` (ounces, optional note), or `care` (a note); who wrote it, their role, and when | Members add logs to a checked task while the shift's date is in the window (open or ended). Author, role, household, and time are set by the database. Append-only: nobody edits or deletes; an edit is a new row |
| `messages` | Chat, photo messages (chat with a photo and its shift, caption optional), task proofs (photo, note, tag), and moments (photo, `late`); replies to a photo | Members post chat; sitters post photo messages and the shift's moment; proofs only via `complete_task`. Sender, role, time, and `late` are set by the database. Clients never edit or delete; a parent can remove a photo with `remove_photo` (the message stays, marked "Photo removed by …") |
| `message_reads` | Which messages a user has seen | Each user, for themselves; private |
| `photo_saves` | A parent's saved-photo album | Each parent, for themselves; private |
| `concept_flags` | **Concept only**: the demo "child seems off" alert on a photo; nothing analyses photos | Parents set and clear; members read |
| `removed_photos` | Every Storage path a parent removed (internal) | Nobody directly; only `remove_photo` and `remove_all_photos`. Clients cannot read it |
| Storage `photos` | Private bucket, 5 MB, JPEG/PNG/WebP, at `<household_id>/<visit_id>/<uuid>.<jpg\|png\|webp>` | Members upload into an open, in-window shift of their household (at most 2 photos per active task + 10 per shift); members read photos that were not removed; no overwrite |

## Data and risk boundaries

- Every table has Row Level Security enabled and denies by default. Signed-out (anon) requests
  can read nothing and call no function in `public`. The browser will only ever hold the public publishable
  key; there is no service-role or secret key in the app.
- Signed-in users get only the table and column privileges the app needs, and RLS narrows rows
  to their own household. Only parents change care info, contacts, plans, and tasks. Caretakers
  read everything in their household, start shifts, check and uncheck tasks, add care logs to
  checked tasks, and write the handoff note. Later migrations start closed too: new tables, sequences, and functions in
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
- Task checks cannot race `end_visit`: a `BEFORE INSERT` trigger on `task_checks` locks the visit
  (`for share`, which waits for `end_visit`'s `for update`) and re-checks the end and the date
  window for every signed-in insert, whatever path made it; `complete_task` also takes the same
  lock. Two-session tests cover both RPC paths and a raw insert.
- **Care logs (SI-28).** After a task is checked in a shift, any member (sitter or parent) can
  add a `care_logs` entry to it: `meal` (an amount, a note, or both), `bottle` (ounces, more than
  0 and at most 16, required), or `care` (a note, required); a note is at most 1000 characters.
  An empty entry is refused by `CHECK` constraints (the app shows "No information provided"
  instead of saving it), and a meal amount or ounces on the wrong category is refused too. Ounces
  are `numeric(3,1)`, so a value is rounded to 0.1 before the range check (the app rounds to 0.1
  as well). A `BEFORE INSERT` trigger (`stamp_care_log`, `SECURITY DEFINER`, empty `search_path`)
  requires a signed-in user (`not_authenticated`; the service role is refused too) who is a
  member of the shift's household (`visit_not_found`: a shift of another family looks the same
  as one that does not exist, as in `complete_task`), the shift's date in the window whether it
  is open or ended, like the handoff note (`visit_too_old`), a task of the shift's plan
  (`task_not_found`, as in `complete_task`; this is checked even if a `task_checks` row says
  otherwise), and the task checked in that shift at that moment, read under a share lock that
  serialises with a concurrent uncheck (`task_not_completed`); it sets the household, author,
  role, and time whatever the client sent (those columns are not even insertable). Two-session
  tests cover a log racing an uncheck in both orders. Append-only: members have no `UPDATE` or
  `DELETE` privilege, and an edit is a new row under the same task: the app keeps every entry
  visible under its task, oldest first, with later ones labelled "Update". The task's check and
  its `checked_at` are never touched; a later uncheck leaves earlier logs in place. Members
  read all logs of their household; anon nothing. Published to Realtime (the DELETE-event
  limitation below applies: one random UUID per log removed with a family space).
  `delete_my_account` cascades a sole parent's logs away; a departed sitter's logs stay without
  their name.
- Each check stores a snapshot of the task as it was when it was checked (`task_title`,
  `task_time_of_day`, `task_detail`, `task_location`, `task_care_note`), filled by the database.
  **Frontend: past shifts render the snapshot, not the live task.** Archived tasks are frozen
  (parents cannot edit them) and `archived_at` is stamped by the database and never changes back.
- Correction to a comment in the first migration (frozen): members cannot delete a task, a plan
  with shifts, or a visit, so no member action cascades checks away except `delete_my_account`
  removing a sole parent's whole family space. The service role can still delete visits.
- `delete_my_account` deletes every family space where you are the only parent (cascading all
  care info, contacts, plans, tasks, shifts, checks, and invites), removes your other
  memberships, and deletes your sign-in account. When a caretaker deletes their account, checks,
  notes, and shift-history entries they made stay in the family's history without their name
  (the user column becomes null, shown as a former member).
- Photos (T3a): the `photos` bucket is private (no public URLs). Members of the household in the
  path's first folder read; a member uploads only into an open shift of their household whose
  date is in the start window; nobody overwrites or moves a photo. A task is completed only with
  `complete_task(visit, task, photo_path, note, tag)`, which writes the check and the proof
  message together; proofs, moments, and photo messages re-check the shift under a share lock on
  the visit, so they cannot slip in after a concurrent `end_visit`. Chat stays open after a shift ends.
  Caretakers must attach a photo to complete a task; parents may check off without one (shown as
  done by them, no proof message). Each shift gets one moment prompt (`visits.moment_at`, chosen
  by the database at a random time from 30 minutes after the start to 30 minutes before the usual
  end, using the usual shift length parsed from the plan's schedule label such as "3:00pm -
  7:00pm", "3-7pm", "9am to 1pm", "15:00–19:00", or "9-5", which means 9am-5pm; "10pm-6am" is
  overnight; 30 minutes to 3 hours when the label is not understood, including labels with
  non-ASCII digits such as "３-７pm": an odd label never blocks starting a shift). A parent can call
  `trigger_moment_now(visit)` on an open, in-window shift with no moment yet to move it to 1-5
  minutes from now (demo). Only a sitter posts the moment, once; its photo must have been
  uploaded at or after the prompt (Storage's server-set `created_at`), otherwise
  `moment_photo_too_early`; it is `late` if posted more than 2 minutes after the prompt.
- Uploads: at most **2 photos per active (not archived) task of the plan + 10, + 20 for photo
  messages** per shift folder (every object in the folder counts, used or not, until it is
  deleted), so up to 20 photo messages never eat into the room task photos and the moment need.
  Over the cap the upload fails with
  `photo_limit_reached` (the app shows "Photo limit reached for this shift."); deleting an unused
  photo frees room. A sitter cannot delete a photo a message uses (a proof, moment, or photo
  message), so a used photo keeps its slot until a parent removes and deletes it. Never at a path
  a message uses or a parent removed.
- Photo removal: a parent may remove any photo in the family space. `remove_photo(message)`
  clears the message's photo, records `photo_removed_by`/`photo_removed_at` ("Photo removed by
  Mary"; the message, its task check, and the history stay), records the path in
  `removed_photos`, deletes every parent's save of it and its concept flag, and returns the path;
  the client then deletes the object with the Storage API. From the moment of removal, before the
  object is deleted, nobody can download it or sign a URL for it, nobody can upload to that path
  again, and it cannot be attached to a proof, moment, or photo message again (`photo_removed`). Saves and flags
  cannot be added to a removed photo, including one racing the removal (a trigger locks the
  message and re-checks; `photo_removed`).
- Photo messages: a `chat` row with `photo_path` and `visit_id` (the shift); the body may be empty.
  Only the sitter posts one, only into an open shift dated in the window, with a photo they
  uploaded to that shift's folder and no message uses yet (`not_caretaker`, `visit_ended`,
  `visit_too_old`, `photo_not_found`, `photo_removed`); it is never a reply. A parent removes its
  photo with `remove_photo` like any other (the message stays as a tombstone). A shift takes at
  most **20 live photo messages** (`stamp_message`, serialized per shift with an advisory lock;
  a removed one frees room); the 21st fails with `photo_limit_reached`. Saves and concept
  flags remain for proofs and moments only. The Gallery loads the newest 500 photos.
- Photo deletion: a photo no message uses can be deleted by its uploader (whether or not the
  shift is open) or by any parent; a removed photo only by a parent (the read policy shows it
  to a parent only inside a Storage delete request, using `storage.operation()`). Database
  cascades do not remove Storage objects, so deleting an account is three client steps:
  1. `remove_all_photos()`: in every family space where you are the only parent (the ones
     `delete_my_account()` deletes), removes every photo exactly as `remove_photo` does, and
     returns every Storage path in those family spaces' shift folders (removed and unused). For
     a sitter, or a parent with a co-parent, it does nothing and returns an empty list.
  2. `storage.from('photos').remove(paths)` with the returned list.
  3. `delete_my_account()`.
  If the client stops after step 1, the family space stays, with every photo marked "Photo
  removed by …" and no message pointing at a missing photo.
- Orphaned photos (issue #7, P1): a photo is readable only while its path's shift still exists in
  that household, so photos of a deleted shift or family space are hidden from everyone (and so
  cannot be deleted by clients either). But abandoned uploads in a shift that still exists (never
  attached to a proof, moment, or photo message) stay readable by the family's members, and every orphan stays
  stored, until a cleanup job exists.
- Known limitation (same as Carekeeper): Supabase Realtime does not apply RLS to DELETE events,
  so a signed-in user subscribed to `task_checks` also receives the primary keys (two random
  UUIDs, no content) of unchecks in other family spaces. The same applies to `visits` and
  `shift_events` rows removed when a family space or plan is deleted (one random UUID each), and
  to `messages` and `care_logs` (one random UUID each; clients never delete messages or care
  logs, so only cascades emit them), and to `day_notes` (one random UUID per deleted note).
  Clients must ignore events for shifts they are not showing.

## Deploying to a hosted Supabase project

The migration does not depend on dashboard toggles, but two settings must match it:

- **Auth providers: Google only, with the Email provider OFF.** Invites trust the account's
  verified email. With email sign-up enabled (especially with "Confirm email" off), anyone could
  create a self-confirmed account under an invitee's address and accept their invite.
- **"Automatically expose new tables" OFF** (Data API settings), matching the migration's revoked
  default privileges, so a table added later is not exposed until a migration grants it.
