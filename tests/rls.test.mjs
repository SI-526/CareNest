// Authorization tests for the CareNest database, run against the LOCAL Supabase stack only.
//
//   cd tests && npm install && npm run db:start && npm run db:reset && npm run test:rls
//
// Keys are read from `supabase status` at runtime and never written anywhere. Test users get
// random throwaway passwords and are deleted when the run ends.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

// Since T3a a task is checked only through complete_task(), which needs a photo uploaded into the
// shift's folder of the private `photos` bucket. Direct task_checks inserts are refused.
const TINY_JPEG = new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9])], {
  type: "image/jpeg",
});
async function completeTask(user, householdId, targetVisitId, taskId) {
  const path = `${householdId}/${targetVisitId}/${randomUUID()}.jpg`;
  const up = await user.client.storage
    .from("photos")
    .upload(path, TINY_JPEG, { contentType: "image/jpeg" });
  assert.ifError(up.error);
  return user.client.rpc("complete_task", {
    target_visit_id: targetVisitId,
    target_task_id: taskId,
    proof_photo_path: path,
  });
}

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
  // T3a (20261015000000_carenest_photos_messages.sql); tested in photos.test.mjs.
  "messages",
  "message_reads",
  "photo_saves",
  "concept_flags",
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
    ])
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
    ])
    .select();
  assert.ifError(items.error);
  careItemIds = items.data.map((i) => i.id);

  const contacts = await a
    .from("contacts")
    .insert([
      { household_id: householdA, name: "Mary Ann Thomas", role: "Parent", phone: "588-909-3489" },
      { household_id: householdA, name: "Mott", role: "Hospital", address: "1540 E Hospital Dr" },
    ])
    .select();
  assert.ifError(contacts.error);
  contactIds = contacts.data.map((c) => c.id);

  const tooLong = await a.from("plans").insert({ household_id: householdA, title: "x".repeat(81) });
  assert.ok(tooLong.error, "title over 80 characters is rejected");
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
    await c.from("task_checks").insert({ visit_id: visitId, task_id: taskIds[0] }).select(),
    "task_checks are inserted only by complete_task",
  );
  assert.ifError((await completeTask(caretaker, householdA, visitId, taskIds[0])).error);
  const check = await c
    .from("task_checks")
    .select("checked_by")
    .eq("visit_id", visitId)
    .eq("task_id", taskIds[0])
    .single();
  assert.ifError(check.error);
  assert.equal(check.data.checked_by, caretaker.id);

  const uncheck = await c
    .from("task_checks")
    .delete()
    .eq("visit_id", visitId)
    .eq("task_id", taskIds[0])
    .select();
  assert.equal(uncheck.data?.length, 1, "caretaker can uncheck");
  assert.ifError((await completeTask(caretaker, householdA, visitId, taskIds[0])).error);

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
  assert.ifError((await completeTask(caretaker, householdA, visitId, taskIds[1])).error);
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

  // Backfill: a check made after the first end (i.e. after a reopen) is identifiable.
  const { data: history } = await events(parentA);
  const firstEnd = Date.parse(history[0].created_at);
  const { data: checks } = await parentA.client
    .from("task_checks")
    .select("task_id, checked_at")
    .eq("visit_id", visitId);
  const afterReopen = Object.fromEntries(
    checks.map((row) => [row.task_id, Date.parse(row.checked_at) > firstEnd]),
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

test("after shifts exist, parent B still sees nothing of household A", async () => {
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
});

test("delete_my_account removes the sole parent's household data and account", async () => {
  const result = await parentA.client.rpc("delete_my_account");
  assert.ifError(result.error);

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
  assert.ifError((await completeTask(sitter, h.data, visit.data.id, task.data.id)).error);
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
