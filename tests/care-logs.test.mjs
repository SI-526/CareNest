// Authorization and integrity tests for care logs (SI-28, 20261016000000_carenest_care_logs.sql),
// run against the LOCAL Supabase stack only.
//
//   cd tests && npm install && npm run db:start && npm run db:reset && npm run test:rls
//
// Keys are read from `supabase status` at runtime and never written anywhere. Test users get
// random throwaway passwords and are deleted when the run ends.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createClient } from "@supabase/supabase-js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const status = JSON.parse(supabaseStatus());

// `supabase status` exits non-zero when services were left out with `db:start -- -x ...`, but
// still prints the JSON; take it when there is any, and fail as before when there is none.
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

// Postgres "insufficient_privilege" (missing GRANT), as PostgREST reports it.
function assertPermissionDenied(result, message) {
  assert.ok(result.error, message);
  assert.ok(
    result.error.code === "42501" || /permission denied/i.test(result.error.message),
    `${message}: expected permission denied, got ${result.error.code} ${result.error.message}`,
  );
}

// Postgres "check_violation" (an empty or malformed care log).
function assertCheckViolation(result, message) {
  assert.ok(result.error, message);
  assert.equal(result.error.code, "23514", `${message}: got ${result.error.code} ${result.error.message}`);
}

// The database's UTC date, read once in before(). Test dates derive from it (not the JS clock),
// so the suite cannot disagree with the window check near 00:00 UTC.
let dbToday;

// A calendar date `offsetDays` from the database's UTC date, as YYYY-MM-DD.
function isoDate(offsetDays) {
  assert.ok(dbToday, "dbToday is read in before()");
  const date = new Date(`${dbToday}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

// Since T3a a task is checked only through complete_task(), which needs a photo uploaded into the
// shift's folder of the private `photos` bucket for a caretaker. Direct task_checks inserts are
// refused.
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

// Catalog checks and out-of-window fixtures run as the local superuser through the Supabase CLI
// (`--local` only).
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

// Two-session tests talk to the local database directly with psql (status.DB_URL is local-only,
// checked below), because one PostgREST request cannot hold a transaction open. Same helpers as
// rls.test.mjs.
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

// Runs `sql` in its own psql session; resolves to { code, stderr }.
function spawnPsql(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn("psql", [dbUrl, "-Xq", "-v", "ON_ERROR_STOP=1"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
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

// Session 1 of a race: runs `statement` as `user` (role authenticated, their JWT claims) and
// then sleeps inside the still-open transaction. Resolves once that session is sleeping, to
// { session }: a promise (wrapped, so awaiting holdOpenAs does not wait for it) that settles with
// psql's { code, stderr } when the session commits.
async function holdOpenAs(user, statement) {
  const marker = `cl-race-${randomUUID()}`;
  const claims = JSON.stringify({ sub: uuid(user.id), role: "authenticated" });
  const session = spawnPsql(`
    begin;
    set local role authenticated;
    select set_config('request.jwt.claims', '${claims}', true);
    ${statement}
    select pg_sleep(4) /* ${marker} */;
    commit;`);
  await waitFor(() =>
    psqlQuery(`select count(*) from pg_stat_activity where state = 'active' and query like '%${marker}%' and query not like '%pg_stat_activity%'`) === "1",
  );
  return { session };
}

// Only ever interpolate ids this run created.
function uuid(value) {
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  return value;
}

const parentCheck = (user, visitId, taskId) =>
  user.client.rpc("complete_task", { target_visit_id: visitId, target_task_id: taskId });

const addLog = (user, row) => user.client.from("care_logs").insert(row).select().single();

let fam; // household A: parent, sitter, 4 tasks
let famB; // another family (outsiders to A)
let visitId; // A, today, open (ended later by the end_visit test)
let firstLog;

before(async () => {
  const [row] = localSql("select ((now() at time zone 'utc')::date)::text as today");
  dbToday = String(row.today).slice(0, 10);
  assert.match(dbToday, /^\d{4}-\d{2}-\d{2}$/);
  fam = await newFamily("cl-a", 4);
  famB = await newFamily("cl-b", 1);
  const v = await fam.sitter.client
    .from("visits")
    .insert({ plan_id: fam.planId, visit_date: isoDate(0) })
    .select()
    .single();
  assert.ifError(v.error);
  visitId = v.data.id;
  assert.ifError((await completeTask(fam.sitter, fam.householdId, visitId, fam.taskIds[0])).error);
  assert.ifError((await parentCheck(fam.parent, visitId, fam.taskIds[1])).error);
});

after(async () => {
  // Database cascades do not remove Storage objects: remove the photos this run uploaded.
  for (const householdId of createdHouseholdIds) {
    const { data: visits } = await admin.storage.from("photos").list(householdId);
    for (const folder of visits ?? []) {
      const { data: files } = await admin.storage
        .from("photos")
        .list(`${householdId}/${folder.name}`, { limit: 1000 });
      const paths = (files ?? []).map((f) => `${householdId}/${folder.name}/${f.name}`);
      if (paths.length) await admin.storage.from("photos").remove(paths);
    }
  }
  if (createdHouseholdIds.length) {
    await admin.from("households").delete().in("id", createdHouseholdIds);
  }
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
});

test("a sitter logs a completed task; the database stamps author, role, household, and time", async () => {
  const before = Date.now();
  const log = await addLog(fam.sitter, {
    visit_id: visitId,
    task_id: fam.taskIds[0],
    category: "meal",
    meal_amount: "most",
    note: "Pasta, left the peas",
  });
  assert.ifError(log.error);
  firstLog = log.data;
  assert.equal(firstLog.author_id, fam.sitter.id);
  assert.equal(firstLog.author_role, "caretaker");
  assert.equal(firstLog.household_id, fam.householdId);
  assert.equal(firstLog.category, "meal");
  assert.equal(firstLog.meal_amount, "most");
  assert.equal(firstLog.bottle_oz, null);
  const at = Date.parse(firstLog.created_at);
  assert.ok(Math.abs(at - before) < 60_000, "created_at is the server's current time");

  // The parent reads it; a parent's own log is stamped as a parent's.
  const read = await fam.parent.client.from("care_logs").select("*").eq("visit_id", visitId);
  assert.ifError(read.error);
  assert.deepEqual(read.data.map((r) => r.id), [firstLog.id]);
  const bottle = await addLog(fam.parent, {
    visit_id: visitId,
    task_id: fam.taskIds[1],
    category: "bottle",
    bottle_oz: 4.5,
  });
  assert.ifError(bottle.error);
  assert.equal(bottle.data.author_role, "parent");
  assert.equal(bottle.data.author_id, fam.parent.id);
  assert.equal(Number(bottle.data.bottle_oz), 4.5);
  assert.equal(bottle.data.note, "");
  const sitterRead = await fam.sitter.client.from("care_logs").select("id").eq("visit_id", visitId);
  assert.equal(sitterRead.data.length, 2, "the sitter reads every log of the household");
});

test("clients cannot choose the author, role, household, time, or id of a log", async () => {
  const base = { visit_id: visitId, task_id: fam.taskIds[0], category: "care", note: "Nap 1h" };
  for (const [column, value] of Object.entries({
    author_id: fam.parent.id,
    author_role: "parent",
    household_id: famB.householdId,
    created_at: "2020-01-01T00:00:00Z",
    id: randomUUID(),
  })) {
    assertPermissionDenied(
      await fam.sitter.client.from("care_logs").insert({ ...base, [column]: value }),
      `client set ${column}`,
    );
  }
  assert.deepEqual(
    localSql(`
      select has_table_privilege('authenticated', 'public.care_logs', 'update, delete, truncate')
               as table_write,
             has_any_column_privilege('authenticated', 'public.care_logs', 'update') as column_update,
             has_column_privilege('authenticated', 'public.care_logs', 'author_id', 'insert') as author_id,
             has_column_privilege('authenticated', 'public.care_logs', 'author_role', 'insert') as author_role,
             has_column_privilege('authenticated', 'public.care_logs', 'household_id', 'insert') as household_id,
             has_column_privilege('authenticated', 'public.care_logs', 'created_at', 'insert') as created_at,
             has_any_column_privilege('anon', 'public.care_logs', 'select, insert, update') as anon_any,
             has_function_privilege('authenticated', 'public.stamp_care_log()', 'execute') as stamp_exec`),
    [
      {
        table_write: false,
        column_update: false,
        author_id: false,
        author_role: false,
        household_id: false,
        created_at: false,
        anon_any: false,
        stamp_exec: false,
      },
    ],
    "authenticated or anon has a care_logs privilege it must not have",
  );
});

test("outsiders and anonymous visitors cannot read or add logs", async () => {
  for (const user of [famB.parent, famB.sitter]) {
    const read = await user.client.from("care_logs").select("*");
    assert.ifError(read.error);
    assert.deepEqual(
      read.data.filter((r) => r.household_id === fam.householdId),
      [],
      "another family reads household A's logs",
    );
    // A shift of another family looks the same as a shift that does not exist.
    assertRpcError(
      await addLog(user, { visit_id: visitId, task_id: fam.taskIds[0], category: "care", note: "x" }),
      "visit_not_found",
    );
  }
  const anonRead = await anon.from("care_logs").select("*");
  assert.ok(anonRead.error || anonRead.data.length === 0, "anon reads care_logs");
  assertPermissionDenied(
    await anon.from("care_logs").insert({ visit_id: visitId, task_id: fam.taskIds[0], category: "care", note: "x" }),
    "anon inserts a care log",
  );
  const { count } = await admin
    .from("care_logs")
    .select("*", { count: "exact", head: true })
    .eq("household_id", fam.householdId);
  assert.equal(count, 2, "nothing slipped in");
});

test("the service role cannot add a log: every log needs a signed-in member", async () => {
  assertRpcError(
    await admin.from("care_logs").insert({
      visit_id: visitId,
      task_id: fam.taskIds[0],
      category: "care",
      note: "x",
      household_id: fam.householdId,
      author_id: fam.parent.id,
      author_role: "parent",
    }),
    "not_authenticated",
  );
  const { count } = await admin
    .from("care_logs")
    .select("*", { count: "exact", head: true })
    .eq("household_id", fam.householdId);
  assert.equal(count, 2, "nothing slipped in");
});

test("only a task checked in that shift can be logged; the shift must exist", async () => {
  assertRpcError(
    await addLog(fam.sitter, { visit_id: visitId, task_id: fam.taskIds[2], category: "care", note: "x" }),
    "task_not_completed",
  );
  // famB's task is not part of this shift's plan (and never checked in it); neither is a task
  // that does not exist.
  for (const taskId of [famB.taskIds[0], randomUUID()]) {
    assertRpcError(
      await addLog(fam.sitter, { visit_id: visitId, task_id: taskId, category: "care", note: "x" }),
      "task_not_found",
    );
  }
  assertRpcError(
    await addLog(fam.sitter, { visit_id: randomUUID(), task_id: fam.taskIds[0], category: "care", note: "x" }),
    "visit_not_found",
  );
  // An unchecked task can no longer be logged (its earlier logs stay).
  assert.ifError((await parentCheck(fam.parent, visitId, fam.taskIds[3])).error);
  assert.ifError(
    (await addLog(fam.parent, { visit_id: visitId, task_id: fam.taskIds[3], category: "care", note: "Bath" })).error,
  );
  const unchecked = await fam.parent.client
    .from("task_checks")
    .delete()
    .eq("visit_id", visitId)
    .eq("task_id", fam.taskIds[3])
    .select();
  assert.ifError(unchecked.error);
  assert.equal(unchecked.data.length, 1);
  assertRpcError(
    await addLog(fam.parent, { visit_id: visitId, task_id: fam.taskIds[3], category: "care", note: "again" }),
    "task_not_completed",
  );
  const { count } = await admin
    .from("care_logs")
    .select("*", { count: "exact", head: true })
    .eq("task_id", fam.taskIds[3]);
  assert.equal(count, 1, "an uncheck leaves the earlier log in place");
});

test("a check pairing the shift with another family's task cannot be logged on", async () => {
  // task_checks itself does not tie the task to the shift's plan: the service role can write
  // such a row. The log trigger must not trust it.
  const cross = await admin
    .from("task_checks")
    .insert({ visit_id: visitId, task_id: famB.taskIds[0] })
    .select("visit_id, task_id")
    .single();
  assert.ifError(cross.error);
  try {
    for (const user of [fam.sitter, fam.parent]) {
      assertRpcError(
        await addLog(user, { visit_id: visitId, task_id: famB.taskIds[0], category: "care", note: "x" }),
        "task_not_found",
      );
    }
    const { count } = await admin
      .from("care_logs")
      .select("*", { count: "exact", head: true })
      .eq("task_id", famB.taskIds[0]);
    assert.equal(count, 0, "no log landed on another family's task");
  } finally {
    const removed = await admin
      .from("task_checks")
      .delete()
      .eq("visit_id", visitId)
      .eq("task_id", famB.taskIds[0]);
    assert.ifError(removed.error);
  }
});

test("a log that races an uncheck waits for it and is then refused", async (t) => {
  if (!psqlAvailable()) {
    t.skip("psql is not on PATH; this two-session test needs a direct database connection");
    return;
  }
  const race = await newFamily("cl-race1", 1);
  const [task] = race.taskIds;
  const v = await race.parent.client
    .from("visits")
    .insert({ plan_id: race.planId, visit_date: isoDate(0) })
    .select()
    .single();
  assert.ifError(v.error);
  const id = v.data.id;
  assert.ifError((await parentCheck(race.parent, id, task)).error);

  // Session 1 (psql, as the parent): uncheck the task and hold the transaction open.
  const { session } = await holdOpenAs(
    race.parent,
    `delete from public.task_checks where visit_id = '${uuid(id)}' and task_id = '${uuid(task)}';`,
  );
  // Session 2 (the sitter, through the API): the trigger's share lock on the check waits for the
  // uncheck, then finds the check gone.
  const startedAt = Date.now();
  const raced = await addLog(race.sitter, { visit_id: id, task_id: task, category: "care", note: "Nap" });
  const waitedMs = Date.now() - startedAt;
  const { code, stderr } = await session;
  assert.equal(code, 0, `session 1 committed: ${stderr}`);
  assert.ok(waitedMs > 1500, `the log waited for the uncheck (${waitedMs} ms)`);
  assertRpcError(raced, "task_not_completed");
  const { count: checks } = await admin
    .from("task_checks")
    .select("*", { count: "exact", head: true })
    .eq("visit_id", id);
  assert.equal(checks, 0, "the uncheck committed");
  const { count: logs } = await admin
    .from("care_logs")
    .select("*", { count: "exact", head: true })
    .eq("visit_id", id);
  assert.equal(logs, 0, "no log landed on the unchecked task");
});

test("an uncheck that races a log waits for it; the log survives", async (t) => {
  if (!psqlAvailable()) {
    t.skip("psql is not on PATH; this two-session test needs a direct database connection");
    return;
  }
  const race = await newFamily("cl-race2", 1);
  const [task] = race.taskIds;
  const v = await race.parent.client
    .from("visits")
    .insert({ plan_id: race.planId, visit_date: isoDate(0) })
    .select()
    .single();
  assert.ifError(v.error);
  const id = v.data.id;
  assert.ifError((await parentCheck(race.parent, id, task)).error);

  // Session 1 (psql, as the sitter): add a log and hold the transaction open (the trigger holds
  // a share lock on the check).
  const { session } = await holdOpenAs(
    race.sitter,
    `insert into public.care_logs (visit_id, task_id, category, note)
     values ('${uuid(id)}', '${uuid(task)}', 'care', 'Nap 1h');`,
  );
  // Session 2 (the parent, through the API): the uncheck waits for the log's transaction.
  const startedAt = Date.now();
  const unchecked = await race.parent.client
    .from("task_checks")
    .delete()
    .eq("visit_id", id)
    .eq("task_id", task)
    .select();
  const waitedMs = Date.now() - startedAt;
  const { code, stderr } = await session;
  assert.equal(code, 0, `session 1 committed: ${stderr}`);
  assert.ok(waitedMs > 1500, `the uncheck waited for the log (${waitedMs} ms)`);
  assert.ifError(unchecked.error);
  assert.equal(unchecked.data.length, 1, "the uncheck went through after the log committed");
  const { data: logs, error } = await admin
    .from("care_logs")
    .select("author_id, author_role, note")
    .eq("visit_id", id);
  assert.ifError(error);
  assert.deepEqual(logs, [{ author_id: race.sitter.id, author_role: "caretaker", note: "Nap 1h" }], "the log survives the uncheck");
});

test("logs are accepted only while the shift's date is in the window", async () => {
  // Shifts two days ago (ended), three days ago (never ended), and in two days, each with a check,
  // written as the local superuser (no signed-in user, so the check trigger skips the shift rules).
  for (const [offset, ended] of [[-2, true], [-3, false], [2, false]]) {
    const [{ id }] = localSql(`
      insert into public.visits (plan_id, visit_date, ended_at)
      values ('${uuid(fam.planId)}', '${isoDate(offset)}', ${ended ? "now()" : "null"})
      returning id::text as id`);
    uuid(id);
    localSql(`insert into public.task_checks (visit_id, task_id)
              values ('${id}', '${uuid(fam.taskIds[0])}') returning task_id::text as task_id`);
    for (const user of [fam.sitter, fam.parent]) {
      assertRpcError(
        await addLog(user, { visit_id: id, task_id: fam.taskIds[0], category: "care", note: "late" }),
        "visit_too_old",
      );
    }
  }
  // Yesterday's shift, ended, with a check: still in the window, so a recap is allowed.
  const [{ id: yesterday }] = localSql(`
    insert into public.visits (plan_id, visit_date, ended_at)
    values ('${uuid(fam.planId)}', '${isoDate(-1)}', now())
    returning id::text as id`);
  uuid(yesterday);
  localSql(`insert into public.task_checks (visit_id, task_id)
            values ('${yesterday}', '${uuid(fam.taskIds[0])}') returning task_id::text as task_id`);
  assert.ifError(
    (await addLog(fam.sitter, { visit_id: yesterday, task_id: fam.taskIds[0], category: "care", note: "Recap" }))
      .error,
  );
});

test("after end_visit, an in-window shift still takes logs", async () => {
  assert.ifError((await fam.sitter.client.rpc("end_visit", { target_visit_id: visitId })).error);
  const log = await addLog(fam.sitter, {
    visit_id: visitId,
    task_id: fam.taskIds[1],
    category: "bottle",
    bottle_oz: 6,
    note: "Finished it",
  });
  assert.ifError(log.error);
  assert.equal(log.data.author_role, "caretaker");
});

test("logs are append-only: no update or delete; an edit is a new row and the check is untouched", async () => {
  const checkBefore = await admin
    .from("task_checks")
    .select("checked_at, checked_by")
    .eq("visit_id", visitId)
    .eq("task_id", fam.taskIds[0])
    .single();
  assert.ifError(checkBefore.error);

  for (const user of [fam.sitter, fam.parent]) {
    assertPermissionDenied(
      await user.client.from("care_logs").update({ note: "rewritten" }).eq("id", firstLog.id).select(),
      "member updates a log",
    );
    assertPermissionDenied(
      await user.client.from("care_logs").delete().eq("id", firstLog.id).select(),
      "member deletes a log",
    );
  }
  const stored = await admin.from("care_logs").select("*").eq("id", firstLog.id).single();
  assert.ifError(stored.error);
  assert.deepEqual(stored.data, firstLog, "the original log is unchanged");

  const edit = await addLog(fam.sitter, {
    visit_id: visitId,
    task_id: fam.taskIds[0],
    category: "meal",
    meal_amount: "all",
    note: "Actually ate the peas too",
  });
  assert.ifError(edit.error);
  assert.notEqual(edit.data.id, firstLog.id);
  assert.ok(Date.parse(edit.data.created_at) > Date.parse(firstLog.created_at));
  const { data: rows } = await fam.parent.client
    .from("care_logs")
    .select("id")
    .eq("visit_id", visitId)
    .eq("task_id", fam.taskIds[0])
    .order("created_at");
  assert.deepEqual(rows.map((r) => r.id), [firstLog.id, edit.data.id]);

  const checkAfter = await admin
    .from("task_checks")
    .select("checked_at, checked_by")
    .eq("visit_id", visitId)
    .eq("task_id", fam.taskIds[0])
    .single();
  assert.deepEqual(checkAfter.data, checkBefore.data, "logging never touches the task's check");
});

test("empty or malformed logs are refused by the database", async () => {
  const base = { visit_id: visitId, task_id: fam.taskIds[0] };
  const refused = {
    "meal with nothing": { category: "meal" },
    "meal with a blank note": { category: "meal", note: "  \n\t " },
    "bottle without ounces": { category: "bottle", note: "Fed" },
    "bottle of 0 oz": { category: "bottle", bottle_oz: 0 },
    "bottle of -1 oz": { category: "bottle", bottle_oz: -1 },
    "bottle of 16.5 oz": { category: "bottle", bottle_oz: 16.5 },
    "care with a blank note": { category: "care", note: "   " },
    "care with nothing": { category: "care" },
    "meal amount on a care log": { category: "care", note: "Nap", meal_amount: "all" },
    "meal amount on a bottle log": { category: "bottle", bottle_oz: 4, meal_amount: "all" },
    "ounces on a meal log": { category: "meal", meal_amount: "some", bottle_oz: 4 },
    "ounces on a care log": { category: "care", note: "Nap", bottle_oz: 4 },
    "unknown meal amount": { category: "meal", meal_amount: "lots" },
    "unknown category": { category: "diaper", note: "x" },
    "note over 1000 characters": { category: "care", note: "x".repeat(1001) },
  };
  for (const [label, row] of Object.entries(refused)) {
    assertCheckViolation(await fam.sitter.client.from("care_logs").insert({ ...base, ...row }), label);
  }
  assert.ok(
    (await fam.sitter.client.from("care_logs").insert({ ...base, category: "bottle", bottle_oz: 100 })).error,
    "bottle of 100 oz",
  );

  const accepted = {
    "meal with only an amount": { category: "meal", meal_amount: "none" },
    "meal with only a note": { category: "meal", note: "Toast" },
    "bottle of 16 oz": { category: "bottle", bottle_oz: 16 },
    "bottle of 0.5 oz": { category: "bottle", bottle_oz: 0.5 },
    "note of 1000 characters": { category: "care", note: "y".repeat(1000) },
  };
  for (const [label, row] of Object.entries(accepted)) {
    assert.ifError((await fam.sitter.client.from("care_logs").insert({ ...base, ...row })).error, label);
  }
});

test("care_logs is published to Realtime", () => {
  const rows = localSql(`
    select count(*)::int as n
      from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'care_logs'`);
  assert.equal(rows[0].n, 1);
});

test("account deletion: a sitter's logs stay without a name; a sole parent's family space takes its logs", async () => {
  const del = await newFamily("cl-del", 1);
  const v = await del.parent.client
    .from("visits")
    .insert({ plan_id: del.planId, visit_date: isoDate(0) })
    .select()
    .single();
  assert.ifError(v.error);
  assert.ifError((await parentCheck(del.parent, v.data.id, del.taskIds[0])).error);
  const bySitter = await addLog(del.sitter, {
    visit_id: v.data.id,
    task_id: del.taskIds[0],
    category: "meal",
    meal_amount: "some",
  });
  assert.ifError(bySitter.error);
  assert.ifError(
    (await addLog(del.parent, { visit_id: v.data.id, task_id: del.taskIds[0], category: "care", note: "Nap" })).error,
  );

  assert.ifError((await del.sitter.client.rpc("delete_my_account")).error);
  const kept = await admin.from("care_logs").select("author_id, author_role").eq("id", bySitter.data.id).single();
  assert.ifError(kept.error);
  assert.deepEqual(kept.data, { author_id: null, author_role: "caretaker" }, "a former member's log stays");

  assert.ifError((await del.parent.client.rpc("delete_my_account")).error);
  const { count: left } = await admin
    .from("care_logs")
    .select("*", { count: "exact", head: true })
    .eq("household_id", del.householdId);
  assert.equal(left, 0, "the family space's logs are gone");
  const { count: households } = await admin
    .from("households")
    .select("*", { count: "exact", head: true })
    .eq("id", del.householdId);
  assert.equal(households, 0, "the family space is gone");
  const { count: others } = await admin
    .from("care_logs")
    .select("*", { count: "exact", head: true })
    .eq("household_id", fam.householdId);
  assert.ok(others > 0, "other families' logs are untouched");
});
