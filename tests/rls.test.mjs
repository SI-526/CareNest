// Authorization tests for the CareNest database, run against the LOCAL Supabase stack only.
//
//   cd tests && npm install && npm run db:start && npm run db:reset && npm run test:rls
//
// Keys are read from `supabase status` at runtime and never written anywhere. Test users get
// random throwaway passwords and are deleted when the run ends.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createClient } from "@supabase/supabase-js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const status = JSON.parse(
  execFileSync("npx", ["supabase", "status", "-o", "json", "--workdir", repoRoot], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }),
);
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

// A write is denied when Postgres raises (missing privilege / RLS check) or RLS hides every row.
function assertDenied(result, message) {
  if (result.error) return;
  assert.deepEqual(result.data ?? [], [], message);
}

function assertRpcError(result, code) {
  assert.ok(result.error, `expected RPC error ${code}`);
  assert.match(result.error.message, new RegExp(code));
}

// Postgres "insufficient_privilege" (missing GRANT), as PostgREST reports it.
function assertPermissionDenied(result, message) {
  assert.ok(result.error, message);
  assert.ok(
    result.error.code === "42501" || /permission denied/i.test(result.error.message),
    `${message}: expected permission denied, got ${result.error.code} ${result.error.message}`,
  );
}

// The database's UTC date, read once in before(). Test dates derive from it (not the JS clock),
// so the suite cannot disagree with the visits insert policy near 00:00 UTC.
let dbToday;

// A calendar date `offsetDays` from the database's UTC date, as YYYY-MM-DD.
function isoDate(offsetDays) {
  assert.ok(dbToday, "dbToday is read in before()");
  const date = new Date(`${dbToday}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

// Multi-row inserts whose rows set different columns. supabase-js defaults to defaultToNull:
// true, which makes PostgREST send NULL for a column a row omits (and NOT NULL columns with a
// default then fail). defaultToNull: false sends `Prefer: missing=default`, so omitted columns
// take their column default, exactly as a single-row insert does.
const BULK_INSERT = { defaultToNull: false };

const DEMO_HOUSEHOLD_ID = "00000000-0000-4000-8000-00000000c0de";

const tables = [
  "households",
  "household_members",
  "invites",
  "care_items",
  "contacts",
  "plans",
  "tasks",
  "visits",
  "task_checks",
  "shift_events",
];

const rpcs = [
  ["create_household", { household_name: "X", acknowledged: true }],
  ["create_invite", { target_household_id: randomUUID(), invite_email: "x@example.test" }],
  ["accept_invite", { invite_token: "x" }],
  ["end_visit", { target_visit_id: randomUUID() }],
  ["reopen_visit", { target_visit_id: randomUUID() }],
  ["delete_my_account", {}],
  ["is_member", { target_household_id: randomUUID() }],
  ["is_parent", { target_household_id: randomUUID() }],
];

let parentA;
let parentB;
let caretaker;
let outsider;
let householdA;
let householdB;
let planA;
let taskIds;
let careItemIds;
let contactIds;
let visitId;
let parentVisitId;
let oldVisitId;

before(async () => {
  const [row] = localSql("select ((now() at time zone 'utc')::date)::text as today");
  dbToday = String(row.today).slice(0, 10);
  assert.match(dbToday, /^\d{4}-\d{2}-\d{2}$/);
  parentA = await signUp("parent-a");
  parentB = await signUp("parent-b");
  caretaker = await signUp("caretaker");
  outsider = await signUp("outsider");
});

after(async () => {
  if (createdHouseholdIds.length) {
    await admin.from("households").delete().in("id", createdHouseholdIds);
  }
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
});

test("creating a household requires the risk acknowledgement", async () => {
  const refused = await parentA.client.rpc("create_household", {
    household_name: "Family A",
    acknowledged: false,
  });
  assertRpcError(refused, "risk_not_acknowledged");

  const a = await parentA.client.rpc("create_household", {
    household_name: "Family A",
    acknowledged: true,
  });
  assert.ifError(a.error);
  householdA = a.data;
  createdHouseholdIds.push(householdA);

  const b = await parentB.client.rpc("create_household", {
    household_name: "Family B",
    acknowledged: true,
  });
  assert.ifError(b.error);
  householdB = b.data;
  createdHouseholdIds.push(householdB);

  const second = await parentA.client.rpc("create_household", {
    household_name: "Another",
    acknowledged: true,
  });
  assertRpcError(second, "already_member");

  const { data } = await admin
    .from("households")
    .select("risk_acknowledged_at")
    .eq("id", householdA)
    .single();
  assert.ok(data.risk_acknowledged_at);
});

test("parent can set the child's details but not system columns", async () => {
  const a = parentA.client;
  const updated = await a
    .from("households")
    .update({ child_name: "Jack Thomas", child_age_label: "Age 3" })
    .eq("id", householdA)
    .select()
    .single();
  assert.ifError(updated.error);
  assert.equal(updated.data.child_name, "Jack Thomas");

  const backdate = await a
    .from("households")
    .update({ risk_acknowledged_at: "2000-01-01T00:00:00Z" })
    .eq("id", householdA)
    .select();
  assert.ok(backdate.error, "risk_acknowledged_at is not client-writable");
  const reassign = await a
    .from("households")
    .update({ created_by: parentB.id })
    .eq("id", householdA)
    .select();
  assert.ok(reassign.error, "created_by is not client-writable");
  assertDenied(await a.from("households").delete().eq("id", householdA).select());
  assertDenied(
    await a
      .from("households")
      .insert({ name: "Sneaky", risk_acknowledged_at: new Date().toISOString() })
      .select(),
  );
});

test("parent can create plans, tasks, care items, and contacts", async () => {
  const a = parentA.client;
  const plan = await a
    .from("plans")
    .insert({ household_id: householdA, title: "Weekday afternoon", schedule: "3:00pm - 7:00pm" })
    .select()
    .single();
  assert.ifError(plan.error);
  planA = plan.data;

  const tasks = await a
    .from("tasks")
    .insert([
      { plan_id: planA.id, title: "Snack", time_of_day: "13:30", detail: "Apples", position: 0 },
      {
        plan_id: planA.id,
        title: "Playground",
        time_of_day: "15:00",
        location: "3175 Gallup Park Rd",
        care_note: "Pack snacks",
        position: 1,
      },
    ], BULK_INSERT)
    .select();
  assert.ifError(tasks.error);
  taskIds = tasks.data.map((t) => t.id);
  assert.equal(tasks.data[0].time_of_day, "13:30:00");

  const items = await a
    .from("care_items")
    .insert([
      { household_id: householdA, category: "preferences", title: "Comfort item", detail: "Ellie" },
      { household_id: householdA, category: "food", title: "Nut-free", severity: "Severe" },
      { household_id: householdA, category: "emergency", title: "Call 911", position: 1 },
    ], BULK_INSERT)
    .select();
  assert.ifError(items.error);
  careItemIds = items.data.map((i) => i.id);

  const contacts = await a
    .from("contacts")
    .insert([
      { household_id: householdA, name: "Mary Ann Thomas", role: "Parent", phone: "588-909-3489" },
      { household_id: householdA, name: "Mott", role: "Hospital", address: "1540 E Hospital Dr" },
    ], BULK_INSERT)
    .select();
  assert.ifError(contacts.error);
  contactIds = contacts.data.map((c) => c.id);

  const tooLong = await a.from("plans").update({ title: "x".repeat(81) }).eq("id", planA.id).select();
  assert.equal(tooLong.error?.code, "23514", "title over 80 characters is rejected");
  // One plan per household: a second plan (e.g. two tabs racing to create it) is refused.
  const secondPlan = await a
    .from("plans")
    .insert({ household_id: householdA, title: "Second plan" })
    .select();
  assert.equal(secondPlan.error?.code, "23505", "a household has at most one plan");
  const badCategory = await a
    .from("care_items")
    .insert({ household_id: householdA, category: "secrets", title: "x" });
  assert.ok(badCategory.error, "unknown care category is rejected");
  const badSeverity = await a
    .from("care_items")
    .insert({ household_id: householdA, category: "food", title: "x", severity: "Deadly" });
  assert.ok(badSeverity.error, "unknown severity is rejected");
  const severityOutsideFood = await a
    .from("care_items")
    .insert({ household_id: householdA, category: "where", title: "x", severity: "Mild" });
  assert.ok(severityOutsideFood.error, "severity only applies to food items");
});

test("parent B cannot read or modify household A", async () => {
  assert.ok(householdA, "householdA was not created by an earlier test");
  assert.ok(planA?.id, "planA was not created by an earlier test");
  assert.ok(taskIds?.length, "taskIds were not created by an earlier test");
  const b = parentB.client;
  for (const table of tables) {
    const { data, error } = await b.from(table).select("*");
    assert.ifError(error);
    const leaked = data.filter(
      (row) => [row.household_id, row.id].includes(householdA) || row.plan_id === planA.id,
    );
    assert.deepEqual(leaked, [], `parent B sees household A rows in ${table}`);
  }

  assertDenied(
    await b.from("households").update({ child_name: "Hacked" }).eq("id", householdA).select(),
  );
  assertDenied(
    await b.from("plans").insert({ household_id: householdA, title: "Intruder" }).select(),
  );
  assertDenied(await b.from("plans").update({ title: "Hacked" }).eq("id", planA.id).select());
  assertDenied(await b.from("plans").delete().eq("id", planA.id).select());
  assertDenied(await b.from("tasks").insert({ plan_id: planA.id, title: "Intruder" }).select());
  assertDenied(await b.from("tasks").update({ title: "Hacked" }).in("id", taskIds).select());
  assertDenied(await b.from("tasks").delete().in("id", taskIds).select());
  assertDenied(
    await b
      .from("care_items")
      .insert({ household_id: householdA, category: "where", title: "Intruder" })
      .select(),
  );
  assertDenied(
    await b.from("care_items").update({ title: "Hacked" }).in("id", careItemIds).select(),
  );
  assertDenied(await b.from("care_items").delete().in("id", careItemIds).select());
  assertDenied(
    await b.from("contacts").insert({ household_id: householdA, name: "Intruder" }).select(),
  );
  assertDenied(await b.from("contacts").update({ phone: "911" }).in("id", contactIds).select());
  assertDenied(await b.from("contacts").delete().in("id", contactIds).select());
  assertDenied(await b.from("visits").insert({ plan_id: planA.id }).select());
  assertRpcError(
    await b.rpc("create_invite", {
      target_household_id: householdA,
      invite_email: "x@example.test",
    }),
    "not_parent",
  );

  // Moving one's own row into another household is refused too.
  const own = await b
    .from("contacts")
    .insert({ household_id: householdB, name: "Mine" })
    .select()
    .single();
  assert.ifError(own.error);
  assertDenied(
    await b.from("contacts").update({ household_id: householdA }).eq("id", own.data.id).select(),
  );

  const { data: household } = await admin
    .from("households")
    .select("child_name")
    .eq("id", householdA)
    .single();
  assert.equal(household.child_name, "Jack Thomas");
  const { data: plan } = await admin.from("plans").select("title").eq("id", planA.id).single();
  assert.equal(plan.title, "Weekday afternoon");
  for (const [table, column, value, expected] of [
    ["tasks", "plan_id", planA.id, 2],
    ["care_items", "household_id", householdA, 3],
    ["contacts", "household_id", householdA, 2],
  ]) {
    const { count } = await admin
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq(column, value);
    assert.equal(count, expected, `${table} count changed`);
  }
});

test("a signed-in user with no household sees nothing, including the seeded demo family", async () => {
  // Without this, the test would also pass if seed.sql had not loaded.
  const demo = await admin.from("households").select("id").eq("id", DEMO_HOUSEHOLD_ID);
  assert.ifError(demo.error);
  assert.equal(demo.data.length, 1, "seed.sql loaded the demo household (run `npm run db:reset`)");
  const { count: demoItems } = await admin
    .from("care_items")
    .select("*", { count: "exact", head: true })
    .eq("household_id", DEMO_HOUSEHOLD_ID);
  assert.ok(demoItems > 0, "seed.sql loaded the demo care items");

  for (const table of tables) {
    const { data, error } = await outsider.client.from(table).select("*");
    assert.ifError(error);
    assert.deepEqual(data, [], `outsider reads ${table}`);
  }
});

test("invite acceptance enforces email, expiry, revocation, and single use", async () => {
  const a = parentA.client;
  const invite = () =>
    a.rpc("create_invite", { target_household_id: householdA, invite_email: caretaker.email });
  const accept = (user, token) => user.client.rpc("accept_invite", { invite_token: token });

  const expired = await invite();
  assert.ifError(expired.error);
  await admin
    .from("invites")
    .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
    .eq("token_hash", sha256(expired.data));
  assertRpcError(await accept(caretaker, expired.data), "invite_expired");

  const revoked = await invite();
  assert.ifError(revoked.error);
  const revoke = await a
    .from("invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token_hash", sha256(revoked.data))
    .select();
  assert.equal(revoke.data?.length, 1, "parent can revoke an invite");
  const unrevoke = await a
    .from("invites")
    .update({ revoked_at: null })
    .eq("token_hash", sha256(revoked.data))
    .select();
  assert.ok(unrevoke.error, "a revoked invite cannot be reactivated");
  assertRpcError(await accept(caretaker, revoked.data), "invite_revoked");

  const superseded = await invite();
  assert.ifError(superseded.error);
  const good = await invite();
  assert.ifError(good.error);
  assertRpcError(await accept(caretaker, superseded.data), "invite_revoked");
  assertRpcError(await accept(outsider, good.data), "invite_wrong_email");
  assertRpcError(await accept(caretaker, "not-a-real-token"), "invite_not_found");

  // The right address is not enough: it must also be verified.
  const setConfirmed = (value) =>
    localSql(`
      with u as (
        update auth.users set email_confirmed_at = ${value}
         where id = '${uuid(caretaker.id)}'
        returning id
      )
      select count(*)::int as n from u`);
  assert.equal(setConfirmed("null")[0].n, 1);
  try {
    assertRpcError(await accept(caretaker, good.data), "invite_wrong_email");
  } finally {
    assert.equal(setConfirmed("now()")[0].n, 1);
  }

  const accepted = await accept(caretaker, good.data);
  assert.ifError(accepted.error);
  assert.equal(accepted.data, householdA);

  assertRpcError(await accept(caretaker, good.data), "invite_used");
  assertRpcError(await accept(outsider, good.data), "invite_used");

  const { data: stored } = await admin
    .from("invites")
    .select("token_hash")
    .eq("household_id", householdA);
  assert.ok(stored.every((row) => /^[0-9a-f]{64}$/.test(row.token_hash)));
  assert.ok(!stored.some((row) => row.token_hash === good.data), "plain token is not stored");
});

test("caretaker can read the household's schedule and care info", async () => {
  const c = caretaker.client;
  const household = await c.from("households").select("*");
  assert.deepEqual(
    household.data.map((h) => h.id),
    [householdA],
  );

  const plans = await c.from("plans").select("*");
  assert.ifError(plans.error);
  assert.deepEqual(
    plans.data.map((p) => p.id),
    [planA.id],
  );

  for (const [table, expected] of [
    ["tasks", 2],
    ["care_items", 3],
    ["contacts", 2],
  ]) {
    const { data, error } = await c.from(table).select("*");
    assert.ifError(error);
    assert.equal(data.length, expected, `caretaker reads ${table}`);
  }

  const members = await c.from("household_members").select("role");
  assert.ifError(members.error);
  assert.deepEqual(members.data.map((m) => m.role).sort(), ["caretaker", "parent"]);
});

test("caretaker cannot change the household, schedule, care info, invites, or members", async () => {
  const c = caretaker.client;
  assertDenied(
    await c.from("households").update({ child_name: "Changed" }).eq("id", householdA).select(),
  );
  assertDenied(await c.from("plans").insert({ household_id: householdA, title: "New" }).select());
  assertDenied(await c.from("plans").update({ title: "Changed" }).eq("id", planA.id).select());
  assertDenied(await c.from("plans").delete().eq("id", planA.id).select());
  assertDenied(await c.from("tasks").insert({ plan_id: planA.id, title: "New" }).select());
  assertDenied(await c.from("tasks").update({ title: "Changed" }).in("id", taskIds).select());
  assertDenied(await c.from("tasks").delete().in("id", taskIds).select());
  assertDenied(
    await c
      .from("care_items")
      .insert({ household_id: householdA, category: "where", title: "New" })
      .select(),
  );
  assertDenied(
    await c.from("care_items").update({ detail: "Changed" }).in("id", careItemIds).select(),
  );
  assertDenied(await c.from("care_items").delete().in("id", careItemIds).select());
  assertDenied(await c.from("contacts").insert({ household_id: householdA, name: "New" }).select());
  assertDenied(await c.from("contacts").update({ phone: "000" }).in("id", contactIds).select());
  assertDenied(await c.from("contacts").delete().in("id", contactIds).select());

  assertRpcError(
    await c.rpc("create_invite", {
      target_household_id: householdA,
      invite_email: "friend@example.test",
    }),
    "not_parent",
  );
  const invites = await c.from("invites").select("*");
  assert.deepEqual(invites.data, [], "caretaker cannot list invites");
  assertDenied(
    await c
      .from("invites")
      .update({ revoked_at: new Date().toISOString() })
      .eq("household_id", householdA)
      .select(),
  );

  assertDenied(
    await c
      .from("household_members")
      .insert({
        household_id: householdA,
        user_id: outsider.id,
        role: "caretaker",
        email: outsider.email,
      })
      .select(),
  );
  assertDenied(await c.from("household_members").delete().eq("user_id", parentA.id).select());
  assertDenied(
    await c
      .from("household_members")
      .update({ role: "parent" })
      .eq("user_id", caretaker.id)
      .select(),
  );

  const { data: household } = await admin
    .from("households")
    .select("child_name")
    .eq("id", householdA)
    .single();
  assert.equal(household.child_name, "Jack Thomas");
  const { data: tasks } = await admin.from("tasks").select("title").eq("plan_id", planA.id);
  assert.deepEqual(tasks.map((t) => t.title).sort(), ["Playground", "Snack"]);
  const { data: items } = await admin.from("care_items").select("detail").in("id", careItemIds);
  assert.ok(!items.some((i) => i.detail === "Changed"));
  const { count: contactCount } = await admin
    .from("contacts")
    .select("*", { count: "exact", head: true })
    .eq("household_id", householdA);
  assert.equal(contactCount, 2);
  const { data: roles } = await admin
    .from("household_members")
    .select("role")
    .eq("household_id", householdA);
  assert.deepEqual(roles.map((m) => m.role).sort(), ["caretaker", "parent"]);
});

test("caretaker can start a shift, check tasks, and write the handoff", async () => {
  const c = caretaker.client;
  const forgedEnd = await c
    .from("visits")
    .insert({ plan_id: planA.id, visit_date: isoDate(0), ended_at: new Date().toISOString() })
    .select();
  assert.ok(forgedEnd.error, "ended_at cannot be set when starting a shift");

  // A shift can only be started for yesterday, today, or tomorrow (database UTC date). The
  // refusal checks use ±3 days so they hold even if the date rolls over mid-suite.
  // Visit dates used on planA in this suite: 0 (caretaker), -1 (parent), +1 (refused after
  // removal), so no two can collide on unique (plan_id, visit_date).
  for (const offset of [-3, 3, 365]) {
    const outOfRange = await c
      .from("visits")
      .insert({ plan_id: planA.id, visit_date: isoDate(offset) })
      .select();
    assert.ok(outOfRange.error, `a shift ${offset} days away is refused`);
  }

  const visit = await c
    .from("visits")
    .insert({ plan_id: planA.id, visit_date: isoDate(0) })
    .select()
    .single();
  assert.ifError(visit.error);
  visitId = visit.data.id;
  assert.equal(visit.data.started_by, caretaker.id);
  assert.equal(visit.data.ended_at, null);

  const spoofed = await c
    .from("task_checks")
    .insert({ visit_id: visitId, task_id: taskIds[0], checked_by: parentA.id })
    .select();
  assert.ok(spoofed.error, "checked_by cannot be chosen by the client");
  assertPermissionDenied(
    await c
      .from("task_checks")
      .insert({ visit_id: visitId, task_id: taskIds[0], checked_at: "2000-01-01T00:00:00Z" })
      .select(),
    "checked_at cannot be chosen by the client",
  );

  const check = await c
    .from("task_checks")
    .insert({ visit_id: visitId, task_id: taskIds[0] })
    .select()
    .single();
  assert.ifError(check.error);
  assert.equal(check.data.checked_by, caretaker.id);
  assertPermissionDenied(
    await c
      .from("task_checks")
      .upsert(
        { visit_id: visitId, task_id: taskIds[0], checked_at: "2000-01-01T00:00:00Z" },
        { onConflict: "visit_id,task_id" },
      )
      .select(),
    "an upsert cannot rewrite checked_at",
  );

  const uncheck = await c
    .from("task_checks")
    .delete()
    .eq("visit_id", visitId)
    .eq("task_id", taskIds[0])
    .select();
  assert.equal(uncheck.data?.length, 1, "caretaker can uncheck");
  const { count: earlyEvents } = await admin
    .from("shift_events")
    .select("*", { count: "exact", head: true })
    .eq("visit_id", visitId);
  assert.equal(earlyEvents, 0, "an uncheck before the shift ever ended is not logged");
  assert.ifError(
    (await c.from("task_checks").insert({ visit_id: visitId, task_id: taskIds[0] })).error,
  );

  const handoff = await c
    .from("visits")
    .update({ handoff_note: "Great afternoon." })
    .eq("id", visitId)
    .select()
    .single();
  assert.ifError(handoff.error);
  assert.equal(handoff.data.handoff_by, caretaker.id);
  assert.ok(handoff.data.handoff_at);

  const rewrite = await c
    .from("visits")
    .update({ started_by: parentA.id })
    .eq("id", visitId)
    .select();
  assert.ok(rewrite.error, "only the handoff note is writable on a visit");
  const directEnd = await c
    .from("visits")
    .update({ ended_at: new Date().toISOString() })
    .eq("id", visitId)
    .select();
  assert.ok(directEnd.error, "ending a shift only goes through end_visit");

  const b = parentB.client;
  assertDenied(
    await b.from("task_checks").insert({ visit_id: visitId, task_id: taskIds[1] }).select(),
  );
  assertDenied(await b.from("task_checks").delete().eq("visit_id", visitId).select());
  assertDenied(
    await b.from("visits").update({ handoff_note: "Hacked" }).eq("id", visitId).select(),
  );
  const parentView = await parentA.client.from("task_checks").select("*").eq("visit_id", visitId);
  assert.equal(parentView.data.length, 1, "parent sees the caretaker's check");
});

test("a shift ends once, only by a member, and its checks are then frozen", async () => {
  assertRpcError(
    await parentB.client.rpc("end_visit", { target_visit_id: visitId }),
    "visit_not_found",
  );
  assertRpcError(
    await outsider.client.rpc("end_visit", { target_visit_id: visitId }),
    "visit_not_found",
  );
  assertRpcError(
    await caretaker.client.rpc("end_visit", { target_visit_id: randomUUID() }),
    "visit_not_found",
  );

  const ended = await caretaker.client.rpc("end_visit", { target_visit_id: visitId });
  assert.ifError(ended.error);
  assert.ok(ended.data, "end_visit returns the end time");
  assertRpcError(
    await parentA.client.rpc("end_visit", { target_visit_id: visitId }),
    "visit_already_ended",
  );

  const { data: visit } = await admin
    .from("visits")
    .select("ended_at, ended_by")
    .eq("id", visitId)
    .single();
  assert.ok(visit.ended_at);
  assert.equal(visit.ended_by, caretaker.id);
  // One timestamp for the visit's end, the 'ended' event, and the return value.
  const { data: endEvent } = await admin
    .from("shift_events")
    .select("created_at")
    .eq("visit_id", visitId)
    .eq("kind", "ended")
    .single();
  assert.deepEqual(
    [ended.data, endEvent.created_at].map(Date.parse),
    [Date.parse(visit.ended_at), Date.parse(visit.ended_at)],
    "end_visit's return value, visits.ended_at, and the event's created_at agree",
  );
  assert.deepEqual(
    localSql(`
      select (v.ended_at = e.created_at) as same
        from public.visits v join public.shift_events e on e.visit_id = v.id
       where v.id = '${uuid(visitId)}' and e.kind = 'ended'`),
    [{ same: true }],
    "visits.ended_at equals the 'ended' event's created_at to the microsecond",
  );

  const c = caretaker.client;
  assertDenied(
    await c.from("task_checks").insert({ visit_id: visitId, task_id: taskIds[1] }).select(),
    "cannot check after the shift ended",
  );
  assertDenied(
    await c.from("task_checks").delete().eq("visit_id", visitId).select(),
    "cannot uncheck after the shift ended",
  );
  const { count } = await admin
    .from("task_checks")
    .select("*", { count: "exact", head: true })
    .eq("visit_id", visitId);
  assert.equal(count, 1);

  const lateNote = await c
    .from("visits")
    .update({ handoff_note: "Added after the shift." })
    .eq("id", visitId)
    .select();
  assert.equal(lateNote.data?.length, 1, "handoff note stays writable after the shift");

  // A parent can start and end a shift too.
  const parentVisit = await parentA.client
    .from("visits")
    .insert({ plan_id: planA.id, visit_date: isoDate(-1) })
    .select()
    .single();
  assert.ifError(parentVisit.error);
  parentVisitId = parentVisit.data.id;
  assert.ifError(
    (await parentA.client.rpc("end_visit", { target_visit_id: parentVisitId })).error,
  );
});

test("any member can reopen an ended shift in the start window, and every end and reopen is logged", async () => {
  const reopen = (user, id) => user.client.rpc("reopen_visit", { target_visit_id: id });
  const events = (user) =>
    user.client
      .from("shift_events")
      .select("kind, actor_id, created_at")
      .eq("visit_id", visitId)
      .order("created_at")
      .order("id");

  // Not a member of the household (or no such shift): indistinguishable.
  assertRpcError(await reopen(parentB, visitId), "visit_not_found");
  assertRpcError(await reopen(outsider, visitId), "visit_not_found");
  assertRpcError(await reopen(parentA, randomUUID()), "visit_not_found");
  const stillEnded = await admin.from("visits").select("ended_at").eq("id", visitId).single();
  assert.ok(stillEnded.data.ended_at, "a refused reopen leaves the shift ended");

  // The caretaker can reopen (e.g. they ended it by mistake).
  assert.ifError((await reopen(caretaker, visitId)).error);
  const { data: reopened } = await admin
    .from("visits")
    .select("ended_at, ended_by, handoff_note")
    .eq("id", visitId)
    .single();
  assert.deepEqual(reopened, {
    ended_at: null,
    ended_by: null,
    handoff_note: "Added after the shift.",
  });
  assertRpcError(await reopen(parentA, visitId), "visit_not_ended");

  // Open again: the caretaker checks another task (a backfill), then ends the shift again.
  const c = caretaker.client;
  assert.ifError(
    (await c.from("task_checks").insert({ visit_id: visitId, task_id: taskIds[1] })).error,
  );
  assert.ifError((await c.rpc("end_visit", { target_visit_id: visitId })).error);
  assertDenied(
    await c.from("task_checks").delete().eq("visit_id", visitId).select(),
    "checks are frozen again after the second end",
  );

  // A parent can reopen too, and end it.
  assert.ifError((await reopen(parentA, visitId)).error);
  assert.ifError((await parentA.client.rpc("end_visit", { target_visit_id: visitId })).error);

  // History: every end and reopen, in order, with who did it. Both members read it.
  const expected = [
    ["ended", caretaker.id],
    ["reopened", caretaker.id],
    ["ended", caretaker.id],
    ["reopened", parentA.id],
    ["ended", parentA.id],
  ];
  for (const member of [parentA, caretaker]) {
    const { data, error } = await events(member);
    assert.ifError(error);
    assert.deepEqual(
      data.map((e) => [e.kind, e.actor_id]),
      expected,
      "shift events are recorded in order with their actors",
    );
  }
  const { data: current } = await admin
    .from("visits")
    .select("ended_by")
    .eq("id", visitId)
    .single();
  assert.equal(current.ended_by, parentA.id, "visits keeps the latest end as current state");

  // Backfill: "Added after reopen" = the shift has a 'reopened' event and the check's
  // checked_at is later than the first 'ended' event.
  const { data: history } = await events(parentA);
  const firstEnd = Date.parse(history.find((e) => e.kind === "ended").created_at);
  const wasReopened = history.some((e) => e.kind === "reopened");
  const { data: checks } = await parentA.client
    .from("task_checks")
    .select("task_id, checked_at")
    .eq("visit_id", visitId);
  const afterReopen = Object.fromEntries(
    checks.map((row) => [row.task_id, wasReopened && Date.parse(row.checked_at) > firstEnd]),
  );
  assert.deepEqual(afterReopen, { [taskIds[0]]: false, [taskIds[1]]: true });

  // Other households and signed-in strangers see no events.
  for (const stranger of [parentB, outsider]) {
    const { data, error } = await events(stranger);
    assert.ifError(error);
    assert.deepEqual(data, [], "non-members read no shift events");
  }

  // Nobody writes shift_events directly; only end_visit/reopen_visit do.
  for (const member of [parentA, caretaker]) {
    const s = member.client.from("shift_events");
    assertPermissionDenied(
      await s.insert({ visit_id: visitId, kind: "reopened", actor_id: member.id }).select(),
      "direct insert into shift_events",
    );
    assertPermissionDenied(
      await s.update({ kind: "ended" }).eq("visit_id", visitId).select(),
      "direct update of shift_events",
    );
    assertPermissionDenied(
      await s.delete().eq("visit_id", visitId).select(),
      "direct delete from shift_events",
    );
  }
  const { count: eventCount } = await admin
    .from("shift_events")
    .select("*", { count: "exact", head: true })
    .eq("visit_id", visitId);
  assert.equal(eventCount, expected.length, "refused writes left the history unchanged");

  // A shift outside the start window (database UTC date ±1) cannot be reopened, so old days
  // cannot be backfilled. Clients cannot create such a visit, so the local SQL helper does.
  [{ id: oldVisitId }] = localSql(`
    insert into public.visits (plan_id, visit_date, ended_at)
    values ('${uuid(planA.id)}', '${isoDate(-5)}', now())
    returning id::text as id`);
  uuid(oldVisitId);
  assertRpcError(await reopen(parentA, oldVisitId), "visit_too_old");
  assertRpcError(await reopen(caretaker, oldVisitId), "visit_too_old");
  const { data: old } = await admin.from("visits").select("ended_at").eq("id", oldVisitId).single();
  assert.ok(old.ended_at, "a too-old shift stays ended");
});

test("unchecking an original-shift task after a reopen is logged; later checks are not", async () => {
  const fam = await newFamily("uncheck", 5);
  const t = fam.taskIds;
  const s = fam.sitter.client;
  const p = fam.parent.client;
  const visit = await s.from("visits").insert({ plan_id: fam.planId }).select().single();
  assert.ifError(visit.error);
  const id = visit.data.id;
  for (const task of t.slice(0, 4)) {
    assert.ifError((await s.from("task_checks").insert({ visit_id: id, task_id: task })).error);
  }
  assert.ifError((await s.rpc("end_visit", { target_visit_id: id })).error);
  assert.ifError((await p.rpc("reopen_visit", { target_visit_id: id })).error);
  assert.ifError((await s.from("task_checks").insert({ visit_id: id, task_id: t[4] })).error);

  const uncheck = (user, task) =>
    user.client.from("task_checks").delete().eq("visit_id", id).eq("task_id", task).select();
  assert.equal((await uncheck(fam.sitter, t[0])).data?.length, 1, "sitter unchecks an original check");
  assert.equal((await uncheck(fam.parent, t[1])).data?.length, 1, "parent unchecks an original check");
  assert.equal((await uncheck(fam.sitter, t[4])).data?.length, 1, "sitter unchecks a post-reopen check");

  // Members cannot delete a task at all; archiving one keeps its original-shift check and
  // logs no uncheck.
  assertPermissionDenied(await p.from("tasks").delete().eq("id", t[2]).select(), "parent deletes a task");
  const archived = await p
    .from("tasks")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", t[2])
    .select();
  assert.ifError(archived.error);
  assert.equal(archived.data.length, 1);
  const { count: t2Checks } = await admin
    .from("task_checks")
    .select("*", { count: "exact", head: true })
    .eq("visit_id", id)
    .eq("task_id", t[2]);
  assert.equal(t2Checks, 1, "archiving a task keeps its check");

  const history = (user) =>
    user.client
      .from("shift_events")
      .select("kind, actor_id, task_id")
      .eq("visit_id", id)
      .order("created_at")
      .order("id");
  const expected = [
    { kind: "ended", actor_id: fam.sitter.id, task_id: null },
    { kind: "reopened", actor_id: fam.parent.id, task_id: null },
    { kind: "unchecked", actor_id: fam.sitter.id, task_id: t[0] },
    { kind: "unchecked", actor_id: fam.parent.id, task_id: t[1] },
  ];
  for (const member of [fam.parent, fam.sitter]) {
    const { data, error } = await history(member);
    assert.ifError(error);
    assert.deepEqual(data, expected, "only original-shift unchecks are logged, with task and actor");
  }

  // An archived task's 'unchecked' event keeps its task.
  assert.ifError(
    (await p.from("tasks").update({ archived_at: new Date().toISOString() }).eq("id", t[0])).error,
  );
  const { data: afterArchive } = await history(fam.parent);
  assert.deepEqual(afterArchive, expected, "archiving a task leaves its history untouched");

  // The service role (no signed-in member) removing an original check after the reopen is not
  // a member's uncheck and logs nothing.
  const serviceDelete = await admin
    .from("task_checks")
    .delete()
    .eq("visit_id", id)
    .eq("task_id", t[3])
    .select();
  assert.ifError(serviceDelete.error);
  assert.equal(serviceDelete.data.length, 1);
  assert.equal(await countEvents((q) => q.eq("visit_id", id)), expected.length, "service delete logged nothing");

  // A plan with shifts cannot be deleted (its shifts' checks and history would go with it).
  assertDenied(await p.from("plans").delete().eq("id", fam.planId).select(), "delete plan with shifts");
  const { count: planCount } = await admin
    .from("plans")
    .select("*", { count: "exact", head: true })
    .eq("id", fam.planId);
  assert.equal(planCount, 1, "the plan survived");
  assert.equal(await countEvents((q) => q.eq("visit_id", id)), expected.length);

  // A plan with no shifts yet can still be deleted (its tasks go with it).
  const fresh = await newFamily("fresh-plan", 2);
  const deletedPlan = await fresh.parent.client.from("plans").delete().eq("id", fresh.planId).select();
  assert.ifError(deletedPlan.error);
  assert.equal(deletedPlan.data.length, 1);
  const { count: freshTasks } = await admin
    .from("tasks")
    .select("*", { count: "exact", head: true })
    .in("id", fresh.taskIds);
  assert.equal(freshTasks, 0);
});

test("re-checking a task after a reopen and unchecking it after a second reopen logs nothing", async () => {
  const fam = await newFamily("recheck", 1);
  const [x] = fam.taskIds;
  const s = fam.sitter.client;
  const visit = await s.from("visits").insert({ plan_id: fam.planId }).select().single();
  assert.ifError(visit.error);
  const id = visit.data.id;
  const rpc = (name) => s.rpc(name, { target_visit_id: id });
  assert.ifError((await rpc("end_visit")).error);
  assert.ifError((await rpc("reopen_visit")).error);
  assert.ifError((await s.from("task_checks").insert({ visit_id: id, task_id: x })).error);
  assert.ifError((await rpc("end_visit")).error);
  assert.ifError((await rpc("reopen_visit")).error);
  const unchecked = await s.from("task_checks").delete().eq("visit_id", id).eq("task_id", x).select();
  assert.equal(unchecked.data?.length, 1);
  const { data } = await s.from("shift_events").select("kind").eq("visit_id", id).order("created_at");
  assert.deepEqual(
    data.map((e) => e.kind),
    ["ended", "reopened", "ended", "reopened"],
    "a check made after the first end is not an original-shift check",
  );
});

test("a parent archives a task: its past checks and history stay, and it cannot be checked again", async () => {
  const fam = await newFamily("archive", 2);
  const [t0, t1] = fam.taskIds;
  const s = fam.sitter.client;
  const p = fam.parent.client;
  const visit = await s.from("visits").insert({ plan_id: fam.planId }).select().single();
  assert.ifError(visit.error);
  const id = visit.data.id;
  assert.ifError((await s.from("task_checks").insert({ visit_id: id, task_id: t0 })).error);
  assert.ifError((await s.rpc("end_visit", { target_visit_id: id })).error);

  // A caretaker cannot archive (or delete) a task.
  assertDenied(
    await s.from("tasks").update({ archived_at: new Date().toISOString() }).eq("id", t0).select(),
    "caretaker archives a task",
  );
  assertPermissionDenied(await s.from("tasks").delete().eq("id", t0).select(), "caretaker deletes a task");
  const { data: stillActive } = await admin.from("tasks").select("archived_at").eq("id", t0).single();
  assert.equal(stillActive.archived_at, null, "caretaker's archive was refused");

  const archived = await p
    .from("tasks")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", t0)
    .select();
  assert.ifError(archived.error);
  assert.equal(archived.data.length, 1);
  assert.ok(archived.data[0].archived_at);

  // The past check and the shift's history remain, and members still read the archived task.
  for (const member of [fam.parent, fam.sitter]) {
    const checks = await member.client.from("task_checks").select("task_id").eq("visit_id", id);
    assert.deepEqual(checks.data, [{ task_id: t0 }], "the past check remains");
    const events = await member.client.from("shift_events").select("kind").eq("visit_id", id);
    assert.deepEqual(events.data, [{ kind: "ended" }], "the shift's history remains");
    const task = await member.client.from("tasks").select("id, archived_at").eq("id", t0);
    assert.equal(task.data?.length, 1, "members still read the archived task");
    const schedule = await member.client
      .from("tasks")
      .select("id")
      .eq("plan_id", fam.planId)
      .is("archived_at", null);
    assert.deepEqual(schedule.data, [{ id: t1 }], "the schedule shows only active tasks");
  }

  // After a reopen, the archived task cannot be checked; an active task can.
  assert.ifError((await s.rpc("reopen_visit", { target_visit_id: id })).error);
  assert.ifError((await s.from("task_checks").delete().eq("visit_id", id).eq("task_id", t0)).error);
  assertDenied(
    await s.from("task_checks").insert({ visit_id: id, task_id: t0 }).select(),
    "check on an archived task",
  );
  const active = await s.from("task_checks").insert({ visit_id: id, task_id: t1 }).select();
  assert.ifError(active.error);
  assert.equal(active.data.length, 1);

  // Even the service role cannot delete a task that still has checks: the foreign key no longer
  // cascades, so history cannot be erased by deleting a task.
  const serviceDelete = await admin.from("tasks").delete().eq("id", t1).select();
  assert.equal(serviceDelete.error?.code, "23503", "a checked task cannot be deleted");
  const { count } = await admin
    .from("task_checks")
    .select("*", { count: "exact", head: true })
    .eq("visit_id", id);
  assert.equal(count, 1);
});

test("an uncheck that races end_visit is refused once the shift has ended", async (t) => {
  if (!psqlAvailable()) {
    t.skip("psql is not on PATH; this two-session test needs a direct database connection");
    return;
  }
  const fam = await newFamily("race", 1);
  const [task] = fam.taskIds;
  const s = fam.sitter.client;
  const visit = await s.from("visits").insert({ plan_id: fam.planId }).select().single();
  assert.ifError(visit.error);
  const id = visit.data.id;
  assert.ifError((await s.from("task_checks").insert({ visit_id: id, task_id: task })).error);

  // Session 1 (psql, as the parent): end the shift and hold the transaction open.
  const marker = `race-${randomUUID()}`;
  const claims = JSON.stringify({ sub: uuid(fam.parent.id), role: "authenticated" });
  const session = spawnPsql(`
    begin;
    set local role authenticated;
    select set_config('request.jwt.claims', '${claims}', true);
    select public.end_visit('${uuid(id)}');
    select pg_sleep(4) /* ${marker} */;
    commit;`);
  // Wait until session 1 has ended the shift (it is now sleeping, holding the visit's lock).
  await waitFor(() =>
    psqlQuery(`select count(*) from pg_stat_activity where state = 'active' and query like '%${marker}%' and query not like '%pg_stat_activity%'`) === "1",
  );

  // Session 2 (the sitter, through the API): the delete policy still sees the shift open, so
  // the uncheck waits on the visit's lock and, once the end commits, is refused.
  const raced = await s.from("task_checks").delete().eq("visit_id", id).eq("task_id", task).select();
  assert.equal(await session, 0, "session 1 committed");
  assert.ok(raced.error, "the racing uncheck is refused");
  assert.match(raced.error.message, /visit_ended/);
  const { count } = await admin
    .from("task_checks")
    .select("*", { count: "exact", head: true })
    .eq("visit_id", id);
  assert.equal(count, 1, "the check survived on the ended shift");
  const { data: ended } = await admin.from("visits").select("ended_at").eq("id", id).single();
  assert.ok(ended.ended_at);
});

test("a shift dated outside yesterday..tomorrow (UTC) is read-only, under any session time zone", async () => {
  const fam = await newFamily("window", 2);
  const [t0, t1] = fam.taskIds;
  const visitOn = {};
  // Clients cannot start these shifts, so the local SQL helper does: open shifts 2 days before
  // and after the database's UTC date, and an open shift 3 days old, each with one check on it
  // (so the refused unchecks below have a row to refuse).
  for (const offset of [-3, -2, 2]) {
    [{ id: visitOn[offset] }] = localSql(`
      insert into public.visits (plan_id, visit_date, started_by)
      values ('${uuid(fam.planId)}', '${isoDate(offset)}', '${uuid(fam.sitter.id)}')
      returning id::text as id`);
    uuid(visitOn[offset]);
  }
  localSql(`
    insert into public.task_checks (visit_id, task_id, checked_by)
    select v.id, '${uuid(t0)}', '${uuid(fam.sitter.id)}'
      from unnest(array['${uuid(visitOn[-3])}', '${uuid(visitOn[-2])}', '${uuid(visitOn[2])}']::uuid[]) as v(id)
    returning task_id::text as task_id`);
  for (const offset of [-1, 1]) {
    const v = await fam.sitter.client
      .from("visits")
      .insert({ plan_id: fam.planId, visit_date: isoDate(offset) })
      .select()
      .single();
    assert.ifError(v.error);
    visitOn[offset] = v.data.id;
  }

  // The window is the database's UTC date, whatever session time zone the client asks for.
  // The time-zone clients send PostgREST's `Prefer: timezone=...` header on every request.
  const members = [
    ["default time zone", fam.sitter],
    ["Etc/GMT-14 (UTC+14)", await inTimeZone(fam.sitter, "Etc/GMT-14")],
    ["Etc/GMT+12 (UTC-12)", await inTimeZone(fam.sitter, "Etc/GMT+12")],
  ];
  const check = (user, offset, task) =>
    user.client.from("task_checks").insert({ visit_id: visitOn[offset], task_id: task }).select();
  const uncheck = (user, offset) =>
    user.client.from("task_checks").delete().eq("visit_id", visitOn[offset]).select();
  const rpc = (user, name, offset) => user.client.rpc(name, { target_visit_id: visitOn[offset] });

  for (const [label, user] of members) {
    // Out of the window: no check, no uncheck, no handoff note, even though nobody ended it.
    for (const offset of [-3, -2, 2]) {
      assertDenied(await check(user, offset, t1), `${label}: check ${offset} days away`);
      assertDenied(await uncheck(user, offset), `${label}: uncheck ${offset} days away`);
      assertDenied(
        await user.client
          .from("visits")
          .update({ handoff_note: "Late" })
          .eq("id", visitOn[offset])
          .select(),
        `${label}: handoff note ${offset} days away`,
      );
    }
    // In the window: check and uncheck work.
    for (const offset of [-1, 1]) {
      const checked = await check(user, offset, t0);
      assert.ifError(checked.error);
      assert.equal(checked.data.length, 1, `${label}: check ${offset} days away`);
      assert.equal((await uncheck(user, offset)).data?.length, 1, `${label}: uncheck ${offset}`);
    }
  }
  const { data: oldChecks } = await admin
    .from("task_checks")
    .select("task_id")
    .in("visit_id", [visitOn[-3], visitOn[-2], visitOn[2]]);
  assert.deepEqual(
    oldChecks,
    [{ task_id: t0 }, { task_id: t0 }, { task_id: t0 }],
    "every out-of-window shift's check survived the refusals",
  );

  // A shift nobody ended can still be ended for the record, in or out of the window...
  for (const offset of [-3, -2, 2, -1, 1]) {
    assert.ifError((await rpc(fam.sitter, "end_visit", offset)).error, `end ${offset}`);
  }
  // ...but only yesterday, today, or tomorrow can be reopened, under every time zone.
  for (const [label, user] of members) {
    for (const offset of [-3, -2, 2]) {
      assertRpcError(await rpc(user, "reopen_visit", offset), "visit_too_old");
    }
    for (const offset of [-1, 1]) {
      assert.ifError((await rpc(user, "reopen_visit", offset)).error, `${label}: reopen ${offset}`);
      assert.ifError((await rpc(user, "end_visit", offset)).error, `${label}: end ${offset}`);
    }
  }
  for (const [label, user] of members.slice(1)) {
    assert.ok(user.applied() > 0, `${label}: PostgREST did not confirm the Prefer: timezone header`);
  }
});

test("after shifts exist, parent B still sees nothing of household A", async () => {
  // Every household A id must exist first: an undefined id would match any row lacking that
  // column (undefined === undefined) and report a false leak instead of the real cause.
  for (const [name, id] of Object.entries({ householdA, visitId, parentVisitId, oldVisitId })) {
    assert.ok(id, `${name} was not created by an earlier test`);
  }
  assert.ok(planA?.id, "planA was not created by an earlier test");
  assert.ok(taskIds?.length, "taskIds were not created by an earlier test");
  const b = parentB.client;
  for (const table of tables) {
    const { data, error } = await b.from(table).select("*");
    assert.ifError(error);
    const leaked = data.filter(
      (row) =>
        [row.household_id, row.id].includes(householdA) ||
        row.plan_id === planA.id ||
        [visitId, parentVisitId, oldVisitId].includes(row.visit_id) ||
        taskIds.includes(row.task_id),
    );
    assert.deepEqual(leaked, [], `parent B sees household A rows in ${table}`);
  }
});

test("anonymous visitors can read nothing and call no RPC", async () => {
  for (const table of tables) {
    const { data, error } = await anon.from(table).select("*");
    assert.ok(error || data.length === 0, `anon read ${table}`);
  }
  for (const [name, args] of rpcs) {
    assertPermissionDenied(await anon.rpc(name, args), `anon called ${name}`);
  }
  assertDenied(
    await anon.from("care_items").insert({ household_id: householdA, category: "where", title: "x" }).select(),
  );
  assertDenied(await anon.from("contacts").insert({ household_id: householdA, name: "x" }).select());
});

test("parent can remove a caretaker, who then loses access", async () => {
  const removed = await parentA.client
    .from("household_members")
    .delete()
    .eq("household_id", householdA)
    .eq("user_id", caretaker.id)
    .select();
  assert.equal(removed.data?.length, 1);

  for (const table of [
    "households",
    "plans",
    "tasks",
    "care_items",
    "contacts",
    "visits",
    "task_checks",
    "shift_events",
  ]) {
    const { data } = await caretaker.client.from(table).select("*");
    assert.deepEqual(data, [], `removed caretaker still reads ${table}`);
  }
  assertDenied(
    await caretaker.client
      .from("visits")
      .update({ handoff_note: "Still here?" })
      .eq("id", visitId)
      .select(),
  );
  assertDenied(
    await caretaker.client.from("visits").insert({ plan_id: planA.id, visit_date: isoDate(1) }).select(),
  );
  for (const rpc of ["end_visit", "reopen_visit"]) {
    assertRpcError(
      await caretaker.client.rpc(rpc, { target_visit_id: visitId }),
      "visit_not_found",
    );
  }
});

test("delete_my_account removes the sole parent's household data and account", async () => {
  // Leave an open, reopened shift with an original-shift check in household A: the cascade
  // must neither fail on that check nor log it as an uncheck.
  const a = parentA.client;
  const open = await a
    .from("visits")
    .insert({ plan_id: planA.id, visit_date: isoDate(1) })
    .select()
    .single();
  assert.ifError(open.error);
  assert.ifError(
    (await a.from("task_checks").insert({ visit_id: open.data.id, task_id: taskIds[0] })).error,
  );
  assert.ifError((await a.rpc("end_visit", { target_visit_id: open.data.id })).error);
  assert.ifError((await a.rpc("reopen_visit", { target_visit_id: open.data.id })).error);
  const householdVisits = [visitId, parentVisitId, oldVisitId, open.data.id];
  const before = await countEvents();
  const own = await countEvents((q) => q.in("visit_id", householdVisits));
  assert.ok(own > 0);

  const result = await a.rpc("delete_my_account");
  assert.ifError(result.error);
  assert.equal(
    await countEvents(),
    before - own,
    "the cascade removed household A's history and logged nothing new",
  );

  for (const [table, column, value] of [
    ["households", "id", householdA],
    ["household_members", "household_id", householdA],
    ["invites", "household_id", householdA],
    ["care_items", "household_id", householdA],
    ["contacts", "household_id", householdA],
    ["plans", "household_id", householdA],
    ["tasks", "plan_id", planA.id],
    ["visits", "plan_id", planA.id],
    ["task_checks", "visit_id", visitId],
    ["shift_events", "visit_id", visitId],
  ]) {
    const { count } = await admin
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq(column, value);
    assert.equal(count, 0, `${table} rows remain after account deletion`);
  }

  const { data } = await admin.auth.admin.getUserById(parentA.id);
  assert.equal(data.user, null, "auth user is deleted");

  for (const [table, column, value] of [
    ["households", "id", householdB],
    ["contacts", "household_id", householdB],
  ]) {
    const { count } = await admin
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq(column, value);
    assert.equal(count, 1, `other households' ${table} are untouched`);
  }
});

test("a caretaker deleting their account keeps the family's history without their name", async () => {
  // Fresh family with a caretaker who checks a task, then deletes their account.
  const parent = await signUp("parent-c");
  const sitter = await signUp("sitter-c");
  const h = await parent.client.rpc("create_household", {
    household_name: "Family C",
    acknowledged: true,
  });
  assert.ifError(h.error);
  createdHouseholdIds.push(h.data);
  const token = await parent.client.rpc("create_invite", {
    target_household_id: h.data,
    invite_email: sitter.email,
  });
  assert.ifError((await sitter.client.rpc("accept_invite", { invite_token: token.data })).error);
  const plan = await parent.client
    .from("plans")
    .insert({ household_id: h.data, title: "Day" })
    .select()
    .single();
  const task = await parent.client
    .from("tasks")
    .insert({ plan_id: plan.data.id, title: "Nap" })
    .select()
    .single();
  const visit = await sitter.client.from("visits").insert({ plan_id: plan.data.id }).select().single();
  assert.ifError(visit.error);
  assert.ifError(
    (await sitter.client.from("task_checks").insert({ visit_id: visit.data.id, task_id: task.data.id }))
      .error,
  );
  assert.ifError((await sitter.client.rpc("end_visit", { target_visit_id: visit.data.id })).error);
  assert.ifError((await sitter.client.rpc("reopen_visit", { target_visit_id: visit.data.id })).error);
  assert.ifError((await parent.client.rpc("end_visit", { target_visit_id: visit.data.id })).error);

  assert.ifError((await sitter.client.rpc("delete_my_account")).error);

  const { data: checks } = await admin
    .from("task_checks")
    .select("checked_by")
    .eq("visit_id", visit.data.id);
  assert.deepEqual(checks, [{ checked_by: null }]);
  const { data: v } = await admin
    .from("visits")
    .select("started_by, ended_by")
    .eq("id", visit.data.id)
    .single();
  assert.deepEqual(v, { started_by: null, ended_by: parent.id });
  // The shift history keeps every row; the departed sitter's become "a former member".
  const { data: history } = await parent.client
    .from("shift_events")
    .select("kind, actor_id")
    .eq("visit_id", visit.data.id)
    .order("created_at")
    .order("id");
  assert.deepEqual(history, [
    { kind: "ended", actor_id: null },
    { kind: "reopened", actor_id: null },
    { kind: "ended", actor_id: parent.id },
  ]);
  const { count } = await admin
    .from("households")
    .select("*", { count: "exact", head: true })
    .eq("id", h.data);
  assert.equal(count, 1, "the family space survives a caretaker leaving");
});

// A fresh family space: a parent, a sitter who accepted an invite, the plan, and `taskCount`
// tasks (ids in position order).
async function newFamily(label, taskCount) {
  const parent = await signUp(`parent-${label}`);
  const sitter = await signUp(`sitter-${label}`);
  const h = await parent.client.rpc("create_household", {
    household_name: `Family ${label}`,
    acknowledged: true,
  });
  assert.ifError(h.error);
  createdHouseholdIds.push(h.data);
  const token = await parent.client.rpc("create_invite", {
    target_household_id: h.data,
    invite_email: sitter.email,
  });
  assert.ifError(token.error);
  assert.ifError((await sitter.client.rpc("accept_invite", { invite_token: token.data })).error);
  const plan = await parent.client
    .from("plans")
    .insert({ household_id: h.data, title: "Day" })
    .select()
    .single();
  assert.ifError(plan.error);
  const tasks = await parent.client
    .from("tasks")
    .insert(
      Array.from({ length: taskCount }, (_, i) => ({
        plan_id: plan.data.id,
        title: `Task ${i}`,
        position: i,
      })),
    )
    .select("id, position");
  assert.ifError(tasks.error);
  const taskIds = tasks.data.sort((x, y) => x.position - y.position).map((row) => row.id);
  return { parent, sitter, householdId: h.data, planId: plan.data.id, taskIds };
}

// The same signed-in user, but every request carries PostgREST's `Prefer: timezone=<tz>`, which
// sets the session time zone for that request's transaction. `applied()` counts responses where
// PostgREST confirmed it (`Preference-Applied`), so the test cannot pass vacuously if the header
// is ignored.
async function inTimeZone(user, tz) {
  const { data, error } = await user.client.auth.getSession();
  assert.ifError(error);
  const token = data.session.access_token;
  let applied = 0;
  const client = createClient(apiUrl, publicKey, {
    ...clientOptions,
    accessToken: async () => token,
    global: {
      fetch: async (input, init = {}) => {
        const headers = new Headers(init.headers);
        const prefer = headers.get("Prefer");
        headers.set("Prefer", prefer ? `${prefer}, timezone=${tz}` : `timezone=${tz}`);
        const response = await fetch(input, { ...init, headers });
        if ((response.headers.get("Preference-Applied") ?? "").includes(`timezone=${tz}`)) {
          applied += 1;
        }
        return response;
      },
    },
  });
  return { client, id: user.id, email: user.email, applied: () => applied };
}

// Number of shift_events rows (service role), optionally narrowed by `filter`.
async function countEvents(filter = (q) => q) {
  const { count, error } = await filter(
    admin.from("shift_events").select("*", { count: "exact", head: true }),
  );
  assert.ifError(error);
  return count;
}

// Two-session tests talk to the local database directly with psql (status.DB_URL is local-only,
// checked below), because one PostgREST request cannot hold a transaction open.
const dbUrl = status.DB_URL;
if (dbUrl && !["127.0.0.1", "localhost"].includes(new URL(dbUrl).hostname)) {
  throw new Error("Refusing to use a non-local database URL");
}

function psqlAvailable() {
  try {
    execFileSync("psql", ["--version"], { stdio: "ignore" });
    return Boolean(dbUrl);
  } catch {
    return false;
  }
}

function psqlQuery(sql) {
  return execFileSync("psql", [dbUrl, "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
  }).trim();
}

// Runs `sql` in its own psql session; resolves to psql's exit code.
function spawnPsql(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn("psql", [dbUrl, "-Xq", "-v", "ON_ERROR_STOP=1"], {
      stdio: ["pipe", "ignore", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", resolve);
    child.stdin.end(sql);
  });
}

async function waitFor(condition, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "timed out waiting for the other session");
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Catalog checks run as the local superuser through the Supabase CLI (`--local` only), so they
// see every table, including any a future migration adds without enabling RLS.
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

test("every relation in public has RLS (tables), invoker rights (views), and grants anon nothing", () => {
  // Views, materialized views, and foreign tables are included: they are reachable through the
  // API like tables, and materialized/foreign tables cannot have RLS at all.
  const rows = localSql(`
    select c.relname as name,
           c.relkind as kind,
           c.relrowsecurity as rls,
           exists (
             select 1 from pg_options_to_table(c.reloptions) o
              where o.option_name = 'security_invoker'
                and lower(o.option_value) in ('true', 'on', 'yes', '1')
           ) as security_invoker,
           (has_table_privilege('anon', c.oid, 'select, insert, update, delete, truncate, references, trigger')
             or has_any_column_privilege('anon', c.oid, 'select, insert, update, references')) as anon_any,
           (has_table_privilege('authenticated', c.oid, 'select, insert, update, delete, truncate, references, trigger')
             or has_any_column_privilege('authenticated', c.oid, 'select, insert, update, references')) as authenticated_any
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
     order by 1`);
  assert.deepEqual(
    rows
      .filter((r) => r.kind === "r" || r.kind === "p")
      .map((r) => r.name)
      .sort(),
    [...tables].sort(),
    "the test's table list matches the schema",
  );
  for (const row of rows) {
    assert.equal(row.anon_any, false, `anon has privileges on public.${row.name}`);
    if (row.kind === "r" || row.kind === "p") {
      assert.equal(row.rls, true, `RLS disabled on public.${row.name}`);
    }
    if (row.kind === "v") {
      assert.equal(row.security_invoker, true, `view public.${row.name} lacks security_invoker=true`);
    }
    if (row.kind === "m" || row.kind === "f") {
      assert.equal(
        row.authenticated_any,
        false,
        `public.${row.name} bypasses RLS but is granted to authenticated`,
      );
    }
  }

  // Clients cannot write the shift history at all, or choose when or by whom a task was checked.
  assert.deepEqual(
    localSql(`
      select has_table_privilege('authenticated', 'public.shift_events',
               'insert, update, delete, truncate') as shift_events_table_write,
             has_any_column_privilege('authenticated', 'public.shift_events',
               'insert, update') as shift_events_column_write,
             has_column_privilege('authenticated', 'public.task_checks', 'checked_at',
               'insert, update') as checked_at_write,
             has_column_privilege('authenticated', 'public.task_checks', 'checked_by',
               'insert, update') as checked_by_write,
             has_table_privilege('authenticated', 'public.task_checks', 'update')
               as task_checks_update`),
    [
      {
        shift_events_table_write: false,
        shift_events_column_write: false,
        checked_at_write: false,
        checked_by_write: false,
        task_checks_update: false,
      },
    ],
    "authenticated has a write privilege it must not have",
  );

  const anonFunctions = localSql(`
    select p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')`);
  assert.deepEqual(anonFunctions, [], "anon can execute a public function");

  // Objects created by later migrations must start closed: no schema-scoped default grant to
  // anon/authenticated in public...
  const defaults = localSql(`
    select count(*)::int as open_defaults
      from pg_default_acl d
      join pg_namespace n on n.oid = d.defaclnamespace
      cross join lateral aclexplode(d.defaclacl) a
     where n.nspname = 'public'
       and d.defaclrole = 'postgres'::regrole
       and a.grantee in ('anon'::regrole, 'authenticated'::regrole)`);
  assert.equal(defaults[0].open_defaults, 0, "default privileges still open new objects");

  // ...and a global (all-schema) default for postgres's functions that drops Postgres's
  // built-in EXECUTE for PUBLIC, which a schema-scoped revoke cannot remove.
  const globalFunctionDefaults = localSql(`
    select d.defaclacl::text as acl,
           exists (
             select 1 from aclexplode(d.defaclacl) a
              where a.privilege_type = 'EXECUTE'
                and a.grantee in (0, 'anon'::regrole, 'authenticated'::regrole)
           ) as open_execute
      from pg_default_acl d
     where d.defaclnamespace = 0
       and d.defaclobjtype = 'f'
       and d.defaclrole = 'postgres'::regrole`);
  assert.equal(globalFunctionDefaults.length, 1, "no global default ACL for postgres functions");
  assert.equal(
    globalFunctionDefaults[0].open_execute,
    false,
    `new functions are still executable by PUBLIC: ${globalFunctionDefaults[0].acl}`,
  );
});

// Only ever interpolate ids this run created.
function uuid(value) {
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  return value;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}
