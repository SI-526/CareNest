// CareNestShift — the sitter's shift, task checks, proofs, moments, and the message thread.
//
// One module, two backends with the same shape:
//   * Supabase (every signed-in person): visits, task_checks, shift_events, messages, and the
//     private `photos` Storage bucket. The database decides everything that matters (who sent a
//     message, its time, whether a moment is late, whether a shift is open); this file only asks.
//   * Demo (?demo=1 only): js/store.js in localStorage, unchanged in spirit.
//
// Load order: after js/family-data.js and js/store.js, before js/app.js and js/moment.js. Page
// scripts wait on CareNestShift.ready, which resolves to the backend once its first load is done
// (or failed; then state.loadError is set and refresh() retries).
//
// state (read it after ready or in a subscribe() callback):
//   visit     the latest shift of the family's plan, or null
//   active    open and dated yesterday..tomorrow (database UTC date), so photos can be added
//   ended / tooOld / canReopen / canStart / noPlan, lock explanation inputs
//   events    shift history [{ kind: ended|reopened|unchecked, at, actorName, taskTitle }]
//   checks    taskId -> { checkedAt, checkedByName, afterReopen, snapshot, proof }
//   moment    this shift's moment message, or null
//   thread    the household's messages, oldest first (messages and parent pages)
//   feed      this shift's proofs and moments, newest first (parent page)
//   reads     Set of message ids this person has seen (message_reads)
//   saves     message id -> saved time (this parent's photo_saves)
//   album     this parent's saved photo messages, newest save first
//   flags     message id -> concept flag text (CONCEPT ONLY: typed by a parent, never analysis)
//   gallery   the family's photos across shifts, oldest first, removed ones skipped (gallery page):
//             messages plus source (task|message|moment), title, shiftDate ('YYYY-MM-DD')
(function () {
  const auth = window.CareNestAuth;
  const store = window.CareNestStore;
  const family = window.CareNestFamily;
  const page = document.body.dataset.page;
  if (!store || !["home", "messages", "parent", "gallery"].includes(page)) return;

  const MOMENT_WINDOW_MS = 2 * 60 * 1000;
  const THREAD_LIMIT = 300;
  // ponytail: the gallery shows the newest 500 photos; past that, paginate (load older on scroll).
  const GALLERY_LIMIT = 500;
  const FORMER = "a former member";

  // Server error codes (raise exception '<code>') -> what to tell the person.
  const ERRORS = {
    visit_already_ended: "This shift has already ended.",
    visit_not_ended: "This shift is already open.",
    visit_not_found: "We couldn't find this shift. Reload the page and try again.",
    visit_ended: "This shift has ended. Photos can't be added after a shift.",
    visit_too_old: "This shift is too old to change. Shifts before yesterday are read-only.",
    task_archived: "This task was taken off the schedule, so it can't be checked off.",
    task_not_found: "This task is no longer on the schedule.",
    task_already_done: "This task is already checked off.",
    moment_not_due: "It isn't time for a moment yet.",
    moment_already_posted: "A moment has already been shared for this shift.",
    photo_required: "Please add a photo before sending.",
    photo_not_found: "The photo didn't finish uploading. Please try again.",
    photo_already_removed: "That photo was already removed.",
    photo_removed: "That photo was removed by a parent.",
    photo_limit_reached: "Photo limit reached for this shift.",
    moment_photo_too_early: "That photo was taken before the moment prompt. Take a new one now.",
    message_not_found: "That photo is no longer available. Reload the page.",
    reply_not_found: "That photo is no longer available.",
    not_caretaker: "Only the sitter can do that.",
    not_parent: "Only a parent can do that.",
    household_not_found: "Please sign in again.",
    not_authenticated: "Please sign in again.",
  };

  function friendly(message) {
    const err = new Error(message);
    err.friendly = true;
    return err;
  }

  function errorMessage(err) {
    if (!err) return "Something went wrong. Please try again.";
    if (err.friendly || err instanceof store.StoreError) return err.message;
    const message = String(err.message || err.error || err.msg || "");
    const code = Object.keys(ERRORS).find((key) => message.includes(key));
    if (code) return ERRORS[code];
    const status = Number(err.statusCode || err.status || 0);
    if (status === 413 || /maximum allowed size|too large|payload/i.test(message)) {
      return "This photo is too large (5 MB at most). Try a smaller one.";
    }
    if (status === 415 || /mime type|invalid_mime|not supported/i.test(message)) {
      return "That file type isn't supported. Use a JPEG, PNG, or WebP photo.";
    }
    if (/quota/i.test(message)) {
      return "There's no room left for photos on this shift.";
    }
    if (err.code === "23505" || /duplicate key/i.test(message)) {
      return "Today's shift has already started. Reload the page.";
    }
    if (/row-level security|unauthorized|forbidden/i.test(message) || status === 403) {
      return "This shift isn't open for photos right now. Reload the page and try again.";
    }
    if (/fetch|network|load failed/i.test(message) || err.name === "TypeError") {
      return "We couldn't reach CareNest. Check your connection and try again.";
    }
    return auth ? auth.friendlyError(err) : "Something went wrong. Please try again.";
  }

  // 'YYYY-MM-DD' of the UTC day offset from today (the database's shift-window clock).
  function utcDay(offset) {
    return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  }

  function formatTaskTime(value) {
    return family && family.formatTaskTime ? family.formatTaskTime(value) : "";
  }

  function demoMode() {
    try {
      return (
        new URLSearchParams(window.location.search).has("demo") ||
        sessionStorage.getItem("carenest:demo") === "1"
      );
    } catch (e) {
      return false;
    }
  }

  function dataUrlToBlob(dataUrl) {
    const [head, b64] = dataUrl.split(",");
    const type = (/data:([^;]+)/.exec(head) || [])[1] || "image/jpeg";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  // Shared by both backends: is the BeReal-style prompt due for this shift?
  function momentStatus(state, now) {
    if (!state.active || !state.visit) return { state: "none" };
    if (state.moment) return { state: "posted" };
    const momentAt = state.visit.momentAt;
    if (!momentAt || now < momentAt) return { state: "waiting", momentAt };
    const deadline = momentAt + MOMENT_WINDOW_MS;
    return { state: "due", momentAt, deadline, late: now > deadline };
  }

  function emptyState() {
    return {
      loaded: false,
      loadError: null,
      visit: null,
      active: false,
      ended: false,
      tooOld: false,
      canReopen: false,
      canStart: false,
      noPlan: false,
      events: [],
      checks: {},
      moment: null,
      thread: [],
      feed: [],
      reads: new Set(),
      saves: {},
      album: [],
      flags: {},
      gallery: [],
    };
  }

  // A photo for the gallery: task update (proof), photo message (chat with a photo), or moment.
  function galleryItem(m, title, shiftDate) {
    const source = m.kind === "task_proof" ? "task" : m.kind === "moment" ? "moment" : "message";
    const fallback = source === "task" ? "Task" : source === "moment" ? "Moment" : "Photo message";
    return Object.assign({}, m, { source, title: title || fallback, shiftDate });
  }

  // Proofs and moments of the current shift, newest first, with the check's snapshot title.
  function buildFeed(visitMessages, checks, reopened, firstEnded) {
    return visitMessages
      .filter((m) => m.kind === "task_proof" || m.kind === "moment")
      .map((m) => {
        const check = m.kind === "task_proof" ? checks[m.taskId] : null;
        const own = check && check.proof && check.proof.id === m.id;
        return Object.assign({}, m, {
          title: m.kind === "moment" ? "Moment" : (own && check.snapshot.title) || m.taskTitle || "Task",
          taskTime: own ? check.snapshot.time : m.taskTime,
          afterReopen:
            m.kind === "task_proof" && reopened && firstEnded !== null && m.createdAt > firstEnded,
        });
      })
      .reverse();
  }

  // ---------------------------------------------------------------- Supabase

  const MSG_COLS =
    "id, household_id, visit_id, kind, body, photo_path, task_id, tag, reply_to, sender_id, " +
    "sender_role, created_at, late, photo_removed_by, photo_removed_at, task:tasks(title, time_of_day)";

  function createSupabaseBackend(ctx, data) {
    const client = ctx.client;
    const householdId = ctx.household.id;
    const me = ctx.user.id;
    const listeners = new Set();
    const photoCache = new Map(); // Storage path -> Promise<object URL>
    const blobCache = new Map(); // Storage path -> Promise<Blob>
    const blobReady = new Map(); // Storage path -> Blob, once downloaded (for a synchronous share)
    const wantParent = page === "parent" && ctx.role === "parent";
    const wantThread = page === "messages" || wantParent;
    const wantGallery = page === "gallery";
    let state = emptyState();
    let loadSeq = 0;
    let reloadTimer = null;

    function nameOf(userId) {
      if (!userId) return FORMER;
      const member = (ctx.members || []).find((m) => m.user_id === userId);
      return member ? auth.firstName(member) : FORMER;
    }

    function toMessage(row) {
      return {
        id: row.id,
        kind: row.kind,
        body: row.body || "",
        visitId: row.visit_id,
        taskId: row.task_id,
        taskTitle: row.task ? row.task.title : null,
        taskTime: row.task ? formatTaskTime(row.task.time_of_day) : "",
        tag: row.tag || null,
        replyTo: row.reply_to,
        senderRole: row.sender_role,
        senderName: nameOf(row.sender_id),
        mine: row.sender_id === me,
        createdAt: Date.parse(row.created_at),
        late: Boolean(row.late),
        photoPath: row.photo_path,
        photoRemoved: Boolean(row.photo_removed_at),
        photoRemovedByName: row.photo_removed_at ? nameOf(row.photo_removed_by) : null,
      };
    }

    function notify() {
      listeners.forEach((fn) => fn(state));
    }

    async function load() {
      const seq = ++loadSeq;
      const planId = data.planId;
      let visit = null;
      if (planId) {
        const res = await client
          .from("visits")
          .select("id, visit_date, started_at, started_by, ended_at, ended_by, moment_at")
          .eq("plan_id", planId)
          .order("visit_date", { ascending: false })
          .order("started_at", { ascending: false })
          .limit(1);
        if (res.error) throw res.error;
        visit = (res.data && res.data[0]) || null;
      }

      const none = { data: [] };
      const [checksRes, eventsRes, visitMsgsRes, threadRes, readsRes, savesRes, flagsRes, galleryRes] = await Promise.all([
        visit
          ? client
              .from("task_checks")
              .select(
                "task_id, checked_by, checked_at, task_title, task_time_of_day, task_detail, task_location, task_care_note"
              )
              .eq("visit_id", visit.id)
          : { data: [] },
        visit
          ? client
              .from("shift_events")
              .select("kind, task_id, actor_id, created_at, task:tasks(title)")
              .eq("visit_id", visit.id)
              .order("created_at", { ascending: true })
          : { data: [] },
        visit
          ? client
              .from("messages")
              .select(MSG_COLS)
              .eq("visit_id", visit.id)
              .neq("kind", "chat")
              .order("created_at", { ascending: true })
          : { data: [] },
        wantThread
          ? client
              .from("messages")
              .select(MSG_COLS)
              .eq("household_id", householdId)
              .order("created_at", { ascending: false })
              .limit(THREAD_LIMIT)
          : { data: [] },
        // RLS: each person reads only their own read marks and saves; flags of their household.
        wantParent
          ? client.from("message_reads").select("message_id").order("read_at", { ascending: false }).limit(1000)
          : none,
        wantParent
          ? client
              .from("photo_saves")
              .select(`message_id, saved_at, message:messages(${MSG_COLS})`)
              .order("saved_at", { ascending: false })
              .limit(THREAD_LIMIT)
          : none,
        wantParent ? client.from("concept_flags").select("message_id, text") : none,
        // Newest first so the ceiling drops the oldest photos; shown oldest first below.
        wantGallery
          ? client
              .from("messages")
              .select(`${MSG_COLS}, visit:visits(visit_date)`)
              .eq("household_id", householdId)
              .not("photo_path", "is", null)
              .order("created_at", { ascending: false })
              .limit(GALLERY_LIMIT)
          : none,
      ]);
      const failed = [checksRes, eventsRes, visitMsgsRes, threadRes, readsRes, savesRes, flagsRes, galleryRes].find(
        (r) => r.error
      );
      if (failed) throw failed.error;
      // Past shifts show the task as it was checked off (task_checks snapshot), not the live task.
      const galleryRows = (galleryRes.data || []).slice().reverse();
      const proofVisits = Array.from(new Set(galleryRows.filter((r) => r.kind === "task_proof").map((r) => r.visit_id)));
      // 100 ids per request keeps each URL well under PostgREST/proxy limits on a long history.
      const visitChunks = [];
      for (let i = 0; i < proofVisits.length; i += 100) visitChunks.push(proofVisits.slice(i, i + 100));
      const snapshotResults = await Promise.all(
        visitChunks.map((ids) => client.from("task_checks").select("visit_id, task_id, task_title").in("visit_id", ids))
      );
      const snapshotFailed = snapshotResults.find((r) => r.error);
      if (snapshotFailed) throw snapshotFailed.error;
      const snapshotTitles = new Map(
        snapshotResults.flatMap((r) => r.data || []).map((c) => [`${c.visit_id}/${c.task_id}`, c.task_title])
      );
      if (seq !== loadSeq) return; // a newer load is on its way

      const events = (eventsRes.data || []).map((e) => ({
        kind: e.kind,
        at: Date.parse(e.created_at),
        mine: e.actor_id === me,
        actorName: nameOf(e.actor_id),
        taskTitle: e.task ? e.task.title : null,
      }));
      const endedTimes = events.filter((e) => e.kind === "ended").map((e) => e.at);
      const firstEnded = endedTimes.length ? Math.min.apply(null, endedTimes) : null;
      const reopened = events.some((e) => e.kind === "reopened");
      const visitMessages = (visitMsgsRes.data || []).map(toMessage);
      const proofs = visitMessages.filter((m) => m.kind === "task_proof");

      const checks = {};
      (checksRes.data || []).forEach((c) => {
        const at = Date.parse(c.checked_at);
        // complete_task() writes the check and its proof in one transaction, so both carry the
        // same now(). A check with no such proof is a parent's no-photo check-off.
        const proof = proofs.filter((p) => p.taskId === c.task_id && p.createdAt === at).pop() || null;
        checks[c.task_id] = {
          taskId: c.task_id,
          checkedAt: at,
          checkedByName: nameOf(c.checked_by),
          afterReopen: reopened && firstEnded !== null && at > firstEnded,
          snapshot: {
            title: c.task_title,
            time: formatTaskTime(c.task_time_of_day),
            detail: c.task_detail || null,
            location: c.task_location || null,
            careNote: c.task_care_note || null,
          },
          proof,
        };
      });

      const ended = Boolean(visit && visit.ended_at);
      const tooOld = Boolean(visit && visit.visit_date < utcDay(-1));
      const inWindow = Boolean(visit && !tooOld && visit.visit_date <= utcDay(1));
      state = {
        loaded: true,
        loadError: null,
        visit: visit
          ? {
              id: visit.id,
              date: visit.visit_date,
              startedAt: Date.parse(visit.started_at),
              startedByName: nameOf(visit.started_by),
              endedAt: visit.ended_at ? Date.parse(visit.ended_at) : null,
              endedByName: visit.ended_at ? nameOf(visit.ended_by) : null,
              momentAt: Date.parse(visit.moment_at),
            }
          : null,
        active: inWindow && !ended,
        ended,
        tooOld,
        canReopen: ended && inWindow,
        canStart: Boolean(planId) && (!visit || (visit.visit_date !== utcDay(0) && (ended || tooOld))),
        noPlan: !planId,
        events,
        checks,
        moment: visitMessages.find((m) => m.kind === "moment") || null,
        thread: (threadRes.data || []).slice().reverse().map(toMessage),
        feed: buildFeed(visitMessages, checks, reopened, firstEnded),
        reads: new Set((readsRes.data || []).map((r) => r.message_id)),
        saves: Object.fromEntries((savesRes.data || []).map((r) => [r.message_id, Date.parse(r.saved_at)])),
        album: (savesRes.data || [])
          .filter((r) => r.message && r.message.photo_path)
          .map((r) => Object.assign(toMessage(r.message), { title: r.message.kind === "moment" ? "Moment" : (r.message.task && r.message.task.title) || "Task" })),
        flags: Object.fromEntries((flagsRes.data || []).map((r) => [r.message_id, r.text])),
        gallery: galleryRows.map((r) => {
          const m = toMessage(r);
          const title = m.kind === "task_proof" ? snapshotTitles.get(`${r.visit_id}/${r.task_id}`) || m.taskTitle : null;
          return galleryItem(m, title, r.visit ? r.visit.visit_date : null);
        }),
      };
      notify();
    }

    function scheduleReload() {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        load().catch((err) => console.warn("CareNest: refresh failed", err));
      }, 250);
    }

    // RLS limits every stream to this household, so the table-wide subscriptions are safe.
    function subscribeRealtime() {
      const visitsFilter = data.planId ? { filter: `plan_id=eq.${data.planId}` } : {};
      client
        .channel(`carenest-shift-${householdId}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "messages", filter: `household_id=eq.${householdId}` },
          scheduleReload
        )
        .on("postgres_changes", Object.assign({ event: "*", schema: "public", table: "visits" }, visitsFilter), scheduleReload)
        .on("postgres_changes", { event: "*", schema: "public", table: "task_checks" }, scheduleReload)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "shift_events" }, scheduleReload)
        .subscribe();
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") scheduleReload();
      });
      window.addEventListener("online", scheduleReload);
    }

    function requireActive() {
      if (!state.visit) throw friendly("Start your shift first.");
      if (state.tooOld) throw friendly(ERRORS.visit_too_old);
      if (!state.active) throw friendly(ERRORS.visit_ended);
    }

    // Uploads a JPEG into this shift's folder; returns its path. Never overwrites (upsert off).
    async function uploadPhoto(blob) {
      const path = `${householdId}/${state.visit.id}/${crypto.randomUUID()}.jpg`;
      const { error } = await client.storage
        .from("photos")
        .upload(path, blob, { contentType: "image/jpeg", upsert: false });
      if (error) throw error;
      // Show our own photo straight away without downloading it again.
      photoCache.set(path, Promise.resolve(URL.createObjectURL(blob)));
      return path;
    }

    // A failed message or check leaves our upload unreferenced; remove it (best effort; the
    // delete policy allows the uploader to remove anything no message uses).
    async function discardUpload(path) {
      try {
        await client.storage.from("photos").remove([path]);
      } catch (e) {
        /* a cleanup job (#7) catches what this misses */
      }
      photoCache.delete(path);
    }

    const backend = {
      demo: false,
      role: ctx.role,
      MOMENT_WINDOW_MS,
      errorMessage,
      get state() {
        return state;
      },
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      async init() {
        subscribeRealtime();
        try {
          await load();
        } catch (err) {
          state = Object.assign(emptyState(), { loadError: errorMessage(err) });
          notify();
        }
      },
      async refresh() {
        try {
          await load();
        } catch (err) {
          state = Object.assign({}, state, { loadError: errorMessage(err) });
          notify();
          throw err;
        }
      },
      getMomentStatus(now = Date.now()) {
        return momentStatus(state, now);
      },

      async startShift() {
        if (!data.planId) throw friendly("Your family hasn't set up a schedule yet.");
        const { error } = await client.from("visits").insert({ plan_id: data.planId });
        if (error) throw error;
        await load();
      },
      async endShift() {
        if (!state.visit) return;
        const { error } = await client.rpc("end_visit", { target_visit_id: state.visit.id });
        if (error) throw error;
        await load();
      },
      async reopenShift() {
        if (!state.visit) return;
        const { error } = await client.rpc("reopen_visit", { target_visit_id: state.visit.id });
        if (error) throw error;
        await load();
      },
      async completeTask({ taskId, file, note, tag }) {
        requireActive();
        const blob = await store.downscaleImageBlob(file);
        const path = await uploadPhoto(blob);
        const { error } = await client.rpc("complete_task", {
          target_visit_id: state.visit.id,
          target_task_id: taskId,
          proof_photo_path: path,
          proof_note: note || "",
          proof_tag: tag || null,
        });
        if (error) {
          await discardUpload(path);
          throw error;
        }
        await load();
      },
      async uncheckTask(taskId) {
        requireActive();
        const { data: rows, error } = await client
          .from("task_checks")
          .delete()
          .eq("visit_id", state.visit.id)
          .eq("task_id", taskId)
          .select("task_id");
        if (error) throw error;
        if (!rows || !rows.length) throw friendly("This task couldn't be unchecked. Reload the page.");
        await load();
      },
      async sendChat(body, replyTo) {
        const text = String(body || "").trim();
        if (!text) return null;
        // No sender, role, or time: the database stamps them.
        const row = { household_id: householdId, kind: "chat", body: text };
        if (replyTo) row.reply_to = replyTo;
        const { error } = await client.from("messages").insert(row);
        if (error) throw error;
        await load();
        return true;
      },
      async postMoment({ dataUrl, body }) {
        requireActive();
        const path = await uploadPhoto(dataUrlToBlob(dataUrl));
        const { data: row, error } = await client
          .from("messages")
          .insert({
            household_id: householdId,
            visit_id: state.visit.id,
            kind: "moment",
            body: String(body || "").trim(),
            photo_path: path,
          })
          .select("id, late")
          .single();
        if (error) {
          await discardUpload(path);
          throw error;
        }
        await load();
        return { late: Boolean(row && row.late) };
      },
      // A photo message (gallery "+"): a chat row with a photo in this shift's folder. The
      // database allows it only for the sitter, in an open in-window shift; the caption may be empty.
      async postPhoto({ file, body }) {
        requireActive();
        const blob = await store.downscaleImageBlob(file);
        const path = await uploadPhoto(blob);
        const { error } = await client.from("messages").insert({
          household_id: householdId,
          visit_id: state.visit.id,
          kind: "chat",
          body: String(body || "").trim(),
          photo_path: path,
        });
        if (error) {
          await discardUpload(path);
          throw error;
        }
        await load();
      },
      // Parents only (the database refuses sitters): moves the prompt to 1-5 minutes from now.
      async triggerMomentNow() {
        if (!state.visit) throw friendly("No shift is open.");
        const { error } = await client.rpc("trigger_moment_now", { target_visit_id: state.visit.id });
        if (error) throw error;
        await load();
      },
      // Private bucket: download with the session and show an object URL (see the PR's
      // Decisions). Cached per path for the life of the page.
      photoUrl(path) {
        if (!path) return Promise.resolve(null);
        if (!photoCache.has(path)) {
          const pending = backend.photoBlob(path).then((blob) => URL.createObjectURL(blob));
          pending.catch(() => photoCache.delete(path));
          photoCache.set(path, pending);
        }
        return photoCache.get(path);
      },
      photoBlob(path) {
        if (!path) return Promise.reject(friendly("This photo was removed."));
        if (!blobCache.has(path)) {
          const pending = client.storage
            .from("photos")
            .download(path)
            .then(({ data: blob, error }) => {
              if (error) throw error;
              blobReady.set(path, blob);
              return blob;
            });
          pending.catch(() => blobCache.delete(path));
          blobCache.set(path, pending);
        }
        return blobCache.get(path);
      },
      // The already-downloaded photo, or null. iOS opens the share sheet only when
      // navigator.share() runs inside the tap, so saving must not await a download.
      photoBlobNow(path) {
        return blobReady.get(path) || null;
      },

      // ---------- parent side ----------

      // "New" until seen: one read mark per person and message (message_reads).
      async markSeen(ids) {
        const fresh = ids.filter((id) => !state.reads.has(id));
        if (!fresh.length) return;
        fresh.forEach((id) => state.reads.add(id));
        notify();
        // Multi-row insert: defaultToNull false so user_id takes its auth.uid() default.
        const { error } = await client
          .from("message_reads")
          .upsert(
            fresh.map((id) => ({ message_id: id })),
            { onConflict: "message_id,user_id", ignoreDuplicates: true, defaultToNull: false }
          );
        if (error) {
          fresh.forEach((id) => state.reads.delete(id));
          throw error;
        }
      },
      async savePhoto(messageId) {
        const { error } = await client.from("photo_saves").insert({ message_id: messageId });
        if (error && error.code !== "23505") throw error;
        await load();
      },
      async unsavePhoto(messageId) {
        const { error } = await client
          .from("photo_saves")
          .delete()
          .eq("message_id", messageId)
          .eq("user_id", me);
        if (error) throw error;
        await load();
      },
      // CONCEPT ONLY: the text is typed here, nothing looks at the photo.
      async setConceptFlag(messageId, text) {
        const { error } = await client.from("concept_flags").insert({ message_id: messageId, text });
        if (error && error.code !== "23505") throw error;
        await load();
      },
      async clearConceptFlags() {
        const ids = Object.keys(state.flags);
        if (!ids.length) return;
        const { error } = await client.from("concept_flags").delete().in("message_id", ids);
        if (error) throw error;
        await load();
      },
      // A parent removes any family photo: the database clears the message's photo first
      // (remove_photo returns the old path), then the bytes go through the Storage API.
      async removePhoto(messageId) {
        const { data: path, error } = await client.rpc("remove_photo", { target_message_id: messageId });
        if (error) throw error;
        if (path) {
          const { error: removeError } = await client.storage.from("photos").remove([path]);
          if (removeError) console.warn("CareNest: photo bytes not removed yet", removeError);
          photoCache.delete(path);
          blobCache.delete(path);
          blobReady.delete(path);
        }
        await load();
      },
      // A parent checks a task off with no photo ("Done by Mary").
      async checkTask(taskId) {
        requireActive();
        const { error } = await client.rpc("complete_task", {
          target_visit_id: state.visit.id,
          target_task_id: taskId,
          proof_photo_path: null,
          proof_note: "",
          proof_tag: null,
        });
        if (error) throw error;
        await load();
      },
    };
    return backend;
  }

  // ---------------------------------------------------------------- Demo (?demo=1)

  function createDemoBackend(data, role) {
    const listeners = new Set();
    let state = emptyState();

    function parentName() {
      if (data.parentName) return data.parentName;
      const c = data.contacts && data.contacts[0];
      return (c && c.name) || "Parent";
    }

    function build() {
      const shift = store.getShift();
      const completions = store.getCompletions();
      const sitter = data.babysitter.name;
      const events = (shift.events || []).map((e) => ({
        kind: e.kind,
        at: e.at,
        actorName: e.by === "parent" ? parentName() : sitter,
        taskTitle: e.taskTitle || null,
      }));
      const endedTimes = events.filter((e) => e.kind === "ended").map((e) => e.at);
      const firstEnded = endedTimes.length ? Math.min.apply(null, endedTimes) : null;
      const reopened = events.some((e) => e.kind === "reopened");

      const thread = store.getMessages().map((m) => {
        const senderRole = m.sender === "parent" ? "parent" : "caretaker";
        const completion = m.kind === "task_proof" ? completions[m.taskId] : null;
        const task = data.schedule.find((s) => s.id === m.taskId);
        const photo = m.kind === "task_proof" ? completion && completion.photoDataUrl : m.photo;
        return {
          id: m.id,
          kind: m.kind,
          body: m.kind === "task_proof" ? (completion && completion.note) || "" : m.body || "",
          visitId: m.shiftId || (m.kind === "task_proof" ? shift.id : null),
          taskId: m.taskId || null,
          taskTitle: task ? task.title : null,
          taskTime: task ? task.time : "",
          tag: (completion && completion.tag) || null,
          replyTo: m.replyTo || null,
          senderRole,
          senderName: senderRole === "parent" ? parentName() : sitter,
          mine: senderRole === role,
          createdAt: m.sentAt,
          late: Boolean(m.late),
          photoPath: store.isPhotoDataUrl(photo) ? photo : null,
          photoRemoved: false,
          photoRemovedByName: null,
        };
      });

      const checks = {};
      Object.keys(completions).forEach((taskId) => {
        const c = completions[taskId];
        const task = data.schedule.find((s) => s.id === taskId) || {};
        const proof = thread.filter((m) => m.kind === "task_proof" && m.taskId === taskId).pop() || null;
        checks[taskId] = {
          taskId,
          checkedAt: c.sentAt,
          checkedByName: sitter,
          afterReopen: reopened && firstEnded !== null && c.sentAt > firstEnded,
          snapshot: {
            title: task.title || "Task",
            time: task.time || "",
            detail: task.detail || null,
            location: task.location || null,
            careNote: task.careNote || null,
          },
          proof,
        };
      });

      const ended = Boolean(shift.endedAt);
      state = {
        loaded: true,
        loadError: null,
        visit: {
          id: shift.id,
          date: utcDay(0),
          startedAt: shift.startedAt,
          startedByName: sitter,
          endedAt: shift.endedAt,
          endedByName: ended ? sitter : null,
          momentAt: shift.momentAt,
        },
        active: !ended,
        ended,
        tooOld: false,
        canReopen: ended,
        canStart: false,
        noPlan: false,
        events,
        checks,
        moment: thread.find((m) => m.kind === "moment" && m.visitId === shift.id) || null,
        thread,
        feed: buildFeed(
          thread.filter((m) => m.visitId === shift.id && m.photoPath),
          checks,
          reopened,
          firstEnded
        ),
        reads: new Set(Object.keys(store.getReads())),
        saves: Object.fromEntries(Object.entries(store.getSaves()).map(([id, s]) => [id, s.savedAt || 0])),
        album: thread
          .filter((m) => m.photoPath && store.getSaves()[m.id])
          .map((m) => Object.assign({}, m, { title: m.kind === "moment" ? "Moment" : m.taskTitle || "Task" }))
          .reverse(),
        flags: Object.fromEntries(Object.entries(store.getInsights()).map(([id, i]) => [id, i.text])),
        // The demo keeps no shift dates, so a photo's shift date is its local send date.
        gallery: thread
          .filter((m) => m.photoPath)
          .map((m) => galleryItem(m, m.kind === "task_proof" ? m.taskTitle : null, localDay(m.createdAt))),
      };
    }

    function localDay(ms) {
      const d = new Date(ms);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    function rebuild() {
      build();
      listeners.forEach((fn) => fn(state));
    }

    store.subscribe(rebuild);

    return {
      demo: true,
      role,
      MOMENT_WINDOW_MS,
      errorMessage,
      get state() {
        return state;
      },
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      async init() {
        build();
      },
      async refresh() {
        rebuild();
      },
      getMomentStatus(now = Date.now()) {
        return momentStatus(state, now);
      },
      async startShift() {
        store.resetShift();
      },
      async endShift() {
        store.endShift();
      },
      async reopenShift() {
        store.reopenShift();
      },
      async completeTask({ taskId, file, note, tag }) {
        const photoDataUrl = await store.downscaleImage(file);
        store.completeTask({ taskId, photoDataUrl, note, tag });
      },
      async uncheckTask(taskId) {
        const task = data.schedule.find((s) => s.id === taskId);
        store.uncheckTask(taskId, task ? task.title : null);
      },
      async sendChat(body, replyTo) {
        return store.sendChat(body, role === "parent" ? "parent" : "sitter", replyTo || null);
      },
      async postMoment({ dataUrl, body }) {
        const message = store.postMoment({ photoDataUrl: dataUrl, body });
        return { late: Boolean(message.late) };
      },
      async postPhoto({ file, body }) {
        const photoDataUrl = await store.downscaleImage(file);
        store.postPhoto({ photoDataUrl, body });
      },
      async triggerMomentNow() {
        if (!store.isShiftActive()) store.resetShift();
        store.triggerMomentNow();
      },
      photoUrl(path) {
        return Promise.resolve(store.isPhotoDataUrl(path) ? path : null);
      },
      photoBlob(path) {
        return store.isPhotoDataUrl(path)
          ? Promise.resolve(dataUrlToBlob(path))
          : Promise.reject(friendly("This photo was removed."));
      },
      photoBlobNow(path) {
        return store.isPhotoDataUrl(path) ? dataUrlToBlob(path) : null;
      },
      async markSeen(ids) {
        store.markSeen(ids);
      },
      async savePhoto(messageId) {
        store.savePhoto(messageId);
      },
      async unsavePhoto(messageId) {
        store.unsavePhoto(messageId);
      },
      async setConceptFlag(messageId, text) {
        store.setConceptAlert(messageId, text);
      },
      async clearConceptFlags() {
        store.clearConceptAlerts();
      },
      async removePhoto() {
        throw friendly("Removing photos needs a signed-in parent (not available in the demo).");
      },
      async checkTask() {
        throw friendly("Checking off without a photo needs a signed-in parent (not available in the demo).");
      },
    };
  }

  // ---------------------------------------------------------------- pick one

  const readySource = window.CareNestFamily || window.CareNestAuth;
  const ready = (readySource ? readySource.ready : Promise.resolve(null)).then(async (ctx) => {
    const data = window.CareNestData;
    let backend;
    if (ctx && !ctx.demo && ctx.household && ctx.client && !demoMode()) {
      backend = createSupabaseBackend(ctx, data);
    } else {
      const asParent =
        page === "parent" ||
        ((page === "messages" || page === "gallery") && new URLSearchParams(window.location.search).get("as") === "parent");
      backend = createDemoBackend(data, asParent ? "parent" : "caretaker");
    }
    await backend.init();
    return backend;
  });

  window.CareNestShift = { ready, errorMessage };
})();
