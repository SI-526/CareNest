// Authorization tests for T3a (photos, messages, moments, read state, saved photos, concept flags),
// run against the LOCAL Supabase stack only, in the same style as rls.test.mjs.
//
//   cd tests && npm install && npm run db:start && npm run db:reset && npm run test:rls
//
// Keys are read from `supabase status` at runtime and never written anywhere. Test users get
// random throwaway passwords and are deleted (with their photos) when the run ends.

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

const BUCKET = "photos";
// The smallest byte sequence with JPEG start/end markers; Storage checks the declared type.
const JPEG = new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9])], {
  type: "image/jpeg",
});

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

// Catalog/setup helpers run as the local superuser through the Supabase CLI (`--local` only).
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
  // Statements without RETURNING print a command tag ("UPDATE 1"), not JSON.
  if (!/^\s*[[{]/.test(out)) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : (parsed.rows ?? parsed.data ?? parsed.result);
}

// Two-session tests talk to the local database directly with psql (status.DB_URL is local-only,
// checked here), because one PostgREST request cannot hold a transaction open.
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

// Only ever interpolate ids this run created.
function uuid(value) {
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  return value;
}

let dbToday;
function isoDate(offsetDays) {
  const date = new Date(`${dbToday}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

const photoPath = (householdId, visitId, ext = "jpg") =>
  `${householdId}/${visitId}/${randomUUID()}.${ext}`;

async function upload(user, path, body = JPEG, options = {}) {
  return (user?.client ?? anon).storage
    .from(BUCKET)
    .upload(path, body, { contentType: body.type, ...options });
}

async function uploadOk(user, householdId, visitId) {
  const path = photoPath(householdId, visitId);
  const { error } = await upload(user, path);
  assert.ifError(error);
  return path;
}

const complete = (user, visitId, taskId, path, note, tag) =>
  user.client.rpc("complete_task", {
    target_visit_id: visitId,
    target_task_id: taskId,
    proof_photo_path: path,
    ...(note === undefined ? {} : { proof_note: note }),
    ...(tag === undefined ? {} : { proof_tag: tag }),
  });

const postMoment = (user, householdId, visitId, path, extra = {}) =>
  user.client
    .from("messages")
    .insert({ household_id: householdId, visit_id: visitId, kind: "moment", photo_path: path, ...extra })
    .select()
    .single();

const newTables = ["messages", "message_reads", "photo_saves", "concept_flags"];

let parent;
let caretaker;
let parentB;
let outsider;
let householdA;
let householdB;
let planA;
let planB;
let taskIds;
let visitId; // today, open
let tomorrowVisitId; // tomorrow, open
let visitB; // household B, today
let oldVisitId; // 5 days ago, ended
let staleOpenVisitId; // 4 days ago, never ended
let proofId;
let proofPath;
let momentId;
let chatId;

before(async () => {
  const [row] = localSql("select ((now() at time zone 'utc')::date)::text as today");
  dbToday = String(row.today).slice(0, 10);
  parent = await signUp("t3-parent");
  caretaker = await signUp("t3-sitter");
  parentB = await signUp("t3-parent-b");
  outsider = await signUp("t3-outsider");

  const a = await parent.client.rpc("create_household", { household_name: "T3 A", acknowledged: true });
  assert.ifError(a.error);
  householdA = a.data;
  createdHouseholdIds.push(householdA);
  const b = await parentB.client.rpc("create_household", { household_name: "T3 B", acknowledged: true });
  assert.ifError(b.error);
  householdB = b.data;
  createdHouseholdIds.push(householdB);

  const token = await parent.client.rpc("create_invite", {
    target_household_id: householdA,
    invite_email: caretaker.email,
  });
  assert.ifError(token.error);
  assert.ifError((await caretaker.client.rpc("accept_invite", { invite_token: token.data })).error);

  planA = (await parent.client.from("plans").insert({ household_id: householdA, title: "Day" }).select().single()).data;
  planB = (await parentB.client.from("plans").insert({ household_id: householdB, title: "Day" }).select().single()).data;
  const tasks = await parent.client
    .from("tasks")
    .insert([
      { plan_id: planA.id, title: "Lunch" },
      { plan_id: planA.id, title: "Nap" },
      { plan_id: planA.id, title: "Park" },
      { plan_id: planA.id, title: "Bath" },
    ])
    .select();
  assert.ifError(tasks.error);
  taskIds = ["Lunch", "Nap", "Park", "Bath"].map((title) => tasks.data.find((t) => t.title === title).id);

  const v = await caretaker.client.from("visits").insert({ plan_id: planA.id, visit_date: isoDate(0) }).select().single();
  assert.ifError(v.error);
  visitId = v.data.id;
  const t = await caretaker.client.from("visits").insert({ plan_id: planA.id, visit_date: isoDate(1) }).select().single();
  assert.ifError(t.error);
  tomorrowVisitId = t.data.id;
  const vb = await parentB.client.from("visits").insert({ plan_id: planB.id, visit_date: isoDate(0) }).select().single();
  assert.ifError(vb.error);
  visitB = vb.data.id;
  [{ id: oldVisitId }] = localSql(`
    insert into public.visits (plan_id, visit_date, ended_at)
    values ('${uuid(planA.id)}', '${isoDate(-5)}', now())
    returning id::text as id`);
  uuid(oldVisitId);
  [{ id: staleOpenVisitId }] = localSql(`
    insert into public.visits (plan_id, visit_date)
    values ('${uuid(planA.id)}', '${isoDate(-4)}')
    returning id::text as id`);
  uuid(staleOpenVisitId);
});

after(async () => {
  for (const householdId of createdHouseholdIds) {
    const { data: visits } = await admin.storage.from(BUCKET).list(householdId);
    for (const folder of visits ?? []) {
      const { data: files } = await admin.storage
        .from(BUCKET)
        .list(`${householdId}/${folder.name}`, { limit: 1000 });
      const paths = (files ?? []).map((f) => `${householdId}/${folder.name}/${f.name}`);
      if (paths.length) await admin.storage.from(BUCKET).remove(paths);
    }
  }
  if (createdHouseholdIds.length) {
    await admin.from("households").delete().in("id", createdHouseholdIds);
  }
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id);
  }
});

test("a new shift gets a server-chosen moment time that clients cannot set", async () => {
  // No usual hours on plan A: 30 minutes to 3 hours after the start.
  const { data } = await admin.from("visits").select("started_at, moment_at").eq("id", visitId).single();
  const delay = (Date.parse(data.moment_at) - Date.parse(data.started_at)) / 1000;
  assert.ok(delay >= 30 * 60 && delay <= 3 * 3600, `moment ${delay}s after start`);
  const forged = await caretaker.client
    .from("visits")
    .insert({ plan_id: planA.id, visit_date: isoDate(-1), moment_at: new Date().toISOString() })
    .select();
  assert.ok(forged.error, "moment_at is not client-writable on insert");
  const moved = await caretaker.client
    .from("visits")
    .update({ moment_at: new Date().toISOString() })
    .eq("id", visitId)
    .select();
  assert.ok(moved.error, "moment_at is not client-writable on update");
});

test("the moment falls between 30 minutes in and 30 minutes before the usual end", () => {
  const rows = localSql(`
    select label, (h).start_time::text as s, (h).end_time::text as e
      from (values ('3:00pm - 7:00pm'), ('3-7pm'), ('11-1pm'), ('9am to 1pm'), ('15:00–19:00'),
                   ('10pm - 6am'), ('Afternoons'), (''), ('13pm-2pm'), ('9-5'), ('9am-5pm'),
                   ('10pm-6am'), ('11-1'), ('garbage'), ('３-７pm'), ('٣-٧'), ('३-७pm')) as l(label),
           lateral (select public.schedule_hours(label) as h) x`);
  const parsed = Object.fromEntries(rows.map((r) => [r.label, [r.s, r.e]]));
  assert.deepEqual(parsed["3:00pm - 7:00pm"], ["15:00:00", "19:00:00"]);
  assert.deepEqual(parsed["3-7pm"], ["15:00:00", "19:00:00"]);
  assert.deepEqual(parsed["11-1pm"], ["11:00:00", "13:00:00"]);
  assert.deepEqual(parsed["9am to 1pm"], ["09:00:00", "13:00:00"]);
  assert.deepEqual(parsed["15:00–19:00"], ["15:00:00", "19:00:00"]);
  assert.deepEqual(parsed["10pm - 6am"], ["22:00:00", "06:00:00"]);
  assert.deepEqual(parsed["9-5"], ["09:00:00", "17:00:00"], "no am/pm, end before start: a day shift");
  assert.deepEqual(parsed["9am-5pm"], ["09:00:00", "17:00:00"]);
  assert.deepEqual(parsed["10pm-6am"], ["22:00:00", "06:00:00"], "genuinely overnight");
  assert.deepEqual(parsed["11-1"], ["11:00:00", "13:00:00"]);
  // Full-width, Arabic-Indic, and Devanagari digits are not ASCII digits: unknown hours, no error.
  for (const label of ["Afternoons", "", "13pm-2pm", "garbage", "３-７pm", "٣-٧", "३-७pm"]) {
    assert.deepEqual(parsed[label], [null, null], `"${label}" is not understood`);
  }

  // A 4-hour usual shift: 30 minutes to 3.5 hours after the start. Overnight 8 hours: 0.5-7.5 h.
  // (200 draws each of the delay the insert trigger uses.)
  const [range] = localSql(`
    with draws as (
      select label, public.moment_delay(label) as delay
        from (values ('3:00pm - 7:00pm'), ('10pm - 6am'), ('9-5'), ('')) as l(label), generate_series(1, 200)
    )
    select json_object_agg(label, json_build_array(min_s, max_s)) as r
      from (select label, extract(epoch from min(delay))::int as min_s,
                   extract(epoch from max(delay))::int as max_s
              from draws group by label) g`);
  const r = typeof range.r === "string" ? JSON.parse(range.r) : range.r;
  const within = (label, lo, hi) =>
    assert.ok(r[label][0] >= lo && r[label][1] <= hi, `${label || "(none)"}: ${r[label]} not in ${lo}..${hi}`);
  within("3:00pm - 7:00pm", 1800, 3.5 * 3600);
  within("10pm - 6am", 1800, 7.5 * 3600);
  within("9-5", 1800, 7.5 * 3600);
  within("", 1800, 3 * 3600);
});

test("an odd schedule label (non-ASCII digits, garbage) never blocks a shift; default timing", async () => {
  for (const [label, date] of [["３-７pm", isoDate(-1)], ["garbage", isoDate(1)]]) {
    assert.ifError((await parentB.client.from("plans").update({ schedule: label }).eq("id", planB.id)).error);
    const v = await parentB.client.from("visits").insert({ plan_id: planB.id, visit_date: date }).select().single();
    assert.ifError(v.error, `"${label}": the shift starts`);
    const delay = (Date.parse(v.data.moment_at) - Date.parse(v.data.started_at)) / 1000;
    assert.ok(delay >= 30 * 60 && delay <= 3 * 3600, `"${label}": fallback timing, ${delay}s`);
  }
  assert.ifError((await parentB.client.from("plans").update({ schedule: "" }).eq("id", planB.id)).error);
});

test("a parent can bring the moment forward for a demo; nobody else, and not after it is posted", async () => {
  for (const [user, code] of [
    [caretaker, "not_parent"],
    [parentB, "visit_not_found"],
    [outsider, "visit_not_found"],
  ]) {
    assertRpcError(await user.client.rpc("trigger_moment_now", { target_visit_id: visitId }), code);
  }
  assertRpcError(await parent.client.rpc("trigger_moment_now", { target_visit_id: oldVisitId }), "visit_ended");
  assertRpcError(
    await parent.client.rpc("trigger_moment_now", { target_visit_id: staleOpenVisitId }),
    "visit_too_old",
  );
  const moved = await parent.client.rpc("trigger_moment_now", { target_visit_id: tomorrowVisitId });
  assert.ifError(moved.error);
  const delay = (Date.parse(moved.data) - Date.now()) / 1000;
  assert.ok(delay >= 50 && delay <= 310, `moment ${delay}s from now`);
  const { data } = await admin.from("visits").select("moment_at").eq("id", tomorrowVisitId).single();
  assert.equal(Date.parse(data.moment_at), Date.parse(moved.data));
});

test("the photos bucket is private, limited to 5 MB, and image-only", async () => {
  const { data, error } = await admin.storage.getBucket(BUCKET);
  assert.ifError(error);
  assert.equal(data.public, false);
  assert.equal(Number(data.file_size_limit), 5 * 1024 * 1024);
  assert.deepEqual([...data.allowed_mime_types].sort(), ["image/jpeg", "image/png", "image/webp"]);

  const gif = new Blob([Uint8Array.from([0x47, 0x49, 0x46])], { type: "image/gif" });
  assert.ok((await upload(caretaker, photoPath(householdA, visitId, "jpg"), gif)).error, "gif refused");
  const big = new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: "image/jpeg" });
  assert.ok((await upload(caretaker, photoPath(householdA, visitId), big)).error, "over 5 MB refused");

  const { data: url } = anon.storage.from(BUCKET).getPublicUrl(photoPath(householdA, visitId));
  const res = await fetch(url.publicUrl);
  assert.notEqual(res.status, 200, "no public URL access");
});

test("members upload only into an open, in-window shift of their own household", async () => {
  await uploadOk(caretaker, householdA, visitId);
  await uploadOk(parent, householdA, visitId);
  await uploadOk(caretaker, householdA, tomorrowVisitId);

  for (const [user, path, why] of [
    [caretaker, photoPath(householdB, visitB), "another household's shift"],
    [caretaker, photoPath(householdA, visitB), "a visit from another household under own folder"],
    [caretaker, photoPath(householdA, oldVisitId), "an ended shift outside the window"],
    [caretaker, `${householdA}/${visitId}/not-a-uuid.jpg`, "a malformed name"],
    [caretaker, `${householdA}/${visitId}/x/${randomUUID()}.jpg`, "an extra folder"],
    [caretaker, `${householdA}/${randomUUID()}.jpg`, "no visit folder"],
    [parentB, photoPath(householdA, visitId), "a parent from another household"],
    [outsider, photoPath(householdA, visitId), "a user with no household"],
    [null, photoPath(householdA, visitId), "anon"],
  ]) {
    assert.ok((await upload(user, path)).error, `upload refused: ${why}`);
  }

  // No overwrite: no UPDATE policy, so upsert is refused and the original stays.
  const path = await uploadOk(caretaker, householdA, visitId);
  assert.ok((await upload(caretaker, path, JPEG, { upsert: true })).error, "upsert refused");
  assert.ok((await upload(caretaker, path)).error, "re-upload to the same path refused");
  const moved = await caretaker.client.storage.from(BUCKET).move(path, photoPath(householdA, visitId));
  assert.ok(moved.error, "move refused");
  const [object] = localSql(
    `select owner_id from storage.objects where bucket_id = 'photos' and name = '${uuid(householdA)}/${uuid(visitId)}/${uuid(path.split("/")[2].slice(0, 36))}.jpg'`,
  );
  assert.equal(object.owner_id, caretaker.id, "Storage stamps the uploader as owner_id");
});

test("a shift dated outside the window is refused for photos, proofs, and moments, even if open", async () => {
  const stale = photoPath(householdA, staleOpenVisitId);
  const today = photoPath(householdA, visitId);
  assert.equal((await caretaker.client.rpc("can_upload_photo", { object_name: stale })).data, false);
  assert.equal((await caretaker.client.rpc("can_upload_photo", { object_name: today })).data, true);
  assert.ok((await upload(caretaker, stale)).error, "upload refused");
  assertRpcError(await complete(caretaker, staleOpenVisitId, taskIds[2], stale), "visit_too_old");
  assertRpcError(
    await parent.client.rpc("complete_task", { target_visit_id: staleOpenVisitId, target_task_id: taskIds[2] }),
    "visit_too_old",
  );
  localSql(`update public.visits set moment_at = now() - interval '1 minute' where id = '${uuid(staleOpenVisitId)}'`);
  assertRpcError(await postMoment(caretaker, householdA, staleOpenVisitId, stale), "visit_too_old");
});

test("members read their household's photos; nobody else does", async () => {
  const path = await uploadOk(caretaker, householdA, visitId);
  const own = await parent.client.storage.from(BUCKET).download(path);
  assert.ifError(own.error);
  for (const user of [parentB, outsider]) {
    assert.ok((await user.client.storage.from(BUCKET).download(path)).error, "cross-household download");
    const list = await user.client.storage.from(BUCKET).list(`${householdA}/${visitId}`);
    assert.deepEqual(list.data ?? [], [], "cross-household listing");
  }
  assert.ok((await anon.storage.from(BUCKET).download(path)).error, "anon download");
  const signed = await parentB.client.storage.from(BUCKET).createSignedUrl(path, 60);
  assert.ok(signed.error, "a non-member cannot sign a URL");
});

test("a task is completed only through complete_task, with a photo", async () => {
  const c = caretaker.client;
  assertPermissionDenied(
    await c.from("task_checks").insert({ visit_id: visitId, task_id: taskIds[0] }).select(),
    "direct task_checks insert",
  );
  assertRpcError(await complete(caretaker, visitId, taskIds[0], null), "photo_required");
  assertRpcError(
    await complete(caretaker, visitId, taskIds[0], photoPath(householdA, visitId)),
    "photo_not_found",
  );
  const parentsPhoto = await uploadOk(parent, householdA, visitId);
  assertRpcError(await complete(caretaker, visitId, taskIds[0], parentsPhoto), "photo_not_found");
  const tomorrowPhoto = await uploadOk(caretaker, householdA, tomorrowVisitId);
  assert.ok((await complete(caretaker, visitId, taskIds[0], tomorrowPhoto)).error, "photo from another shift's folder");

  proofPath = await uploadOk(caretaker, householdA, visitId);
  assert.ok((await complete(caretaker, visitId, taskIds[0], proofPath, "", "Bogus")).error, "unknown tag");
  assertRpcError(await complete(parentB, visitId, taskIds[0], proofPath), "visit_not_found");
  assertRpcError(await complete(outsider, visitId, taskIds[0], proofPath), "visit_not_found");
  assertPermissionDenied(
    await anon.rpc("complete_task", {
      target_visit_id: visitId,
      target_task_id: taskIds[0],
      proof_photo_path: proofPath,
    }),
    "anon complete_task",
  );

  const done = await complete(caretaker, visitId, taskIds[0], proofPath, " Ate it all ", "Meal");
  assert.ifError(done.error);
  proofId = done.data;
  const { data: proof } = await parent.client.from("messages").select("*").eq("id", proofId).single();
  assert.equal(proof.kind, "task_proof");
  assert.equal(proof.body, "Ate it all");
  assert.equal(proof.tag, "Meal");
  assert.equal(proof.photo_path, proofPath);
  assert.equal(proof.task_id, taskIds[0]);
  assert.equal(proof.sender_id, caretaker.id);
  assert.equal(proof.sender_role, "caretaker");
  assert.equal(proof.late, false);
  const { data: check } = await parent.client
    .from("task_checks")
    .select("checked_by")
    .eq("visit_id", visitId)
    .eq("task_id", taskIds[0])
    .single();
  assert.equal(check.checked_by, caretaker.id);

  assertRpcError(
    await complete(caretaker, visitId, taskIds[0], await uploadOk(caretaker, householdA, visitId)),
    "task_already_done",
  );
  assert.ok((await complete(caretaker, visitId, taskIds[1], proofPath)).error, "a photo backs one proof only");
  assertRpcError(await complete(caretaker, oldVisitId, taskIds[1], proofPath), "visit_ended|visit_too_old");

  // Proofs cannot be inserted directly, even with a valid photo.
  assertDenied(
    await c
      .from("messages")
      .insert({ household_id: householdA, visit_id: visitId, kind: "task_proof", photo_path: proofPath })
      .select(),
    "direct task_proof insert",
  );
});

test("chat senders, roles, and times are stamped by the server", async () => {
  const c = caretaker.client;
  const chat = await c.from("messages").insert({ household_id: householdA, kind: "chat", body: "Hi!" }).select().single();
  assert.ifError(chat.error);
  chatId = chat.data.id;
  assert.equal(chat.data.sender_id, caretaker.id);
  assert.equal(chat.data.sender_role, "caretaker");
  assert.ok(Math.abs(Date.parse(chat.data.created_at) - Date.now()) < 60_000);

  for (const [column, value] of [
    ["sender_id", parent.id],
    ["sender_role", "parent"],
    ["created_at", "2000-01-01T00:00:00Z"],
    ["late", true],
    ["id", randomUUID()],
  ]) {
    assertPermissionDenied(
      await c.from("messages").insert({ household_id: householdA, kind: "chat", body: "x", [column]: value }).select(),
      `${column} is not client-writable`,
    );
  }
  assert.ok((await c.from("messages").insert({ household_id: householdA, kind: "chat", body: "  " })).error, "empty chat");
  assertRpcError(
    await parentB.client.from("messages").insert({ household_id: householdA, kind: "chat", body: "x" }),
    "household_not_found",
  );
  assertRpcError(
    await c.from("messages").insert({ household_id: householdA, visit_id: visitB, kind: "chat", body: "x" }),
    "visit_not_found",
  );
  assertPermissionDenied(
    await anon.from("messages").insert({ household_id: householdA, kind: "chat", body: "x" }),
    "anon chat",
  );
  assertPermissionDenied(await c.from("messages").update({ body: "edited" }).eq("id", chatId).select(), "edit");
  assertPermissionDenied(await parent.client.from("messages").delete().eq("id", chatId).select(), "delete");
});

test("one moment per shift, from the sitter, on time or labelled late by the server", async () => {
  const early = await uploadOk(caretaker, householdA, visitId);
  assertRpcError(await postMoment(caretaker, householdA, visitId, early), "moment_not_due");
  // The parent brings the prompt forward; it fires (moment_at = the database's now, after the
  // early photo was uploaded). A photo taken before the prompt cannot be the moment.
  assert.ifError((await parent.client.rpc("trigger_moment_now", { target_visit_id: visitId })).error);
  localSql(`update public.visits set moment_at = now() where id = '${uuid(visitId)}'`);
  assertRpcError(await postMoment(caretaker, householdA, visitId, early), "moment_photo_too_early");
  const path = await uploadOk(caretaker, householdA, visitId);

  assertRpcError(
    await postMoment(parent, householdA, visitId, await uploadOk(parent, householdA, visitId)),
    "not_caretaker",
  );
  assertPermissionDenied(await postMoment(caretaker, householdA, visitId, path, { late: false }), "late is server-set");

  const onTime = await postMoment(caretaker, householdA, visitId, path, { body: "At the park" });
  assert.ifError(onTime.error);
  momentId = onTime.data.id;
  assert.equal(onTime.data.late, false);
  assert.equal(onTime.data.sender_role, "caretaker");
  assertRpcError(
    await parent.client.rpc("trigger_moment_now", { target_visit_id: visitId }),
    "moment_already_posted",
  );
  assertRpcError(
    await postMoment(caretaker, householdA, visitId, await uploadOk(caretaker, householdA, visitId)),
    "moment_already_posted",
  );

  localSql(`update public.visits set moment_at = now() - interval '3 minutes' where id = '${uuid(tomorrowVisitId)}'`);
  const late = await postMoment(caretaker, householdA, tomorrowVisitId, await uploadOk(caretaker, householdA, tomorrowVisitId));
  assert.ifError(late.error);
  assert.equal(late.data.late, true, "posted more than 2 minutes after the prompt");
});

test("replies point only at a photo in the same household", async () => {
  const reply = await parent.client
    .from("messages")
    .insert({ household_id: householdA, kind: "chat", body: "Yum!", reply_to: proofId })
    .select()
    .single();
  assert.ifError(reply.error);
  assert.equal(reply.data.sender_role, "parent");
  assertRpcError(
    await parent.client.from("messages").insert({ household_id: householdA, kind: "chat", body: "x", reply_to: chatId }),
    "reply_not_found",
  );
  assertRpcError(
    await parentB.client.from("messages").insert({ household_id: householdB, kind: "chat", body: "x", reply_to: proofId }),
    "reply_not_found",
  );
});

test("read marks are per user and private", async () => {
  assert.ifError((await parent.client.from("message_reads").insert({ message_id: proofId })).error);
  assert.ifError((await caretaker.client.from("message_reads").insert({ message_id: chatId })).error);
  const mine = await caretaker.client.from("message_reads").select("message_id, user_id");
  assert.deepEqual(mine.data, [{ message_id: chatId, user_id: caretaker.id }]);
  assertPermissionDenied(
    await caretaker.client.from("message_reads").insert({ message_id: proofId, user_id: parent.id }),
    "user_id is not client-writable",
  );
  assertDenied(await parentB.client.from("message_reads").insert({ message_id: proofId }).select());
});

test("parents save photos to their own album; sitters cannot", async () => {
  assert.ifError((await parent.client.from("photo_saves").insert({ message_id: proofId })).error);
  assert.ifError((await parent.client.from("photo_saves").insert({ message_id: momentId })).error);
  assertDenied(await caretaker.client.from("photo_saves").insert({ message_id: proofId }).select(), "sitter save");
  assertDenied(await parent.client.from("photo_saves").insert({ message_id: chatId }).select(), "save a chat");
  assertDenied(await parentB.client.from("photo_saves").insert({ message_id: proofId }).select(), "cross-household save");
  assert.deepEqual((await caretaker.client.from("photo_saves").select("*")).data, [], "saves are private");
  assertDenied(await caretaker.client.from("photo_saves").delete().eq("message_id", proofId).select());
  const unsave = await parent.client.from("photo_saves").delete().eq("message_id", momentId).select();
  assert.equal(unsave.data?.length, 1);
});

test("concept flags are set only by parents and stored as concept-only", async () => {
  assertDenied(
    await caretaker.client.from("concept_flags").insert({ message_id: momentId, text: "Seems off" }).select(),
    "sitter cannot set a concept flag",
  );
  assertDenied(
    await parentB.client.from("concept_flags").insert({ message_id: momentId, text: "Seems off" }).select(),
    "cross-household flag",
  );
  assertDenied(await parent.client.from("concept_flags").insert({ message_id: chatId, text: "x" }).select(), "chat");
  assertPermissionDenied(
    await parent.client.from("concept_flags").insert({ message_id: momentId, text: "x", concept_only: false }),
    "concept_only is not client-writable",
  );
  assertPermissionDenied(
    await parent.client.from("concept_flags").insert({ message_id: momentId, text: "x", set_by: caretaker.id }),
    "set_by is not client-writable",
  );
  const flag = await parent.client
    .from("concept_flags")
    .insert({ message_id: momentId, text: "Child seems off" })
    .select()
    .single();
  assert.ifError(flag.error);
  assert.equal(flag.data.concept_only, true);
  assert.equal(flag.data.set_by, parent.id);
  assert.equal((await caretaker.client.from("concept_flags").select("id")).data.length, 1, "members read flags");
  assertDenied(await caretaker.client.from("concept_flags").delete().eq("message_id", momentId).select());

  const [comment] = localSql("select obj_description('public.concept_flags'::regclass, 'pg_class') as c");
  assert.match(comment.c, /^CONCEPT ONLY/);
});

test("a parent removes any photo: the bytes go, the message stays marked, saves and flag go", async () => {
  assert.ifError((await parent.client.from("photo_saves").insert({ message_id: momentId })).error);
  const { data: before } = await admin.from("messages").select("*").eq("id", momentId).single();
  const momentPath = before.photo_path;
  assert.ok(momentPath);

  assertRpcError(await caretaker.client.rpc("remove_photo", { target_message_id: momentId }), "not_parent");
  assertRpcError(await parentB.client.rpc("remove_photo", { target_message_id: momentId }), "message_not_found");
  assertRpcError(await parent.client.rpc("remove_photo", { target_message_id: chatId }), "message_not_found");
  assert.deepEqual(
    (await parent.client.storage.from(BUCKET).remove([momentPath])).data ?? [],
    [],
    "a photo a message uses is not deleted directly",
  );

  const removed = await parent.client.rpc("remove_photo", { target_message_id: momentId });
  assert.ifError(removed.error);
  assert.equal(removed.data, momentPath);
  const { data: after } = await caretaker.client.from("messages").select("*").eq("id", momentId).single();
  assert.equal(after.photo_path, null);
  assert.equal(after.photo_removed_by, parent.id);
  assert.ok(after.photo_removed_at);
  assert.equal(after.kind, "moment", "the message stays");
  assert.equal((await admin.from("photo_saves").select("*").eq("message_id", momentId)).data.length, 0, "saves go");
  assert.equal((await admin.from("concept_flags").select("*").eq("message_id", momentId)).data.length, 0, "flag goes");
  assertDenied(await parent.client.from("photo_saves").insert({ message_id: momentId }).select(), "save a removed photo");
  assertDenied(
    await parent.client.from("concept_flags").insert({ message_id: momentId, text: "x" }).select(),
    "flag a removed photo",
  );
  assertRpcError(await parent.client.rpc("remove_photo", { target_message_id: momentId }), "photo_already_removed");

  // Removed: nobody reads it any more, even before its object is deleted.
  for (const user of [parent, caretaker]) {
    assert.ok((await user.client.storage.from(BUCKET).download(momentPath)).error, "removed photo unreadable");
    assert.ok((await user.client.storage.from(BUCKET).createSignedUrl(momentPath, 60)).error, "no signed URL");
    assert.equal((await user.client.rpc("can_read_photo", { object_name: momentPath })).data, false);
  }
  // It cannot be attached again (the uploader tries it as a proof), and its uploader cannot
  // delete it; only a parent can.
  assertRpcError(await complete(caretaker, visitId, taskIds[1], momentPath), "photo_removed");
  assert.equal(
    (await admin.from("task_checks").select("*").eq("visit_id", visitId).eq("task_id", taskIds[1])).data.length,
    0,
    "the refused proof left no check",
  );
  assert.deepEqual((await caretaker.client.storage.from(BUCKET).remove([momentPath])).data ?? [], [], "sitter");
  assert.deepEqual((await parentB.client.storage.from(BUCKET).remove([momentPath])).data ?? [], [], "other family");

  const erased = await parent.client.storage.from(BUCKET).remove([momentPath]);
  assert.equal(erased.data?.length, 1, "the parent then erases the object");
  assert.ok((await admin.storage.from(BUCKET).download(momentPath)).error, "the bytes are gone");
  assert.ok((await upload(caretaker, momentPath)).error, "a removed path is never uploaded to again");
  assert.equal((await caretaker.client.rpc("can_upload_photo", { object_name: momentPath })).data, false);

  // A proof keeps its task check when its photo is removed.
  const bathPath = await uploadOk(caretaker, householdA, visitId);
  const bath = await complete(caretaker, visitId, taskIds[3], bathPath);
  assert.ifError(bath.error);
  assert.equal((await parent.client.rpc("remove_photo", { target_message_id: bath.data })).data, bathPath);
  assert.equal((await parent.client.storage.from(BUCKET).remove([bathPath])).data?.length, 1);
  const { data: check } = await admin
    .from("task_checks")
    .select("checked_by")
    .eq("visit_id", visitId)
    .eq("task_id", taskIds[3])
    .single();
  assert.equal(check.checked_by, caretaker.id, "the check-off and its history stay");
  const { data: proof } = await admin.from("messages").select("kind, task_id, photo_path").eq("id", bath.data).single();
  assert.deepEqual(proof, { kind: "task_proof", task_id: taskIds[3], photo_path: null });
});

test("a path a message uses cannot be uploaded again, even if its object is gone", async () => {
  const path = await uploadOk(caretaker, householdA, visitId);
  const done = await complete(caretaker, visitId, taskIds[2], path);
  assert.ifError(done.error);
  assert.ifError((await admin.storage.from(BUCKET).remove([path])).error); // e.g. a failed cleanup
  assert.ok((await upload(caretaker, path)).error, "re-upload under a used path refused");
  assert.equal((await caretaker.client.rpc("can_upload_photo", { object_name: path })).data, false);
});

test("a save or concept flag racing remove_photo is refused once the photo is removed", async (t) => {
  if (!psqlAvailable()) {
    t.skip("psql is not on PATH; this two-session test needs a direct database connection");
    return;
  }
  const task = (await parent.client.from("tasks").insert({ plan_id: planA.id, title: "Snack" }).select().single()).data;
  const path = await uploadOk(parent, householdA, visitId);
  const done = await complete(parent, visitId, task.id, path);
  assert.ifError(done.error);
  const messageId = done.data;

  // Session 1 (psql, as the parent): remove the photo and hold the transaction open.
  const marker = `photorace-${randomUUID()}`;
  const claims = JSON.stringify({ sub: uuid(parent.id), role: "authenticated" });
  const session = spawnPsql(`
    begin;
    set local role authenticated;
    select set_config('request.jwt.claims', '${claims}', true);
    select public.remove_photo('${uuid(messageId)}');
    select pg_sleep(4) /* ${marker} */;
    commit;`);
  await waitFor(() =>
    psqlQuery(`select count(*) from pg_stat_activity where state = 'active' and query like '%${marker}%' and query not like '%pg_stat_activity%'`) === "1",
  );
  // Session 2 (through the API): the RLS check's snapshot still shows the photo; the trigger
  // waits on the message lock and, once the removal commits, refuses.
  const [save, flag] = await Promise.all([
    parent.client.from("photo_saves").insert({ message_id: messageId }).select(),
    parent.client.from("concept_flags").insert({ message_id: messageId, text: "Seems off" }).select(),
  ]);
  assert.equal(await session, 0, "session 1 committed");
  assertRpcError(save, "photo_removed");
  assertRpcError(flag, "photo_removed");
  assert.equal((await admin.from("photo_saves").select("*").eq("message_id", messageId)).data.length, 0);
  assert.equal((await admin.from("concept_flags").select("*").eq("message_id", messageId)).data.length, 0);
  assert.equal((await parent.client.storage.from(BUCKET).remove([path])).data?.length, 1);
});

test("at most 2 photos per active task + 10 (+ 20 for photo messages) per shift folder; photos of a deleted shift are unreadable", async () => {
  const v = await caretaker.client.from("visits").insert({ plan_id: planA.id, visit_date: isoDate(-1) }).select().single();
  assert.ifError(v.error);
  const capVisit = v.data.id;
  const activeTasks = async () =>
    (await admin.from("tasks").select("id").eq("plan_id", planA.id).is("archived_at", null)).data.length;
  // 2 per active task + 10 for proofs, the moment and retakes, + 20 for photo messages.
  const cap = 2 * (await activeTasks()) + 10 + 20;
  const paths = Array.from({ length: cap }, () => photoPath(householdA, capVisit));
  for (let i = 0; i < paths.length; i += 10) {
    const results = await Promise.all(paths.slice(i, i + 10).map((p) => upload(caretaker, p)));
    for (const r of results) assert.ifError(r.error);
  }
  const over = photoPath(householdA, capVisit);
  const refused = await upload(caretaker, over);
  assert.ok(refused.error, `upload ${cap + 1} is refused`);
  assert.match(String(refused.error.message), /photo_limit_reached/, "a clear error code");
  assertRpcError(await caretaker.client.rpc("can_upload_photo", { object_name: over }), "photo_limit_reached");
  // Someone who could not upload there anyway just gets false, not the limit.
  assert.equal((await parentB.client.rpc("can_upload_photo", { object_name: over })).data, false);
  assert.ifError((await caretaker.client.storage.from(BUCKET).remove([paths[0]])).error);
  await uploadOk(caretaker, householdA, capVisit); // room again after a delete (back at the cap)
  assert.ok((await upload(caretaker, photoPath(householdA, capVisit))).error, "at the cap again");
  // One more active task: two more photos.
  const extra = await parent.client.from("tasks").insert({ plan_id: planA.id, title: "Story" }).select().single();
  assert.ifError(extra.error);
  await uploadOk(caretaker, householdA, capVisit);
  await uploadOk(caretaker, householdA, capVisit);
  assert.ok((await upload(caretaker, photoPath(householdA, capVisit))).error, "the new cap holds");
  // Archiving it lowers the cap again (archived tasks do not count).
  assert.ifError(
    (await parent.client.from("tasks").update({ archived_at: new Date().toISOString() }).eq("id", extra.data.id)).error,
  );
  assert.equal(2 * (await activeTasks()) + 10 + 20, cap);

  assert.ifError((await parent.client.storage.from(BUCKET).download(paths[1])).error);
  assert.ifError((await admin.from("visits").delete().eq("id", capVisit)).error);
  for (const user of [parent, caretaker]) {
    assert.ok((await user.client.storage.from(BUCKET).download(paths[1])).error, "orphan unreadable");
    assert.ok((await user.client.storage.from(BUCKET).createSignedUrl(paths[1], 60)).error, "no signed URL");
  }
  // Unreadable means undeletable by clients too (a Storage delete must see the row); only the
  // service role (a cleanup job, issue #7) removes it.
  const own = await caretaker.client.storage.from(BUCKET).remove([paths[1]]);
  assert.deepEqual(own.data ?? [], [], "an orphan is hidden from its uploader as well");
  const { data: kept } = await admin.storage.from(BUCKET).list(`${householdA}/${capVisit}`, { limit: 1000 });
  assert.equal(kept.length, cap + 2, "the orphans are still stored until cleanup");
});

test("remove_all_photos removes every photo only where the caller is the only parent", async () => {
  const p1 = await signUp("t3-bulk-p1");
  const p2 = await signUp("t3-bulk-p2");
  const h = await p1.client.rpc("create_household", { household_name: "Bulk", acknowledged: true });
  assert.ifError(h.error);
  createdHouseholdIds.push(h.data);
  const plan = (await p1.client.from("plans").insert({ household_id: h.data, title: "Day" }).select().single()).data;
  const task = (await p1.client.from("tasks").insert({ plan_id: plan.id, title: "Lunch" }).select().single()).data;
  const visit = (await p1.client.from("visits").insert({ plan_id: plan.id, visit_date: isoDate(0) }).select().single()).data;
  const used = await uploadOk(p1, h.data, visit.id);
  const proof = await complete(p1, visit.id, task.id, used);
  assert.ifError(proof.error);
  const unused = await uploadOk(p1, h.data, visit.id);
  assert.ifError((await p1.client.from("photo_saves").insert({ message_id: proof.data })).error);

  // A co-parent: the family stays after p1 leaves, so p1 removes nothing.
  localSql(`insert into public.household_members (household_id, user_id, role, email)
            values ('${uuid(h.data)}', '${uuid(p2.id)}', 'parent', '${p2.email}')`);
  assert.deepEqual((await p1.client.rpc("remove_all_photos")).data, [], "not while a co-parent exists");
  assert.deepEqual((await caretaker.client.rpc("remove_all_photos")).data, [], "a sitter removes nothing");
  const { data: kept } = await admin.from("messages").select("photo_path").eq("id", proof.data).single();
  assert.equal(kept.photo_path, used);
  // A used photo is never deleted directly, by either parent.
  for (const user of [p1, p2]) {
    assert.deepEqual((await user.client.storage.from(BUCKET).remove([used])).data ?? [], []);
  }

  // Sole parent again: every photo is removed (recorded), and every object is returned.
  localSql(`delete from public.household_members where household_id = '${uuid(h.data)}' and user_id = '${uuid(p2.id)}'`);
  const bulk = await p1.client.rpc("remove_all_photos");
  assert.ifError(bulk.error);
  assert.deepEqual([...bulk.data].sort(), [used, unused].sort());
  const { data: marked } = await p1.client.from("messages").select("photo_path, photo_removed_by").eq("id", proof.data).single();
  assert.deepEqual(marked, { photo_path: null, photo_removed_by: p1.id }, "the family keeps a Photo removed record");
  assert.equal((await admin.from("photo_saves").select("*").eq("message_id", proof.data)).data.length, 0);
  assert.equal((await p1.client.storage.from(BUCKET).download(used)).error != null, true, "removed: unreadable");
  const erased = await p1.client.storage.from(BUCKET).remove(bulk.data);
  assert.ifError(erased.error);
  assert.equal(erased.data.length, 2, "the parent deletes every returned object");
  const { data: left } = await admin.storage.from(BUCKET).list(`${h.data}/${visit.id}`);
  assert.deepEqual(left ?? [], []);
});

test("other households, outsiders, and anon see none of it", async () => {
  for (const user of [parentB, outsider]) {
    for (const table of newTables) {
      const { data, error } = await user.client.from(table).select("*");
      assert.ifError(error);
      const leaked = data.filter(
        (row) => row.household_id === householdA || [proofId, momentId, chatId].includes(row.message_id),
      );
      assert.deepEqual(leaked, [], `${table} leaks household A`);
    }
  }
  for (const table of newTables) {
    const { data, error } = await anon.from(table).select("*");
    assert.ok(error || data.length === 0, `anon read ${table}`);
  }
  for (const [name, args] of [
    ["complete_task", { target_visit_id: visitId, target_task_id: taskIds[1], proof_photo_path: "x" }],
    ["remove_all_photos", {}],
    ["can_delete_removed_photo", { object_name: "x" }],
    ["remove_photo", { target_message_id: randomUUID() }],
    ["trigger_moment_now", { target_visit_id: randomUUID() }],
    ["can_read_photo", { object_name: "x" }],
    ["can_upload_photo", { object_name: "x" }],
    ["can_delete_photo", { object_name: "x", object_owner_id: "x" }],
    ["photo_path_parts", { object_name: "x" }],
  ]) {
    assertPermissionDenied(await anon.rpc(name, args), `anon called ${name}`);
  }
});

test("after a shift ends: no photos, proofs, or moments; chat continues", async () => {
  const pending = await uploadOk(caretaker, householdA, visitId);
  const abandoned = await uploadOk(caretaker, householdA, visitId);
  assert.ifError((await caretaker.client.rpc("end_visit", { target_visit_id: visitId })).error);

  assertRpcError(await complete(caretaker, visitId, taskIds[1], pending), "visit_ended");
  assert.ok((await upload(caretaker, photoPath(householdA, visitId))).error, "upload after end");
  const removed = await caretaker.client.storage.from(BUCKET).remove([abandoned]);
  assert.equal(removed.data?.length, 1, "the uploader deletes an unused photo after the shift ended");
  const chat = await caretaker.client
    .from("messages")
    .insert({ household_id: householdA, visit_id: visitId, kind: "chat", body: "Bye!" });
  assert.ifError(chat.error);

  // Reopened (in window): proofs work again.
  assert.ifError((await parent.client.rpc("reopen_visit", { target_visit_id: visitId })).error);
  assert.ifError((await complete(caretaker, visitId, taskIds[1], pending, "", "Nap")).error);
});

test("photo deletion: unused photos by the uploader or a parent; then the departing sole parent", async () => {
  const unused = await uploadOk(caretaker, householdA, visitId);
  const other = await uploadOk(caretaker, householdA, visitId);
  assert.deepEqual((await parentB.client.storage.from(BUCKET).remove([unused])).data ?? [], [], "not another family");
  const byParent = await parent.client.storage.from(BUCKET).remove([unused]);
  assert.equal(byParent.data?.length, 1, "a parent deletes a sitter's unused photo");
  const own = await caretaker.client.storage.from(BUCKET).remove([other]);
  assert.equal(own.data?.length, 1, "uploader deletes an unused photo");
  assert.ok((await admin.storage.from(BUCKET).download(other)).error, "the bytes are gone");
  assert.deepEqual(
    (await caretaker.client.storage.from(BUCKET).remove([proofPath])).data ?? [],
    [],
    "a photo used by a message stays",
  );
  assert.deepEqual((await parent.client.storage.from(BUCKET).remove([proofPath])).data ?? [], []);

  // Account deletion: the sole parent removes every photo (messages keep a "Photo removed"
  // record), deletes the returned objects with the Storage API, then deletes the account.
  assert.deepEqual((await caretaker.client.storage.from(BUCKET).remove([proofPath])).data ?? [], []);
  assert.deepEqual((await parentB.client.storage.from(BUCKET).remove([proofPath])).data ?? [], []);
  const bulk = await parent.client.rpc("remove_all_photos");
  assert.ifError(bulk.error);
  const paths = bulk.data;
  assert.ok(paths.includes(proofPath));
  const { data: stillUsed } = await admin
    .from("messages")
    .select("id")
    .eq("household_id", householdA)
    .not("photo_path", "is", null);
  assert.deepEqual(stillUsed, [], "no message points at a photo any more");
  assert.ok((await caretaker.client.storage.from(BUCKET).download(proofPath)).error, "removed: unreadable");
  assert.deepEqual((await caretaker.client.storage.from(BUCKET).remove([proofPath])).data ?? [], [], "sitter");
  const removed = await parent.client.storage.from(BUCKET).remove(paths);
  assert.ifError(removed.error);
  assert.equal(removed.data.length, paths.length, "the sole parent removes every photo");

  assert.ifError((await parent.client.rpc("delete_my_account")).error);
  for (const table of newTables) {
    const { data } = await admin.from(table).select("*");
    const left = data.filter(
      (row) => row.household_id === householdA || [proofId, momentId, chatId].includes(row.message_id),
    );
    assert.deepEqual(left, [], `${table} rows remain after account deletion`);
  }
  const { data: leftover } = await admin.storage.from(BUCKET).list(`${householdA}/${visitId}`);
  assert.deepEqual(leftover ?? [], [], "no photos remain");
  const { count } = await admin.from("households").select("*", { count: "exact", head: true }).eq("id", householdB);
  assert.equal(count, 1, "other households are untouched");
});

// SI-39: a photo message is a chat with a photo, posted by the sitter into an open shift (the
// gallery's "+"). Each test has its own family so the shared fixtures above keep their counts.
async function photoFamily(label) {
  const mom = await signUp(`${label}-parent`);
  const sitter = await signUp(`${label}-sitter`);
  const h = await mom.client.rpc("create_household", { household_name: "Photo msgs", acknowledged: true });
  assert.ifError(h.error);
  const hh = h.data;
  createdHouseholdIds.push(hh);
  const invite = await mom.client.rpc("create_invite", { target_household_id: hh, invite_email: sitter.email });
  assert.ifError(invite.error);
  assert.ifError((await sitter.client.rpc("accept_invite", { invite_token: invite.data })).error);
  const plan = (await mom.client.from("plans").insert({ household_id: hh, title: "Day" }).select().single()).data;
  const task = (await mom.client.from("tasks").insert({ plan_id: plan.id, title: "Lunch" }).select().single()).data;
  const visit = (await sitter.client.from("visits").insert({ plan_id: plan.id, visit_date: isoDate(0) }).select().single()).data;
  return { mom, sitter, hh, plan, task, visit };
}

test("photo messages: the sitter's, in an open shift, own photo; parents can remove them", async () => {
  const { mom, sitter, hh, plan, task, visit } = await photoFamily("pm");
  const [{ id: endedVisit }] = localSql(`
    insert into public.visits (plan_id, visit_date, ended_at)
    values ('${uuid(plan.id)}', '${isoDate(-1)}', now()) returning id::text as id`);
  const [{ id: oldVisit }] = localSql(`
    insert into public.visits (plan_id, visit_date)
    values ('${uuid(plan.id)}', '${isoDate(-3)}') returning id::text as id`);
  const [{ id: nextVisit }] = localSql(`
    insert into public.visits (plan_id, visit_date)
    values ('${uuid(plan.id)}', '${isoDate(1)}') returning id::text as id`);

  const send = (user, extra) =>
    user.client
      .from("messages")
      .insert({ household_id: hh, visit_id: visit.id, kind: "chat", ...extra })
      .select()
      .single();

  // The sitter posts one with no caption, and one with a caption.
  const p1 = await uploadOk(sitter, hh, visit.id);
  const bare = await send(sitter, { photo_path: p1 });
  assert.ifError(bare.error);
  assert.equal(bare.data.kind, "chat");
  assert.equal(bare.data.sender_role, "caretaker");
  assert.equal(bare.data.body, "");
  assert.equal(bare.data.visit_id, visit.id);
  const p2 = await uploadOk(sitter, hh, visit.id);
  const captioned = await send(sitter, { photo_path: p2, body: "Building a tower" });
  assert.ifError(captioned.error);
  assert.equal(captioned.data.body, "Building a tower");

  // Members read the photo; nobody else.
  for (const user of [mom, sitter]) assert.ifError((await user.client.storage.from(BUCKET).download(p1)).error);
  assert.ok((await outsider.client.storage.from(BUCKET).download(p1)).error, "outsider cannot read");

  // Only the sitter: a parent's photo message is refused (their own photo, open shift).
  const momPhoto = await uploadOk(mom, hh, visit.id);
  assertRpcError(await send(mom, { photo_path: momPhoto }), "not_caretaker");
  assertDenied(await send(outsider, { photo_path: momPhoto }), "an outsider cannot post");
  // The photo must be uploaded, by the sender, in this shift's folder, and not used already.
  assertRpcError(await send(sitter, { photo_path: photoPath(hh, visit.id) }), "photo_not_found");
  assertRpcError(await send(sitter, { photo_path: momPhoto }), "photo_not_found");
  // Another family's folder: not the sender's upload here, so it is not found.
  assertRpcError(await send(sitter, { photo_path: photoPath(householdB, visitB) }), "photo_not_found");
  // The sitter's own upload in another open shift's folder passes the trigger; the path check
  // ties the folder to this message's shift.
  const otherShift = await uploadOk(sitter, hh, nextVisit);
  const wrongFolder = await send(sitter, { photo_path: otherShift });
  assert.equal(wrongFolder.error?.code, "23514", "the folder must be this message's shift");
  assert.match(wrongFolder.error.message, /messages_check5/);
  const reused = await send(sitter, { photo_path: p1 });
  assert.equal(reused.error?.code, "23505", "a path already used");
  assert.match(reused.error.message, /messages_photo_path_key/);
  const proofPhoto = await uploadOk(sitter, hh, visit.id);
  const proof = await complete(sitter, visit.id, task.id, proofPhoto);
  assert.ifError(proof.error);
  const proofReuse = await send(sitter, { photo_path: proofPhoto });
  assert.equal(proofReuse.error?.code, "23505", "a proof's photo");
  assert.match(proofReuse.error.message, /messages_photo_path_key/);
  // Not a reply, even to a photo in this family (which passes the trigger's reply check); no
  // photo without a shift; text chat still needs text.
  const p3 = await uploadOk(sitter, hh, visit.id);
  const reply = await send(sitter, { photo_path: p3, reply_to: proof.data });
  assert.equal(reply.error?.code, "23514", "not a reply");
  assert.match(reply.error.message, /messages_chat_photo_shape/);
  assert.ifError((await send(sitter, { body: "Nice", reply_to: proof.data })).error, "a text reply to it is fine");
  assert.ok(
    (await sitter.client.from("messages").insert({ household_id: hh, kind: "chat", photo_path: p3 })).error,
    "a photo message needs its shift",
  );
  assert.ok((await send(sitter, { body: "   " })).error, "empty text chat");
  assert.ok(
    (await sitter.client.from("messages").insert({ household_id: hh, kind: "chat", body: "" })).error,
    "empty text chat without a shift",
  );
  // Clients cannot fake a removed-photo tombstone (the column is not writable).
  assert.ok((await send(sitter, { body: "x", photo_removed_at: new Date().toISOString() })).error);

  // Ended or out-of-window shifts take no photo messages (the upload itself is refused there too,
  // so only the database check matters for a path left over from before the end).
  assertRpcError(
    await sitter.client.from("messages").insert({ household_id: hh, visit_id: endedVisit, kind: "chat", photo_path: photoPath(hh, endedVisit) }),
    "visit_ended",
  );
  assertRpcError(
    await sitter.client.from("messages").insert({ household_id: hh, visit_id: oldVisit, kind: "chat", photo_path: photoPath(hh, oldVisit) }),
    "visit_too_old",
  );

  // Album saves and concept flags stay proof/moment only.
  assert.ok((await mom.client.from("photo_saves").insert({ message_id: captioned.data.id })).error, "no save");
  assertPermissionDenied(
    await mom.client.from("concept_flags").insert({ message_id: captioned.data.id, text: "Seems off" }),
    "no concept flag on a photo message",
  );
  assert.equal((await admin.from("concept_flags").select("*").eq("message_id", captioned.data.id)).data.length, 0);

  // A sitter cannot remove, nor a parent of another family; a parent here can: tombstone,
  // unreadable, never reused.
  assertRpcError(await sitter.client.rpc("remove_photo", { target_message_id: bare.data.id }), "not_parent");
  assertRpcError(await parentB.client.rpc("remove_photo", { target_message_id: bare.data.id }), "message_not_found");
  const removed = await mom.client.rpc("remove_photo", { target_message_id: bare.data.id });
  assert.ifError(removed.error);
  assert.equal(removed.data, p1);
  const { data: tomb } = await mom.client
    .from("messages")
    .select("photo_path, photo_removed_by, body")
    .eq("id", bare.data.id)
    .single();
  assert.deepEqual(tomb, { photo_path: null, photo_removed_by: mom.id, body: "" });
  assert.ok((await sitter.client.storage.from(BUCKET).download(p1)).error, "removed: unreadable");
  assert.ifError((await mom.client.storage.from(BUCKET).remove([p1])).error);
  assert.ok((await upload(sitter, p1)).error, "a removed path is never uploaded again");
  assertRpcError(await mom.client.rpc("remove_photo", { target_message_id: bare.data.id }), "photo_already_removed");
  // A removed photo cannot be attached again while its object still exists.
  const p4 = await uploadOk(sitter, hh, visit.id);
  const doomed = await send(sitter, { photo_path: p4 });
  assert.ifError(doomed.error);
  assert.equal((await mom.client.rpc("remove_photo", { target_message_id: doomed.data.id })).data, p4);
  assertRpcError(await send(sitter, { photo_path: p4 }), "photo_removed");
  assert.equal((await mom.client.storage.from(BUCKET).remove([p4])).data?.length, 1);
  // Text chat has no photo to remove.
  const text = await send(mom, { body: "Thanks!" });
  assert.ifError(text.error);
  assertRpcError(await mom.client.rpc("remove_photo", { target_message_id: text.data.id }), "message_not_found");

  // Deleting the account path: remove_all_photos covers photo messages.
  const bulk = await mom.client.rpc("remove_all_photos");
  assert.ifError(bulk.error);
  assert.ok(bulk.data.includes(p2), "the captioned photo message's object is returned");
  const { data: after } = await admin.from("messages").select("photo_path, photo_removed_by").eq("id", captioned.data.id).single();
  assert.deepEqual(after, { photo_path: null, photo_removed_by: mom.id });
});

test("a photo message racing end_visit is refused once the shift has ended", async (t) => {
  if (!psqlAvailable()) {
    t.skip("psql is not on PATH; this two-session test needs a direct database connection");
    return;
  }
  const { mom, sitter, hh, visit } = await photoFamily("pmrace");
  const path = await uploadOk(sitter, hh, visit.id);

  // Session 1 (psql, as the parent): end the shift and hold the transaction open.
  const marker = `pmrace-${randomUUID()}`;
  const claims = JSON.stringify({ sub: uuid(mom.id), role: "authenticated" });
  const session = spawnPsql(`
    begin;
    set local role authenticated;
    select set_config('request.jwt.claims', '${claims}', true);
    select public.end_visit('${uuid(visit.id)}');
    select pg_sleep(4) /* ${marker} */;
    commit;`);
  await waitFor(() =>
    psqlQuery(`select count(*) from pg_stat_activity where state = 'active' and query like '%${marker}%' and query not like '%pg_stat_activity%'`) === "1",
  );
  // Session 2 (through the API): stamp_message waits on the visit's share lock, then sees the end.
  const raced = await sitter.client
    .from("messages")
    .insert({ household_id: hh, visit_id: visit.id, kind: "chat", photo_path: path })
    .select();
  assert.equal(await session, 0, "session 1 committed");
  assertRpcError(raced, "visit_ended");
  const { count } = await admin
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("visit_id", visit.id)
    .not("photo_path", "is", null);
  assert.equal(count, 0, "no photo message landed on the ended shift");
  // The unused photo is still the sitter's to delete.
  assert.equal((await sitter.client.storage.from(BUCKET).remove([path])).data?.length, 1);
});

test("a shift takes at most 20 live photo messages; task photos keep their room", async () => {
  const { mom, sitter, hh, task, visit } = await photoFamily("pmcap");
  const send = (path) =>
    sitter.client
      .from("messages")
      .insert({ household_id: hh, visit_id: visit.id, kind: "chat", photo_path: path })
      .select()
      .single();
  const paths = Array.from({ length: 21 }, () => photoPath(hh, visit.id));
  for (let i = 0; i < paths.length; i += 10) {
    const results = await Promise.all(paths.slice(i, i + 10).map((p) => upload(sitter, p)));
    for (const r of results) assert.ifError(r.error);
  }
  const first = await Promise.all(paths.slice(0, 10).map(send));
  for (const r of first) assert.ifError(r.error);
  // The last 11 race each other: the per-shift lock lets exactly 10 in.
  const rest = await Promise.all(paths.slice(10).map(send));
  const refused = rest.filter((r) => r.error);
  assert.equal(refused.length, 1, "the 21st photo message is refused");
  assertRpcError(refused[0], "photo_limit_reached");
  const leftover = paths.slice(10)[rest.findIndex((r) => r.error)];
  const { count } = await admin
    .from("messages")
    .select("*", { count: "exact", head: true })
    .eq("visit_id", visit.id)
    .eq("kind", "chat")
    .not("photo_path", "is", null);
  assert.equal(count, 20, "20 photo messages landed");

  // Task photos keep their room: the sitter can still upload and complete a task with a photo.
  const proofPhoto = await uploadOk(sitter, hh, visit.id);
  assert.ifError((await complete(sitter, visit.id, task.id, proofPhoto)).error);

  // A parent removing one frees room for one more.
  const removed = await mom.client.rpc("remove_photo", { target_message_id: first[0].data.id });
  assert.ifError(removed.error);
  const again = await send(leftover);
  assert.ifError(again.error);
  const extra = await uploadOk(sitter, hh, visit.id);
  assertRpcError(await send(extra), "photo_limit_reached");
});

test("a photo re-attached while a parent removes it is refused; the parent can still delete it", async (t) => {
  if (!psqlAvailable()) {
    t.skip("psql is not on PATH; this two-session test needs a direct database connection");
    return;
  }
  for (const removal of ["remove_photo", "remove_all_photos"]) {
    const { mom, sitter, hh, visit } = await photoFamily(`reattach-${removal}`);
    const path = await uploadOk(sitter, hh, visit.id);
    const send = () =>
      sitter.client.from("messages").insert({ household_id: hh, visit_id: visit.id, kind: "chat", photo_path: path }).select().single();
    const first = await send();
    assert.ifError(first.error);

    // Session 1 (psql, as the parent): remove the photo and hold the transaction open.
    const marker = `reattach-${randomUUID()}`;
    const claims = JSON.stringify({ sub: uuid(mom.id), role: "authenticated" });
    const call = removal === "remove_photo" ? `public.remove_photo('${uuid(first.data.id)}')` : "public.remove_all_photos()";
    const session = spawnPsql(`
      begin;
      set local role authenticated;
      select set_config('request.jwt.claims', '${claims}', true);
      select ${call};
      select pg_sleep(6) /* ${marker} */;
      commit;`);
    await waitFor(() =>
      psqlQuery(`select count(*) from pg_stat_activity where state = 'active' and query like '%${marker}%' and query not like '%pg_stat_activity%'`) === "1",
    );
    // Session 2 (through the API): stamp_message waits on the message the removal holds, then
    // sees the removal. Check it really waited on session 1, or a slow run could pass anyway.
    const raced = send().then((r) => r);
    await waitFor(() =>
      psqlQuery(`select count(*) from pg_stat_activity a where exists (select 1 from pg_stat_activity b where b.pid = any (pg_blocking_pids(a.pid)) and b.query like '%${marker}%' and b.query not like '%pg_stat_activity%')`) === "1",
    );
    assert.equal(await session, 0, `${removal}: session 1 committed`);
    assertRpcError(await raced, "photo_removed");
    const { count } = await admin.from("messages").select("*", { count: "exact", head: true }).eq("photo_path", path);
    assert.equal(count, 0, `${removal}: no message re-attached the removed path`);
    assert.equal((await mom.client.storage.from(BUCKET).remove([path])).data?.length, 1, `${removal}: parent deletes it`);
  }
});

// Issue #7: the hourly sweep deletes orphans through the Storage API and keeps live photos. It
// sweeps the whole bucket, so it must stay the last test of this file (test:rls runs files one
// at a time); earlier tests' orphans go too.
test("the photo cleanup removes every kind of orphan and keeps live photos", async (t) => {
  if (!psqlAvailable()) {
    t.skip("psql is not on PATH; this test needs a direct database connection");
    return;
  }
  const secretNames = "('carenest_project_url', 'carenest_photo_cleanup_key')";
  if (psqlQuery(`select count(*) from vault.secrets where name in ${secretNames}`) !== "0") {
    t.skip("this stack has photo cleanup secrets configured; the test would replace them");
    return;
  }
  const live = await photoFamily("sweep");
  const { mom, sitter, hh, visit } = live;
  const send = (path) =>
    sitter.client.from("messages").insert({ household_id: hh, visit_id: visit.id, kind: "chat", photo_path: path }).select().single();
  const backdate = (path, interval) =>
    localSql(`update storage.objects set created_at = now() - interval '${interval}'
               where bucket_id = 'photos' and name = '${path.replace(/'/g, "")}'`);

  const used = await uploadOk(sitter, hh, visit.id);
  assert.ifError((await send(used)).error);
  backdate(used, "30 days"); // a used photo stays, however old
  const fresh = await uploadOk(sitter, hh, visit.id); // unused, under 24 hours: kept
  backdate(fresh, "23 hours");
  const waiting = await uploadOk(sitter, hh, visit.id); // unused, old, its shift can still use it: kept
  backdate(waiting, "60 hours");
  // A shift dated 2 days ago can no longer take photos (stamp_message's date window).
  const [{ id: closedVisit }] = localSql(`
    insert into public.visits (plan_id, visit_date) values ('${uuid(live.plan.id)}', '${isoDate(-2)}')
    returning id::text as id`);
  const stale = photoPath(hh, uuid(closedVisit)); // unused, window closed, over 24 hours: orphan
  assert.ifError((await upload({ client: admin }, stale)).error);
  backdate(stale, "25 hours");
  const closedFresh = photoPath(hh, closedVisit); // window closed but under 24 hours: kept
  assert.ifError((await upload({ client: admin }, closedFresh)).error);
  // Yesterday's shift still takes photos (the window's last day): an old unused upload stays.
  const [{ id: yesterdayVisit }] = localSql(`
    insert into public.visits (plan_id, visit_date) values ('${uuid(live.plan.id)}', '${isoDate(-1)}')
    returning id::text as id`);
  const yesterday = photoPath(hh, uuid(yesterdayVisit));
  assert.ifError((await upload({ client: admin }, yesterday)).error);
  backdate(yesterday, "30 hours");
  const removedPath = await uploadOk(sitter, hh, visit.id); // removed, Storage delete "failed"
  const removedMsg = await send(removedPath);
  assert.ifError(removedMsg.error);
  assert.ifError((await mom.client.rpc("remove_photo", { target_message_id: removedMsg.data.id })).error);
  const goneShift = (await sitter.client.from("visits").insert({ plan_id: live.plan.id, visit_date: isoDate(1) }).select().single()).data;
  const shiftOrphan = await uploadOk(sitter, hh, goneShift.id);
  assert.ifError((await admin.from("visits").delete().eq("id", goneShift.id)).error);
  const gone = await photoFamily("sweep-gone"); // household deleted mid account deletion
  const familyOrphan = await uploadOk(gone.sitter, gone.hh, gone.visit.id);
  assert.ifError((await admin.from("households").delete().eq("id", gone.hh)).error);

  // Members cannot run it; unconfigured, it fails loudly.
  assertPermissionDenied(await mom.client.rpc("sweep_orphan_photos"), "members cannot run the sweep");
  assertPermissionDenied(await mom.client.rpc("photo_orphans"), "members cannot list orphans");
  assert.throws(() => psqlQuery("select public.sweep_orphan_photos()"), /photo_cleanup_not_configured/);
  const [job] = localSql("select schedule, command from cron.job where jobname = 'carenest-photo-cleanup'");
  assert.deepEqual(job, { schedule: "17 * * * *", command: "select public.sweep_orphan_photos()" });

  // The database container reaches Storage through this stack's API gateway.
  const gateway = `http://supabase_kong_${process.env.SUPABASE_PROJECT_ID ?? "carenest"}:8000`;
  assert.match(gateway, /^http:\/\/[a-z0-9_-]+:8000$/);
  assert.match(serviceKey, /^[A-Za-z0-9._-]+$/);
  psqlQuery(`select vault.create_secret('${gateway}', 'carenest_project_url');
             select vault.create_secret('${serviceKey}', 'carenest_photo_cleanup_key');`);
  try {
    for (let pass = 0; pass < 5; pass++) {
      const requestId = psqlQuery("select public.sweep_orphan_photos()");
      if (!requestId) break; // nothing left to delete
      await waitFor(() => psqlQuery(`select count(*) from net._http_response where id = ${Number(requestId)}`) === "1", 10000);
      assert.equal(psqlQuery(`select status_code from net._http_response where id = ${Number(requestId)}`), "200");
    }
  } finally {
    psqlQuery(`delete from vault.secrets where name in ${secretNames}`);
  }

  const cases = { used, fresh, waiting, closedFresh, yesterday, stale, removedPath, shiftOrphan, familyOrphan };
  const stored = new Set(
    localSql(`select name from storage.objects where bucket_id = 'photos'
               and name in ('${Object.values(cases).join("','")}')`).map((r) => r.name),
  );
  const outcome = Object.fromEntries(Object.entries(cases).map(([k, p]) => [k, stored.has(p)]));
  assert.deepEqual(outcome, {
    used: true,
    fresh: true,
    waiting: true,
    closedFresh: true,
    yesterday: true,
    stale: false,
    removedPath: false,
    shiftOrphan: false,
    familyOrphan: false,
  });
  assert.ifError((await mom.client.storage.from(BUCKET).download(used)).error, "the live photo still downloads");
});
