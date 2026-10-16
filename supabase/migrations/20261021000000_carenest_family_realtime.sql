-- CareNest: family data streams live (GitHub issue #11).
--
-- When a parent edits the schedule, care info, contacts, or the child's name on manage.html, a
-- sitter or co-parent with the app open sees it within a second or two, without a reload
-- (js/family-data.js subscribes after its first load and refetches on each change).
--
--   * Realtime applies RLS to INSERT and UPDATE events, so those reach only the household's
--     members (each table's existing select policy).
--   * DELETE events are not filtered by RLS: with the default replica identity they reach every
--     subscriber of the table carrying only the primary key (one random UUID, no content). The
--     replica identity is deliberately left at default (not FULL), so no deleted row's content is
--     ever broadcast. The client refetches on a DELETE only when that id is on screen. See the
--     README's known-limitation note.

alter publication supabase_realtime
  add table public.contacts, public.care_items, public.plans, public.tasks, public.households;
