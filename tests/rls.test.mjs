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
];

const rpcs = [
  ["create_household", { household_name: "X", acknowledged: true }],
  ["create_invite", { target_household_id: randomUUID(), invite_email: "x@example.test" }],
  ["accept_invite", { invite_token: "x" }],
  ["end_visit", { target_visit_id: randomUUID() }],
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

before(async () => {
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
    .insert({ plan_id: planA.id, visit_date: "2026-10-04", ended_at: new Date().toISOString() })
    .select();
  assert.ok(forgedEnd.error, "ended_at cannot be set when starting a shift");

  const visit = await c
    .from("visits")
    .insert({ plan_id: planA.id, visit_date: "2026-10-05" })
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

  const check = await c
    .from("task_checks")
    .insert({ visit_id: visitId, task_id: taskIds[0] })
    .select()
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
    .insert({ plan_id: planA.id, visit_date: "2026-10-06" })
    .select()
    .single();
  assert.ifError(parentVisit.error);
  parentVisitId = parentVisit.data.id;
  assert.ifError(
    (await parentA.client.rpc("end_visit", { target_visit_id: parentVisitId })).error,
  );
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
        [visitId, parentVisitId].includes(row.visit_id) ||
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
    assert.ok((await anon.rpc(name, args)).error, `anon called ${name}`);
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

  for (const table of ["households", "plans", "tasks", "care_items", "contacts", "visits"]) {
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
    await caretaker.client.from("visits").insert({ plan_id: planA.id, visit_date: "2026-10-07" }).select(),
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
  assert.deepEqual(v, { started_by: null, ended_by: null });
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

test("every table in public has RLS enabled and grants anon nothing", () => {
  const rows = localSql(`
    select c.relname as table_name,
           c.relrowsecurity as rls,
           has_table_privilege('anon', c.oid, 'select, insert, update, delete, truncate, references, trigger') as anon_any
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
     order by 1`);
  assert.deepEqual(
    rows.map((r) => r.table_name).sort(),
    [...tables].sort(),
    "the test's table list matches the schema",
  );
  for (const row of rows) {
    assert.equal(row.rls, true, `RLS disabled on public.${row.table_name}`);
    assert.equal(row.anon_any, false, `anon has privileges on public.${row.table_name}`);
  }

  const anonFunctions = localSql(`
    select p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')`);
  assert.deepEqual(anonFunctions, [], "anon can execute a public function");

  // Tables created by later migrations must start closed.
  const defaults = localSql(`
    select count(*)::int as open_defaults
      from pg_default_acl d
      join pg_namespace n on n.oid = d.defaclnamespace
      cross join lateral aclexplode(d.defaclacl) a
     where n.nspname = 'public'
       and d.defaclrole = 'postgres'::regrole
       and a.grantee in ('anon'::regrole, 'authenticated'::regrole)`);
  assert.equal(defaults[0].open_defaults, 0, "default privileges still open new objects");
});

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}
