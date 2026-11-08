// Authorization and integrity tests for Care Log page entries (SI-63/SI-64,
// 20261109000000_carenest_care_log_entries.sql): care_logs rows with no task, category 'note',
// about one child. Run against the LOCAL Supabase stack only.
//
//   cd tests && npm install && npm run db:start && npm run db:reset && npm run test:rls
//
// Keys are read from `supabase status` at runtime and never written anywhere. Test users get
// random throwaway passwords and are deleted when the run ends. Same helpers as care-logs.test.mjs.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createClient } from "@supabase/supabase-js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const status = JSON.parse(supabaseStatus());

// `supabase status` exits non-zero when services were left out with `db:start -- -x ...`, but
// still prints the JSON; take it when there is any.
function supabaseStatus() {
  try {
    return execFileSync("npx", ["supabase", "status", "-o", "json", "--workdir", repoRoot], {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    if (err.stdout?.trim().startsWith("{")) return err.stdout;
    throw err;
  }
}
const apiUrl = status.API_URL;
const publicKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
const serviceKey = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;

const host = new URL(apiUrl).hostname;
if (host !== "127.0.0.1" && host !== "localhost") {
  throw new Error(`Refusing to run against non-local Supabase at ${apiUrl}`);
}

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(apiUrl, serviceKey, clientOptions);
const anon = createClient(apiUrl, publicKey, clientOptions);

const run = randomUUID().slice(0, 8);
const createdUserIds = [];
const createdHouseholdIds = [];

async function signUp(label) {
  const email = `${label}-${run}@example.test`;
  const password = randomUUID();
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: `Test ${label}` },
  });
  assert.ifError(error);
  createdUserIds.push(data.user.id);
  const client = createClient(apiUrl, publicKey, clientOptions);
  const signIn = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signIn.error);
  return { client, email, id: data.user.id };
}

function assertRpcError(result, code) {
  assert.ok(result.error, `expected error ${code}`);
  assert.match(result.error.message, new RegExp(code));
}

function assertPermissionDenied(result, message) {
  assert.ok(result.error, message);
  assert.ok(
    result.error.code === "42501" || /permission denied/i.test(result.error.message),
    `${message}: expected permission denied, got ${result.error.code} ${result.error.message}`,
  );
}

function assertCheckViolation(result, message) {
  assert.ok(result.error, message);
  assert.equal(result.error.code, "23514", `${message}: got ${result.error.code} ${result.error.message}`);
}

// Only ever interpolate ids this run created.
function uuid(value) {
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  return value;
}

function localSql(sql) {
  const out = execFileSync(
    "npx",
    ["supabase", "db", "query", "--local", "--workdir", repoRoot, "--output-format", "json", sql],
    {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : (parsed.rows ?? parsed.data ?? parsed.result);
}

let dbToday;
function isoDate(offsetDays) {
  assert.ok(dbToday, "dbToday is read in before()");
  const date = new Date(`${dbToday}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

// A family space with a parent, a sitter (by invite), a plan with one task, and `childNames`
// children (create_household makes the first; the parent adds the rest). Children are returned
// in position order.
async function newFamily(label, childNames) {
  const parent = await signUp(`parent-${label}`);
  const sitter = await signUp(`sitter-${label}`);
  const h = await parent.client.rpc("create_household", { household_name: `Family ${label}`, acknowledged: true });
  assert.ifError(h.error);
  createdHouseholdIds.push(h.data);
  const token = await parent.client.rpc("create_invite", { target_household_id: h.data, invite_email: sitter.email });
  assert.ifError(token.error);
  assert.ifError((await sitter.client.rpc("accept_invite", { invite_token: token.data })).error);
  const first = await parent.client.from("children").select("id").eq("household_id", h.data).single();
  assert.ifError(first.error);
  assert.ifError((await parent.client.from("children").update({ name: childNames[0] }).eq("id", first.data.id)).error);
  const children = [{ id: first.data.id, name: childNames[0] }];
  for (const [i, name] of childNames.slice(1).entries()) {
    const c = await parent.client
      .from("children")
      .insert({ household_id: h.data, name, position: i + 1 })
      .select("id")
      .single();
    assert.ifError(c.error);
    children.push({ id: c.data.id, name });
  }
  const plan = await parent.client.from("plans").insert({ household_id: h.data, title: "Day" }).select().single();
  assert.ifError(plan.error);
  const task = await parent.client.from("tasks").insert({ plan_id: plan.data.id, title: "Snack", position: 0 }).select("id").single();
  assert.ifError(task.error);
  return { parent, sitter, householdId: h.data, planId: plan.data.id, taskId: task.data.id, children };
}

const addEntry = (user, row) => user.client.from("care_logs").insert({ category: "note", ...row }).select().single();

let fam; // two children (Jack, Kylie)
let famB; // another family with one child
let visitId; // fam, today, open
let firstEntry;

before(async () => {
  const [row] = localSql("select ((now() at time zone 'utc')::date)::text as today");
  dbToday = String(row.today).slice(0, 10);
  assert.match(dbToday, /^\d{4}-\d{2}-\d{2}$/);
  fam = await newFamily("cle-a", ["Jack Thomas", "Kylie Thomas"]);
  famB = await newFamily("cle-b", ["Sofia Rivera"]);
  const v = await fam.sitter.client.from("visits").insert({ plan_id: fam.planId, visit_date: isoDate(0) }).select().single();
  assert.ifError(v.error);
  visitId = v.data.id;
});

after(async () => {
  if (createdHouseholdIds.length) await admin.from("households").delete().in("id", createdHouseholdIds);
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

test("a sitter adds a task-less entry about each child; the database stamps author, role, household, time, and name", async () => {
  const before = Date.now();
  const jack = await addEntry(fam.sitter, { visit_id: visitId, child_id: fam.children[0].id, note: "Napped 1:00-2:15." });
  assert.ifError(jack.error);
  firstEntry = jack.data;
  assert.equal(firstEntry.task_id, null);
  assert.equal(firstEntry.category, "note");
  assert.equal(firstEntry.child_id, fam.children[0].id);
  assert.equal(firstEntry.child_name, "Jack Thomas", "the child's name is kept with the entry");
  assert.equal(firstEntry.author_id, fam.sitter.id);
  assert.equal(firstEntry.author_role, "caretaker");
  assert.equal(firstEntry.household_id, fam.householdId);
  assert.ok(Math.abs(Date.parse(firstEntry.created_at) - before) < 60_000, "created_at is the server's time");

  const kylie = await addEntry(fam.sitter, { visit_id: visitId, child_id: fam.children[1].id, note: "Built a fort." });
  assert.ifError(kylie.error);
  assert.equal(kylie.data.child_name, "Kylie Thomas");

  // Parents read the session log, oldest first, with each child.
  const read = await fam.parent.client
    .from("care_logs")
    .select("id, child_id, child_name, note")
    .eq("visit_id", visitId)
    .order("created_at");
  assert.ifError(read.error);
  assert.deepEqual(read.data.map((r) => r.child_id), [fam.children[0].id, fam.children[1].id]);
});

test("a child of another family, an unknown child, or no child is refused", async () => {
  assertRpcError(
    await addEntry(fam.sitter, { visit_id: visitId, child_id: famB.children[0].id, note: "x" }),
    "child_not_found",
  );
  assertRpcError(await addEntry(fam.sitter, { visit_id: visitId, child_id: randomUUID(), note: "x" }), "child_not_found");
  assertRpcError(await addEntry(fam.sitter, { visit_id: visitId, note: "About nobody" }), "child_required");
  // A task log may not name another family's child either.
  const check = await fam.parent.client.rpc("complete_task", { target_visit_id: visitId, target_task_id: fam.taskId });
  assert.ifError(check.error);
  assertRpcError(
    await fam.sitter.client
      .from("care_logs")
      .insert({ visit_id: visitId, task_id: fam.taskId, category: "care", note: "x", child_id: famB.children[0].id }),
    "child_not_found",
  );
});

test("entries keep the existing shape rules: a note has no task, other categories need one, never blank", async () => {
  const child = fam.children[0].id;
  const refused = {
    "a note on a task": { task_id: fam.taskId, child_id: child, note: "x" },
    "a care log without a task": { category: "care", child_id: child, note: "x" },
    "a meal log without a task": { category: "meal", child_id: child, meal_amount: "all" },
    "a blank note": { child_id: child, note: "   \n" },
    "an empty note": { child_id: child },
    "a note over 1000 characters": { child_id: child, note: "x".repeat(1001) },
    "a meal amount on a note": { child_id: child, note: "x", meal_amount: "all" },
    "ounces on a note": { child_id: child, note: "x", bottle_oz: 4 },
  };
  for (const [label, row] of Object.entries(refused)) {
    assertCheckViolation(await addEntry(fam.sitter, { visit_id: visitId, ...row }), label);
  }
  assert.ifError((await addEntry(fam.sitter, { visit_id: visitId, child_id: child, note: "y".repeat(1000) })).error);
});

test("the deployed client's task log (no child) works exactly as before", async () => {
  const log = await fam.sitter.client
    .from("care_logs")
    .insert({ visit_id: visitId, task_id: fam.taskId, category: "meal", meal_amount: "most", note: "", bottle_oz: null })
    .select()
    .single();
  assert.ifError(log.error);
  assert.equal(log.data.child_id, null);
  assert.equal(log.data.child_name, null);
  assert.equal(log.data.author_role, "caretaker");
});

test("another family's members and anonymous visitors cannot read or add entries", async () => {
  for (const user of [famB.parent, famB.sitter]) {
    const read = await user.client.from("care_logs").select("household_id");
    assert.ifError(read.error);
    assert.deepEqual(read.data.filter((r) => r.household_id === fam.householdId), [], "outsider reads entries");
    for (const child of [fam.children[0].id, famB.children[0].id]) {
      assertRpcError(await addEntry(user, { visit_id: visitId, child_id: child, note: "x" }), "visit_not_found");
    }
  }
  const anonRead = await anon.from("care_logs").select("*");
  assert.ok(anonRead.error || anonRead.data.length === 0, "anon reads care_logs");
  assertPermissionDenied(
    await anon.from("care_logs").insert({ visit_id: visitId, category: "note", child_id: fam.children[0].id, note: "x" }),
    "anon adds an entry",
  );
  assertRpcError(
    await admin.from("care_logs").insert({
      visit_id: visitId,
      category: "note",
      child_id: fam.children[0].id,
      note: "x",
      household_id: fam.householdId,
      author_id: fam.parent.id,
      author_role: "parent",
    }),
    "not_authenticated",
  );
});

test("clients cannot choose the author, role, household, time, child name, or id of an entry", async () => {
  const base = { visit_id: visitId, category: "note", child_id: fam.children[0].id, note: "x" };
  for (const [column, value] of Object.entries({
    author_id: fam.parent.id,
    author_role: "parent",
    household_id: famB.householdId,
    created_at: "2020-01-01T00:00:00Z",
    child_name: "Someone else",
    id: randomUUID(),
  })) {
    assertPermissionDenied(await fam.sitter.client.from("care_logs").insert({ ...base, [column]: value }), `client set ${column}`);
  }
  assert.deepEqual(
    localSql(`
      select has_column_privilege('authenticated', 'public.care_logs', 'child_id', 'insert') as child_id,
             has_column_privilege('authenticated', 'public.care_logs', 'child_name', 'insert') as child_name,
             has_any_column_privilege('authenticated', 'public.care_logs', 'update') as column_update,
             has_table_privilege('authenticated', 'public.care_logs', 'update, delete, truncate') as table_write,
             has_any_column_privilege('anon', 'public.care_logs', 'select, insert, update') as anon_any`),
    [{ child_id: true, child_name: false, column_update: false, table_write: false, anon_any: false }],
  );
});

test("entries are append-only: nobody updates or deletes one", async () => {
  for (const user of [fam.sitter, fam.parent]) {
    assertPermissionDenied(
      await user.client.from("care_logs").update({ note: "rewritten" }).eq("id", firstEntry.id).select(),
      "member updates an entry",
    );
    assertPermissionDenied(
      await user.client.from("care_logs").update({ child_id: fam.children[1].id }).eq("id", firstEntry.id).select(),
      "member moves an entry to another child",
    );
    assertPermissionDenied(await user.client.from("care_logs").delete().eq("id", firstEntry.id).select(), "member deletes an entry");
  }
  const stored = await admin.from("care_logs").select("*").eq("id", firstEntry.id).single();
  assert.ifError(stored.error);
  assert.deepEqual(stored.data, firstEntry, "the entry is unchanged");
});

test("entries are accepted only while the shift's date is in the window, open or ended", async () => {
  for (const offset of [-2, 2]) {
    const [{ id }] = localSql(`
      insert into public.visits (plan_id, visit_date) values ('${uuid(fam.planId)}', '${isoDate(offset)}')
      returning id::text as id`);
    for (const user of [fam.sitter, fam.parent]) {
      assertRpcError(await addEntry(user, { visit_id: uuid(id), child_id: fam.children[0].id, note: "late" }), "visit_too_old");
    }
  }
  const [{ id: yesterday }] = localSql(`
    insert into public.visits (plan_id, visit_date, ended_at) values ('${uuid(fam.planId)}', '${isoDate(-1)}', now())
    returning id::text as id`);
  assert.ifError((await addEntry(fam.sitter, { visit_id: uuid(yesterday), child_id: fam.children[0].id, note: "Recap" })).error);

  assert.ifError((await fam.sitter.client.rpc("end_visit", { target_visit_id: visitId })).error);
  assert.ifError((await addEntry(fam.sitter, { visit_id: visitId, child_id: fam.children[1].id, note: "Asleep by 8." })).error);
});

test("deleting a child keeps that child's entries, with the name they were written under", async () => {
  const extra = await fam.parent.client
    .from("children")
    .insert({ household_id: fam.householdId, name: "Baby Thomas", position: 5 })
    .select("id")
    .single();
  assert.ifError(extra.error);
  const entry = await addEntry(fam.sitter, { visit_id: visitId, child_id: extra.data.id, note: "Bottle at 4." });
  assert.ifError(entry.error);
  assert.ifError((await fam.parent.client.from("children").delete().eq("id", extra.data.id)).error);
  const kept = await fam.parent.client.from("care_logs").select("child_id, child_name, note").eq("id", entry.data.id).single();
  assert.ifError(kept.error);
  assert.deepEqual(kept.data, { child_id: null, child_name: "Baby Thomas", note: "Bottle at 4." });
});

test("stamp_care_log runs as its owner with an empty search_path", () => {
  const rows = localSql(`
    select p.prosecdef as definer, array_to_string(p.proconfig, ',') as config
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'stamp_care_log'`);
  assert.equal(rows.length, 1, "one stamp_care_log");
  assert.equal(rows[0].definer, true, "SECURITY DEFINER");
  assert.equal(rows[0].config, 'search_path=""', "search_path pinned to empty");
});

test("care_logs is published to Realtime, so entries reach the other phone live", () => {
  const rows = localSql(`
    select count(*)::int as n from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'care_logs'`);
  assert.equal(Number(rows[0].n), 1);
});

// A family with an open shift and an entry about each child (one by the sitter, one by the parent).
async function familyWithEntries(label) {
  const f = await newFamily(label, ["Ava Lee", "Ben Lee"]);
  const v = await f.sitter.client.from("visits").insert({ plan_id: f.planId, visit_date: isoDate(0) }).select().single();
  assert.ifError(v.error);
  assert.ifError((await addEntry(f.sitter, { visit_id: v.data.id, child_id: f.children[0].id, note: "Nap" })).error);
  assert.ifError((await addEntry(f.parent, { visit_id: v.data.id, child_id: f.children[1].id, note: "Snack" })).error);
  assert.equal(await countIn("care_logs", f.householdId), 2);
  return f;
}

async function countIn(table, householdId) {
  const { count, error } = await admin.from(table).select("*", { count: "exact", head: true }).eq("household_id", householdId);
  assert.ifError(error);
  return count;
}

test("deleting a family space with entries about its children removes the entries too", async () => {
  const f = await familyWithEntries("cle-delh");
  assert.ifError((await admin.from("households").delete().eq("id", f.householdId)).error);
  assert.equal(await countIn("care_logs", f.householdId), 0, "the entries are gone");
  assert.equal(await countIn("children", f.householdId), 0, "the children are gone");
  assert.ok((await countIn("care_logs", fam.householdId)) > 0, "other families' entries are untouched");
});

test("a sole parent's delete_my_account takes the family space and its entries about children", async () => {
  const f = await familyWithEntries("cle-dela");
  assert.ifError((await f.parent.client.rpc("delete_my_account")).error);
  assert.equal(await countIn("care_logs", f.householdId), 0, "the entries are gone");
  const { count } = await admin.from("households").select("*", { count: "exact", head: true }).eq("id", f.householdId);
  assert.equal(count, 0, "the family space is gone");
});
