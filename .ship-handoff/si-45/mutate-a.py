#!/usr/bin/env python3
"""SI-45 slice A mutation check: break one thing, confirm a test fails, restore it.

Each mutation is (id, what it breaks, break SQL, restore SQL). Runs only against this worktree's
local stack. A mutation counts as CAUGHT when the new tests exit non-zero and at least one named
test fails, and the suite is run once clean at the start and at the end.
"""
import json
import re
import subprocess
import sys
import time

TESTS = "/Users/kelvin/Projects/Care/CareNest/.claude/worktrees/si-45-a/tests"
DB = "postgresql://postgres:postgres@127.0.0.1:56722/postgres"
MIGRATION = "/Users/kelvin/Projects/Care/CareNest/.claude/worktrees/si-45-a/supabase/migrations/20261102000000_carenest_children.sql"
PATTERN = r"^(children:|care items:|home address:|contacts: one primary|every relation in public|authenticated can execute only)"

COLS = "id, household_id, name, age_label, stage_label, pinned_note, position, created_at"

SELECT_POLICY = 'create policy "Members can read children" on public.children for select to authenticated using (public.is_member(household_id));'
INSERT_POLICY = 'create policy "Parents can create children" on public.children for insert to authenticated with check (public.is_parent(household_id));'
UPDATE_POLICY = 'create policy "Parents can update children" on public.children for update to authenticated using (public.is_parent(household_id)) with check (public.is_parent(household_id));'
DELETE_POLICY = 'create policy "Parents can delete children" on public.children for delete to authenticated using (public.is_parent(household_id));'

DROP = lambda name: f'drop policy "{name}" on public.children;'

SYNC_TRIGGER = """create trigger households_sync_first_child after update of child_name, child_age_label on public.households
  for each row when (old.child_name is distinct from new.child_name or old.child_age_label is distinct from new.child_age_label)
  execute function public.sync_first_child();"""
CREATE_TRIGGER = "create trigger households_create_first_child after insert on public.households for each row execute function public.sync_first_child();"
ITEM_TRIGGER = "create trigger care_items_default_child before insert or update of category, child_id on public.care_items for each row execute function public.default_care_item_child();"

FK = """alter table public.care_items add constraint care_items_child_fkey foreign key (child_id, household_id)
  references public.children (id, household_id) on delete cascade;"""
CHECK = """alter table public.care_items add constraint care_items_family_wide_categories check (
  child_id is null or category in ('food', 'preferences', 'instructions'));"""
PRIMARY = "alter table public.contacts add constraint contacts_one_primary_per_household exclude using btree (household_id with =) where (is_primary) deferrable initially immediate;"

migration_sql = open(MIGRATION).read()


def fn(name):
    match = re.search(rf"create function public\.{name}\(.*?\n\$\$;\n", migration_sql, re.S)
    return match.group(0).replace("create function", "create or replace function", 1)


ENSURE = fn("ensure_first_child")
ITEM_FN = fn("default_care_item_child")
SYNC_FN = fn("sync_first_child")


def swap(text, old, new):
    """Replace exactly one occurrence, so a stale pattern fails here, not as a fake SURVIVED."""
    assert text.count(old) == 1, old
    return text.replace(old, new)


NAME_COPY = """case when old.child_name is distinct from new.child_name
                       then new.child_name else name end"""
AGE_COPY = """case when old.child_age_label is distinct from new.child_age_label
                            then new.child_age_label else age_label end"""
REREAD = ENSURE[ENSURE.index("  -- Re-read:") : ENSURE.index("  insert into public.children")]

MUTATIONS = [
    # Policies: dropped (a member or parent is wrongly refused) and widened (the wrong person is let in).
    ("P1a", "drop read policy", DROP("Members can read children"), SELECT_POLICY),
    ("P1b", "widen read policy to everyone signed in",
     DROP("Members can read children") + ' create policy "Members can read children" on public.children for select to authenticated using (true);',
     DROP("Members can read children") + SELECT_POLICY),
    ("P2a", "drop insert policy", DROP("Parents can create children"), INSERT_POLICY),
    ("P2b", "widen insert policy to members (sitters)",
     DROP("Parents can create children") + ' create policy "Parents can create children" on public.children for insert to authenticated with check (public.is_member(household_id));',
     DROP("Parents can create children") + INSERT_POLICY),
    ("P2c", "widen insert policy to anyone",
     DROP("Parents can create children") + ' create policy "Parents can create children" on public.children for insert to authenticated with check (true);',
     DROP("Parents can create children") + INSERT_POLICY),
    ("P3a", "drop update policy", DROP("Parents can update children"), UPDATE_POLICY),
    ("P3b", "widen update policy to members (sitters)",
     DROP("Parents can update children") + ' create policy "Parents can update children" on public.children for update to authenticated using (public.is_member(household_id)) with check (public.is_member(household_id));',
     DROP("Parents can update children") + UPDATE_POLICY),
    ("P3c", "widen update policy to anyone",
     DROP("Parents can update children") + ' create policy "Parents can update children" on public.children for update to authenticated using (true) with check (true);',
     DROP("Parents can update children") + UPDATE_POLICY),
    ("P4a", "drop delete policy", DROP("Parents can delete children"), DELETE_POLICY),
    ("P4b", "widen delete policy to members (sitters)",
     DROP("Parents can delete children") + ' create policy "Parents can delete children" on public.children for delete to authenticated using (public.is_member(household_id));',
     DROP("Parents can delete children") + DELETE_POLICY),
    ("P4c", "widen delete policy to anyone",
     DROP("Parents can delete children") + ' create policy "Parents can delete children" on public.children for delete to authenticated using (true);',
     DROP("Parents can delete children") + DELETE_POLICY),
    # Existing policies the address depends on.
    ("P5a", "households read policy open to everyone signed in",
     'drop policy "Members can read their household" on public.households; create policy "Members can read their household" on public.households for select to authenticated using (true);',
     'drop policy "Members can read their household" on public.households; create policy "Members can read their household" on public.households for select to authenticated using (public.is_member(id));'),
    ("P5b", "households update policy open to members (sitters)",
     'drop policy "Parents can update their household" on public.households; create policy "Parents can update their household" on public.households for update to authenticated using (public.is_member(id)) with check (public.is_member(id));',
     'drop policy "Parents can update their household" on public.households; create policy "Parents can update their household" on public.households for update to authenticated using (public.is_parent(id)) with check (public.is_parent(id));'),
    ("P5c", "contacts update policy open to members (sitters)",
     'drop policy "Parents can update contacts" on public.contacts; create policy "Parents can update contacts" on public.contacts for update to authenticated using (public.is_member(household_id)) with check (public.is_member(household_id));',
     'drop policy "Parents can update contacts" on public.contacts; create policy "Parents can update contacts" on public.contacts for update to authenticated using (public.is_parent(household_id)) with check (public.is_parent(household_id));'),
    ("P5d", "care_items update policy open to members (sitters)",
     'drop policy "Parents can update care items" on public.care_items; create policy "Parents can update care items" on public.care_items for update to authenticated using (public.is_member(household_id)) with check (public.is_member(household_id));',
     'drop policy "Parents can update care items" on public.care_items; create policy "Parents can update care items" on public.care_items for update to authenticated using (public.is_parent(household_id)) with check (public.is_parent(household_id));'),
    ("P5e", "care_items update with check dropped (an item can leave its family)",
     'drop policy "Parents can update care items" on public.care_items; create policy "Parents can update care items" on public.care_items for update to authenticated using (public.is_parent(household_id)) with check (true);',
     'drop policy "Parents can update care items" on public.care_items; create policy "Parents can update care items" on public.care_items for update to authenticated using (public.is_parent(household_id)) with check (public.is_parent(household_id));'),
    # RLS itself.
    ("R1", "disable RLS on children", "alter table public.children disable row level security;",
     "alter table public.children enable row level security;"),
    # Grants: taken away and widened.
    ("G1", "revoke select on one column", "revoke select (pinned_note) on public.children from authenticated;",
     "grant select (pinned_note) on public.children to authenticated;"),
    ("G2", "revoke insert on one column", "revoke insert (name) on public.children from authenticated;",
     "grant insert (name) on public.children to authenticated;"),
    ("G3", "revoke update on one column", "revoke update (name) on public.children from authenticated;",
     "grant update (name) on public.children to authenticated;"),
    ("G4", "revoke delete", "revoke delete on public.children from authenticated;",
     "grant delete on public.children to authenticated;"),
    ("G5", "grant update of household_id", "grant update (household_id) on public.children to authenticated;",
     "revoke update (household_id) on public.children from authenticated;"),
    ("G6", "grant update of id", "grant update (id) on public.children to authenticated;",
     "revoke update (id) on public.children from authenticated;"),
    ("G7", "grant update of created_at", "grant update (created_at) on public.children to authenticated;",
     "revoke update (created_at) on public.children from authenticated;"),
    ("G8", "grant insert of id", "grant insert (id) on public.children to authenticated;",
     "revoke insert (id) on public.children from authenticated;"),
    ("G9", "grant insert of created_at", "grant insert (created_at) on public.children to authenticated;",
     "revoke insert (created_at) on public.children from authenticated;"),
    ("G10", "table-wide select in place of columns", "grant select on public.children to authenticated;",
     f"revoke select on public.children from authenticated; grant select ({COLS}) on public.children to authenticated;"),
    ("G11", "grant truncate", "grant truncate on public.children to authenticated;",
     "revoke truncate on public.children from authenticated;"),
    ("G12", "grant children to anon", "grant select on public.children to anon;",
     "revoke select on public.children from anon;"),
    ("G13", "revoke update of home_address", "revoke update (home_address) on public.households from authenticated;",
     "grant update (home_address) on public.households to authenticated;"),
    # Triggers and functions.
    ("T1", "drop new-household trigger", "drop trigger households_create_first_child on public.households;", CREATE_TRIGGER),
    ("T2", "drop name/age sync trigger", "drop trigger households_sync_first_child on public.households;", SYNC_TRIGGER),
    ("T3", "sync trigger loses its WHEN guard",
     "drop trigger households_sync_first_child on public.households; create trigger households_sync_first_child after update on public.households for each row execute function public.sync_first_child();",
     "drop trigger households_sync_first_child on public.households;" + SYNC_TRIGGER),
    ("T4", "sync trigger misses age label",
     "drop trigger households_sync_first_child on public.households; create trigger households_sync_first_child after update of child_name on public.households for each row when (old.child_name is distinct from new.child_name) execute function public.sync_first_child();",
     "drop trigger households_sync_first_child on public.households;" + SYNC_TRIGGER),
    ("T5", "drop care item trigger", "drop trigger care_items_default_child on public.care_items;", ITEM_TRIGGER),
    ("T6", "care item trigger fires on insert only",
     "drop trigger care_items_default_child on public.care_items; create trigger care_items_default_child before insert on public.care_items for each row execute function public.default_care_item_child();",
     "drop trigger care_items_default_child on public.care_items;" + ITEM_TRIGGER),
    ("T7", "first child is the highest position", ENSURE.replace("order by c.position, c.created_at, c.id", "order by c.position desc, c.created_at, c.id"), ENSURE),
    ("T8", "no new first child when every child was deleted",
     ENSURE.replace("  perform 1 from public.households h where h.id = target_household_id for no key update;\n  if not found then", "  if true then"),
     ENSURE),
    ("T9", "trigger skips instructions", ITEM_FN.replace("in ('food', 'preferences', 'instructions')", "in ('food', 'preferences')"), ITEM_FN),
    ("T10", "trigger overwrites a chosen child", ITEM_FN.replace("new.child_id is null and ", ""), ITEM_FN),
    ("T11", "trigger gives family-wide categories a child (with the check dropped too)",
     "alter table public.care_items drop constraint care_items_family_wide_categories;" + ITEM_FN.replace("new.child_id is null and new.category in ('food', 'preferences', 'instructions')", "new.child_id is null"),
     "update public.care_items set child_id = null where category not in ('food', 'preferences', 'instructions');" + ITEM_FN + CHECK),
    ("T12", "sync copies the name but not the age", swap(SYNC_FN, ",\n           age_label = " + AGE_COPY, ""), SYNC_FN),
    ("T13", "care item trigger runs as the caller", "alter function public.default_care_item_child() security invoker;", "alter function public.default_care_item_child() security definer;"),
    ("T14", "clients can call ensure_first_child", "grant execute on function public.ensure_first_child(uuid) to authenticated;", "revoke execute on function public.ensure_first_child(uuid) from authenticated;"),
    ("T15", "clients can call sync_first_child", "grant execute on function public.sync_first_child() to authenticated;", "revoke execute on function public.sync_first_child() from authenticated;"),
    ("T16", "clients can call default_care_item_child", "grant execute on function public.default_care_item_child() to authenticated;", "revoke execute on function public.default_care_item_child() from authenticated;"),
    # Review round 1.
    ("T17", "sync copies both columns on any change (an old tab undoes a direct edit)",
     swap(swap(SYNC_FN, NAME_COPY, "new.child_name"), AGE_COPY, "new.child_age_label"), SYNC_FN),
    ("T18", "sync copies the changed age but always copies the name", swap(SYNC_FN, NAME_COPY, "new.child_name"), SYNC_FN),
    ("T19", "care item trigger ignores clearing child_id",
     "drop trigger care_items_default_child on public.care_items; create trigger care_items_default_child before insert or update of category on public.care_items for each row execute function public.default_care_item_child();",
     "drop trigger care_items_default_child on public.care_items;" + ITEM_TRIGGER),
    ("T20", "ensure_first_child takes no lock on the household", swap(ENSURE, " for no key update", ""), ENSURE),
    ("T21", "ensure_first_child does not re-read after the lock", swap(ENSURE, REREAD, ""), ENSURE),
    # Constraints.
    ("C1", "drop the composite foreign key", "alter table public.care_items drop constraint care_items_child_fkey;", FK),
    ("C2", "plain foreign key on child_id alone (another family's child accepted)",
     "alter table public.care_items drop constraint care_items_child_fkey; alter table public.care_items add constraint care_items_child_fkey foreign key (child_id) references public.children (id) on delete cascade;",
     "alter table public.care_items drop constraint care_items_child_fkey;" + FK),
    ("C3", "composite foreign key without cascade",
     "alter table public.care_items drop constraint care_items_child_fkey; alter table public.care_items add constraint care_items_child_fkey foreign key (child_id, household_id) references public.children (id, household_id) deferrable initially immediate;",
     "alter table public.care_items drop constraint care_items_child_fkey;" + FK),
    ("C4", "drop family-wide check", "alter table public.care_items drop constraint care_items_family_wide_categories;", CHECK),
    ("C5", "drop one-primary constraint", "alter table public.contacts drop constraint contacts_one_primary_per_household;", PRIMARY),
    ("C7", "drop home_address length check", "alter table public.households drop constraint households_home_address_check;",
     "alter table public.households add constraint households_home_address_check check (char_length(home_address) <= 200);"),
    ("C8", "drop children name length check", "alter table public.children drop constraint children_name_check;",
     "alter table public.children add constraint children_name_check check (char_length(name) <= 80);"),
    ("C9", "drop children age_label length check", "alter table public.children drop constraint children_age_label_check;",
     "alter table public.children add constraint children_age_label_check check (char_length(age_label) <= 40);"),
    ("C10", "drop children stage_label length check", "alter table public.children drop constraint children_stage_label_check;",
     "alter table public.children add constraint children_stage_label_check check (char_length(stage_label) <= 40);"),
    ("C11", "drop children pinned_note length check", "alter table public.children drop constraint children_pinned_note_check;",
     "alter table public.children add constraint children_pinned_note_check check (char_length(pinned_note) <= 200);"),
    ("C12", "children cascade from households removed",
     "alter table public.children drop constraint children_household_id_fkey; alter table public.children add constraint children_household_id_fkey foreign key (household_id) references public.households (id) on delete set default;",
     "alter table public.children drop constraint children_household_id_fkey; alter table public.children add constraint children_household_id_fkey foreign key (household_id) references public.households (id) on delete cascade;"),
    # Realtime.
    ("E1", "children removed from the publication", "alter publication supabase_realtime drop table public.children;",
     "alter publication supabase_realtime add table public.children;"),
]

# Backfill: the test reads the migration file, so these edit it and put it back.
FILE_MUTATIONS = [
    ("B1", "children backfill skips blank households",
     " where not exists (select 1 from public.children c where c.household_id = h.id);",
     " where not exists (select 1 from public.children c where c.household_id = h.id) and h.child_name <> '';"),
    ("B2", "children backfill not idempotent",
     " where not exists (select 1 from public.children c where c.household_id = h.id);",
     " where true;"),
    ("B3", "care item backfill misses instructions",
     "   and i.category in ('food', 'preferences', 'instructions');",
     "   and i.category in ('food', 'preferences');"),
    ("B4", "care item backfill takes every category",
     "   and i.category in ('food', 'preferences', 'instructions');",
     "   and i.category is not null;"),
    ("B5", "children backfill drops the age label",
     "select h.id, h.child_name, h.child_age_label\n  from public.households h\n where not exists",
     "select h.id, h.child_name, ''\n  from public.households h\n where not exists"),
]


def psql(sql):
    return subprocess.run(
        ["psql", DB, "-XAtq", "-v", "ON_ERROR_STOP=1"],
        input="begin;\n" + sql + "\ncommit;\n",
        capture_output=True,
        text=True,
        timeout=120,
    )


def tests():
    for attempt in range(3):
        result = subprocess.run(
            ["./stack.sh", "node", "--test", "--test-concurrency=1", f"--test-name-pattern={PATTERN}", "rls.test.mjs"],
            cwd=TESTS,
            capture_output=True,
            text=True,
            timeout=300,
        )
        out = result.stdout + result.stderr
        if "DbConnectError" not in out:
            break
        time.sleep(10)
    tail = out[out.find("failing tests") :] if "failing tests" in out else ""
    failed = sorted(set(re.findall(r"^✖ (.+?) \(\d", tail, re.M)))
    env = "DbConnectError" in out
    return result.returncode, failed, env


def record(handle, row):
    handle.write(json.dumps(row) + "\n")
    handle.flush()
    print(row["id"], row["result"], row["failed"][:2], flush=True)


def main():
    out_path = sys.argv[1]
    only = set(sys.argv[2:])
    with open(out_path, "a") as handle:
        code, failed, env = tests()
        record(handle, {"id": "BASE-start", "what": "no mutation", "result": "clean" if code == 0 else "DIRTY", "failed": failed, "env": env})
        if code != 0:
            sys.exit(1)
        for mid, what, broken, restore in MUTATIONS:
            if only and mid not in only:
                continue
            applied = psql(broken)
            if applied.returncode != 0:
                record(handle, {"id": mid, "what": what, "result": "NOT-APPLIED", "failed": [applied.stderr[:300]], "env": False})
                continue
            try:
                code, failed, env = tests()
            finally:
                undone = psql(restore)
            result = "ENV" if env else ("caught" if code != 0 and failed else "SURVIVED")
            record(handle, {"id": mid, "what": what, "result": result, "failed": failed, "env": env})
            if undone.returncode != 0:
                record(handle, {"id": mid + "-restore", "what": "restore failed", "result": "ABORT", "failed": [undone.stderr[:300]], "env": False})
                sys.exit(2)
        for mid, what, old, new in FILE_MUTATIONS:
            if only and mid not in only:
                continue
            assert migration_sql.count(old) == 1, mid
            open(MIGRATION, "w").write(migration_sql.replace(old, new))
            try:
                code, failed, env = tests()
            finally:
                open(MIGRATION, "w").write(migration_sql)
            result = "ENV" if env else ("caught" if code != 0 and failed else "SURVIVED")
            record(handle, {"id": mid, "what": what, "result": result, "failed": failed, "env": env})
        code, failed, env = tests()
        record(handle, {"id": "BASE-end", "what": "no mutation, everything restored", "result": "clean" if code == 0 else "DIRTY", "failed": failed, "env": env})


if __name__ == "__main__":
    main()
