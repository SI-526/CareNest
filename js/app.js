(function () {
  const data = window.CareNestData;
  const store = window.CareNestStore;
  const careLog = window.CareNestCareLog; // js/care-log.js (sitter home only uses it)
  if (!data) return;

  const page = document.body.dataset.page;
  let pendingCompleteItem = null;
  let pendingPhotoFile = null;
  let photoObjectUrl = null;
  let cameraStream = null;
  let returnFocusEl = null;
  // The shift backend (js/shift-data.js): Supabase when signed in, the sessionStorage store in demo.
  let shift = null;

  const SHIFT_LOCKED_TEXT = "This shift has ended. Photos can't be added after a shift.";
  // Demo tools (moment trigger, "Start a new shift", concept alerts) show on localhost only. The
  // demo on the deployed site is for user testing, where they would confuse testers.
  demoFlag(); // remembers ?demo=1 for this tab
  const isDevHost = ["localhost", "127.0.0.1", "[::1]", ""].includes(window.location.hostname);
  // Keep the parent-side navigation selection when the shared demo switches pages.
  const role =
    page === "parent" || new URLSearchParams(window.location.search).get("as") === "parent"
      ? "parent"
      : "sitter";
  if (role === "parent") document.body.dataset.role = "parent";

  // ?demo=1 turns on demo mode for this browser tab.
  function demoFlag() {
    try {
      if (new URLSearchParams(window.location.search).has("demo")) {
        sessionStorage.setItem("carenest:demo", "1");
      }
      return sessionStorage.getItem("carenest:demo") === "1";
    } catch (e) {
      return false;
    }
  }

  // Render only after the auth guard (js/auth.js) has checked the session and role and filled in
  // real names. Without the guard (no js/auth.js on the page) render straight away.
  // js/family-data.js (when the page loads it) resolves after the family's data has replaced the
  // sample data, so it is the one to wait on.
  const readySource = window.CareNestFamily || window.CareNestAuth;
  const authReady = readySource ? readySource.ready : Promise.resolve();
  authReady.then((ctx) => {
    if ((page === "home" || page === "parent") && window.CareNestShift) {
      window.CareNestShift.ready.then((backend) => {
        shift = backend;
        if (page === "home") {
          initHome();
          initDayNotes(ctx);
        } else {
          initDayNotes(ctx);
        }
      });
    } else if (page === "schedule" && window.CareNestShift && !(ctx && ctx.role === "parent")) {
      // SI-71: the sitter's Schedule page shows the same checklist as Home (js/secondary.js
      // places the panel). Parents check tasks off on their Today page instead.
      window.CareNestShift.ready.then((backend) => {
        if (!backend) return;
        shift = backend;
        initScheduleChecklist();
      });
    } else if (page === "food") {
      renderFood();
      onFamilyChange(renderFood);
    } else if (page === "info") {
      renderInfo();
      onFamilyChange(renderInfo);
    }
  });

  // Issue #11: re-render when a parent's edits arrive (js/family-data.js; never in demo mode).
  // Only renderers go here: the init* wiring adds listeners and must run once.
  function onFamilyChange(fn) {
    const family = window.CareNestFamily;
    if (family && family.subscribe) family.subscribe(fn);
  }

  function initHome() {
    renderSitterNav("home");
    initNavigation();
    if (window.CareNestTaskModals) window.CareNestTaskModals.ensure();
    renderHomeFamily();
    renderShiftControls();
    renderKnowTiles(document.getElementById("know-grid"));
    initModal();
    initCompleteModal();
    initCareLog();
    initEndShiftDialog();
    initShiftButtons();
    renderDevTools();
    initNextActivityClock();

    shift.subscribe(() => {
      renderShiftControls();
      renderSchedule(document.getElementById("schedule-list"));
      renderNextActivity();
      applyShiftLockToCompleteModal();
    });
    onFamilyChange(renderHomeFamily);
  }

  // SI-71: the Schedule page's copy of the checklist. Same tasks, checks, and check-off flow as
  // Home (the shift backend), so checking a task on one page shows on the other.
  function initScheduleChecklist() {
    const panel = document.getElementById("checklist");
    if (!panel) return;
    if (window.CareNestTaskModals) window.CareNestTaskModals.ensure();
    panel.hidden = false;
    initModal();
    initCompleteModal();
    const render = () => {
      renderSchedule(document.getElementById("schedule-list"));
      applyShiftLockToCompleteModal();
    };
    render();
    shift.subscribe(render);
    onFamilyChange(render);
  }

  // Everything on the home page drawn from the family's data (sitter, child, schedule, contacts).
  function renderHomeFamily() {
    const profileHeading = document.getElementById("profile-heading");
    if (profileHeading) profileHeading.textContent = `Welcome ${data.babysitter.name}`;
    // The profile card's static markup is the sample sitter; replace it with real data.
    const profileAvatar = document.querySelector(".profile-avatar");
    if (profileAvatar) {
      // Initials, never a photo: people and children are shown by initials across the app.
      profileAvatar.outerHTML = avatarHtml(null, data.babysitter.name, "profile-avatar", 40);
    }
    const profileAddress = document.querySelector(".profile-address");
    if (profileAddress) {
      profileAddress.textContent = data.babysitter.address || "";
      profileAddress.hidden = !data.babysitter.address;
    }
    renderShift();
    renderSchedule(document.getElementById("schedule-list"));
    renderNextActivity();
    renderEmergencyEntry(document.getElementById("emergency-entry"));
    renderContacts(document.getElementById("contacts-list"));
  }

  // ---------- care log details (SI-28, SI-34) ----------
  // Home no longer previews the care log (SI-67); the "Add details" dialog still opens after a
  // task is checked off and from a completed task's details.

  function initCareLog() {
    if (!careLog || !document.getElementById("log-modal")) return;
    careLog.initModal({
      shift,
      ageLabel: () => data.child.age,
      // Display only: the form's child strip, allergy notice, and today's session window.
      children: () => data.children || [],
      shiftWindow: () => careLog.shiftWindowText(data.appointments) || data.child.shiftTime || "",
      announce,
    });
  }

  // ---------- What's next (SI-70): the one upcoming activity ----------

  function renderNextActivity() {
    const el = document.getElementById("next-activity");
    if (!el || !shift) return;
    const picker = window.CareNestNext;
    const item = picker ? picker.nextActivity(scheduleRows(), new Date()) : null;
    // Redraw only when the pick changes: the card is a live region and the clock ticks each minute.
    const key = item ? JSON.stringify([item.id, item.time, item.title, item.location, item.detail]) : "none";
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    if (!item) {
      el.innerHTML = `<div class="empty-state next-activity-empty"><p>No more activities scheduled for today.</p></div>`;
      return;
    }
    const where = item.location || item.detail || "";
    el.innerHTML = `
      <button type="button" class="next-activity-item" data-next-id="${escapeHtml(item.id)}" aria-label="View details for ${escapeHtml(item.title)} at ${escapeHtml(item.time)}">
        <span class="next-activity-time">${escapeHtml(item.time)}</span>
        <span class="next-activity-body">
          <span class="next-activity-title">${escapeHtml(item.title)}</span>
          ${where ? `<span class="next-activity-detail">${escapeHtml(where)}</span>` : ""}
        </span>
        <span class="next-activity-chevron" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" focusable="false"><path fill="currentColor" d="M9.4 18 8 16.6l4.6-4.6L8 7.4 9.4 6l6 6-6 6Z" /></svg></span>
      </button>`;
    el.querySelector("[data-next-id]").addEventListener("click", (e) => openModal(item, e.currentTarget));
  }

  // Re-pick at each new minute, so a passed activity gives way to the next one without a reload,
  // and on return to the tab (timers are throttled in the background).
  function initNextActivityClock() {
    const untilNextMinute = () => 60000 - (Date.now() % 60000) + 50;
    const tick = () => {
      renderNextActivity();
      setTimeout(tick, untilNextMinute());
    };
    setTimeout(tick, untilNextMinute());
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) renderNextActivity();
    });
  }

  // What the log modal shows about the task: the check's snapshot, as on the schedule.
  function careLogTask(taskId) {
    const check = shift.state.checks[taskId];
    const task = data.schedule.find((t) => t.id === taskId) || {};
    return {
      taskId,
      title: check ? check.snapshot.title : task.title || "Task",
      time: check ? check.snapshot.time : task.time || "",
    };
  }

  // The activity modal of a completed task lists its details and offers to add one.
  function renderModalLogs(overlay, item) {
    const wrap = overlay.querySelector("[data-modal-logs]");
    if (!wrap) return;
    const logs = careLog && item.completed ? careLog.logsFor(shift.state, item.id) : [];
    const canAdd = Boolean(careLog && item.completed && shift.state.canLog);
    wrap.hidden = !logs.length && !canAdd;
    const list = wrap.querySelector("[data-modal-logs-list]");
    list.innerHTML = wrap.hidden
      ? ""
      : careLog.entriesHtml(logs) + (canAdd ? careLog.addButtonHtml(item.id, item.title, logs.length > 0) : "");
    const btn = list.querySelector("[data-log-task]");
    if (btn) {
      btn.addEventListener("click", () => {
        const back = returnFocusEl;
        returnFocusEl = null;
        closeModal(false);
        careLog.openModal(careLogTask(item.id), back);
      });
    }
  }

  // ---------- Important today (day notes) ----------
  // Parent-written notes for the session's date: the LOCAL calendar date the open shift started
  // on, or today's local date when no shift is open (never the UTC date: an evening shift in the
  // US would lose its notes at UTC midnight). When the open shift started on an earlier local date
  // (an overnight shift past midnight, or a shift nobody ended), the notes for today AND the
  // shift's start date are shown, under "Today" and that date, today first. Signed in, they come from public.day_notes and
  // refresh live; in demo mode they are the sample notes in js/data.js. A load failure only
  // affects this section.
  const DAY_NOTE_CATEGORIES = [
    { key: "routine", label: "Routine change" },
    { key: "instructions", label: "Special instruction" },
    { key: "schedule", label: "Schedule change" },
    { key: "food_meds", label: "Food or medication" },
    { key: "other", label: "Other" },
  ];

  function localDateKey(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function clockLabel(ms) {
    const d = new Date(ms);
    const h = d.getHours();
    const time = `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, "0")}${h >= 12 ? "pm" : "am"}`;
    if (localDateKey(ms) === localDateKey(Date.now())) return time;
    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
  }

  function sortDayNotes(notes) {
    const order = (n) => DAY_NOTE_CATEGORIES.findIndex((c) => c.key === n.category);
    return notes.slice().sort((a, b) => order(a) - order(b) || a.createdAt - b.createdAt);
  }

  // Figma 153:5 draws food/medication and schedule notes with filled Material glyphs (pill,
  // event_note); the other categories keep their outline glyphs in the same 32px Deep Teal tile.
  const DAY_NOTE_FILLED_ICONS = {
    food_meds: '<path d="M16.171 15.0922L18.9943 12.2537C19.4763 11.7717 19.8477 11.2181 20.1085 10.5928C20.3695 9.96725 20.5 9.31133 20.5 8.625C20.5 7.19767 20.0023 5.98667 19.007 4.992C18.0118 3.99733 16.8001 3.5 15.3717 3.5C14.6881 3.5 14.0334 3.6305 13.4077 3.8915C12.7821 4.15233 12.2283 4.52375 11.7462 5.00575L8.90775 7.829L16.171 15.0922ZM8.62825 20.5C9.31192 20.5 9.96658 20.3695 10.5923 20.1085C11.2179 19.8477 11.7717 19.4763 12.2537 18.9943L15.0922 16.171L7.829 8.90775L5.00575 11.7462C4.52375 12.2283 4.15233 12.7819 3.8915 13.4073C3.6305 14.0327 3.5 14.6887 3.5 15.375C3.5 16.8023 3.99767 18.0133 4.993 19.008C5.98817 20.0027 7.19992 20.5 8.62825 20.5Z" />',
    schedule: '<path d="M7 14V12H17V14H7ZM7 18V16H14V18H7ZM5 22C4.45 22 3.97917 21.8042 3.5875 21.4125C3.19583 21.0208 3 20.55 3 20V6C3 5.45 3.19583 4.97917 3.5875 4.5875C3.97917 4.19583 4.45 4 5 4H6V2H8V4H16V2H18V4H19C19.55 4 20.0208 4.19583 20.4125 4.5875C20.8042 4.97917 21 5.45 21 6V20C21 20.55 20.8042 21.0208 20.4125 21.4125C20.0208 21.8042 19.55 22 19 22H5ZM5 20H19V10H5V20Z" />',
  };

  function dayNoteIcon(category) {
    if (DAY_NOTE_FILLED_ICONS[category]) {
      return `<span class="day-note-icon day-note-icon--${escapeHtml(category)}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor">${DAY_NOTE_FILLED_ICONS[category]}</svg></span>`;
    }
    const paths = {
      food_meds: '<path d="M8.2 5.1 5.1 8.2a3.75 3.75 0 0 0 5.3 5.3l3.1-3.1-5.3-5.3Zm2.3-2.3a2 2 0 0 1 2.8 0l7.9 7.9a2 2 0 0 1 0 2.8l-2.1 2.1-10.7-10.7 2.1-2.1Z" /><path d="m5.2 14.8 4 4" />',
      routine: '<path d="M9 3h6M10 3v4l-4 7a5 5 0 0 0 4.4 7h3.2a5 5 0 0 0 4.4-7l-4-7V3" /><path d="M7.5 15h9M19 6l2-2M18 9l3 1" />',
      schedule: '<rect x="4" y="5" width="16" height="15" rx="1" /><path d="M8 3v4m8-4v4M7 10h10m-8 4h6m-6 3h4" />',
      instructions: '<path d="M8 3h8v18H8zM6 6H4v13a2 2 0 0 0 2 2h8" /><path d="M10 8h4m-4 4h4m-4 4h3" />',
      other: '<path d="M12 3a9 9 0 1 0 9 9" /><path d="M12 7v5l3 2" />',
    };
    return `<span class="day-note-icon day-note-icon--${escapeHtml(category)}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[category] || paths.other}</svg></span>`;
  }

  function dayNoteHtml(note, canEdit) {
    const category = DAY_NOTE_CATEGORIES.find((c) => c.key === note.category) || DAY_NOTE_CATEGORIES[4];
    const isUpdated = note.updatedAt > note.createdAt;
    const titleDot = isUpdated
      ? `<span class="day-note-dot" title="Updated ${escapeHtml(clockLabel(note.updatedAt))}"><span class="visually-hidden">Updated</span></span>`
      : "";
    const updatedLine = isUpdated
      ? `<p class="day-note-updated-time">Updated ${escapeHtml(clockLabel(note.updatedAt))}</p>`
      : "";
    const head = `${dayNoteIcon(category.key)}<span class="day-note-copy">
      <span class="day-note-category">${escapeHtml(category.label)}</span>
      <span class="day-note-title">${escapeHtml(note.title)}${titleDot}</span>
      ${note.detail ? `<span class="day-note-preview">${escapeHtml(note.detail.split("\n")[0])}</span>` : ""}
    </span>`;
    const actions = canEdit
      ? `<div class="day-note-actions">
          <button type="button" class="text-btn" data-edit-note="${escapeHtml(note.id)}">Edit</button>
          <button type="button" class="text-btn" data-delete-note="${escapeHtml(note.id)}">Delete</button>
        </div>`
      : "";
    if (!note.detail) {
      return `<li class="day-note">
        <div class="day-note-summary day-note-plain">${head}</div>
        ${updatedLine}${actions}
      </li>`;
    }
    return `<li class="day-note">
      <details class="day-note-details" data-note-id="${escapeHtml(note.id)}">
        <summary class="day-note-summary">${head}</summary>
        <p class="day-note-detail">${escapeHtml(note.detail)}</p>
        ${updatedLine}
      </details>
      ${actions}
    </li>`;
  }

  function initDayNotes(ctx) {
    const listEl = document.getElementById("day-notes-list");
    const statusEl = document.getElementById("day-notes-status");
    const dateEl = document.getElementById("day-notes-date");
    const countEl = document.getElementById("day-notes-count");
    if (!listEl || !statusEl) return;

    const live = Boolean(ctx && !ctx.demo && ctx.client && ctx.household && shift && !shift.demo);
    const canEdit = live && ctx.role === "parent";
    const addBtn = document.getElementById("day-notes-add");
    const writeErrorEl = document.getElementById("day-notes-write-error");
    const auth = window.CareNestAuth;
    let lastNotes = [];
    let shownIds = new Set();
    let shownDates = "";
    let reloadTimer = null;
    let midnightTimer = null;

    // The dates to show, today first: [today], or [today, start date] while a shift that started
    // on an earlier local date is still open.
    function sessionDates() {
      const today = localDateKey(Date.now());
      const st = shift.state;
      if (st && st.active && st.visit && st.visit.startedAt) {
        const start = localDateKey(st.visit.startedAt);
        return start < today ? [today, start] : [start];
      }
      return [today];
    }

    function dateLabel(date) {
      return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
    }

    // notes: each with `date` (YYYY-MM-DD). One date renders a flat list; two render a sub-heading
    // per date that has notes ("Today", then the shift's start date).
    function render(notes, dates) {
      lastNotes = notes;
      shownDates = dates.join(",");
      if (dateEl) dateEl.textContent = dateLabel(dates[0]);
      // Keep notes the sitter opened open across live refreshes.
      const open = new Set(
        Array.from(listEl.querySelectorAll("details[open]")).map((el) => el.dataset.noteId)
      );
      const groups = dates
        .map((date) => ({
          date,
          notes: sortDayNotes(dates.length === 1 ? notes : notes.filter((n) => n.date === date)),
        }))
        .filter((g) => g.notes.length);
      const count = groups.reduce((sum, g) => sum + g.notes.length, 0);
      if (countEl) {
        countEl.textContent = `${count} ${count === 1 ? "update" : "updates"}`;
        countEl.hidden = !count;
      }
      shownIds = new Set(groups.flatMap((g) => g.notes.map((n) => n.id)));
      listEl.innerHTML =
        dates.length === 1
          ? groups.map((g) => g.notes.map((n) => dayNoteHtml(n, canEdit)).join("")).join("")
          : groups
              .map(
                (g) => `<li class="day-notes-group">
      <h3 class="day-notes-group-title">${escapeHtml(g.date === dates[0] ? "Today" : dateLabel(g.date))}</h3>
      <ul class="day-notes-list">${g.notes.map((n) => dayNoteHtml(n, canEdit)).join("")}</ul>
    </li>`
              )
              .join("");
      listEl.querySelectorAll("details[data-note-id]").forEach((el) => {
        if (open.has(el.dataset.noteId)) el.open = true;
      });
      listEl.hidden = !count;
      statusEl.textContent = count ? "" : "No special updates for today.";
      statusEl.hidden = Boolean(count);
    }

    // Timers do not notice the date changing: re-check just after each local midnight. A
    // background tab may fire late; the visibilitychange reload below covers that.
    function armMidnight(onMidnight) {
      clearTimeout(midnightTimer);
      const next = new Date();
      next.setHours(24, 0, 5, 0);
      midnightTimer = setTimeout(() => {
        onMidnight();
        armMidnight(onMidnight);
      }, Math.max(1000, next.getTime() - Date.now()));
    }

    function showError() {
      shownIds = new Set();
      listEl.innerHTML = "";
      listEl.hidden = true;
      statusEl.textContent = "Couldn't load today's notes.";
      statusEl.hidden = false;
      if (countEl) countEl.hidden = true;
    }

    if (!live) {
      const renderDemo = () => render(data.dayNotes || [], [localDateKey(Date.now())]);
      renderDemo();
      armMidnight(renderDemo);
      return;
    }

    const client = ctx.client;
    const householdId = ctx.household.id;

    async function load() {
      const dates = sessionDates();
      try {
        const { data: rows, error } = await client
          .from("day_notes")
          .select("id, note_date, category, title, detail, created_at, updated_at")
          .eq("household_id", householdId)
          .in("note_date", dates)
          .order("created_at", { ascending: true });
        if (error) throw error;
        render(
          (rows || []).map((r) => ({
            id: r.id,
            date: r.note_date,
            category: r.category,
            title: r.title,
            detail: r.detail || "",
            createdAt: Date.parse(r.created_at),
            updatedAt: Date.parse(r.updated_at),
          })),
          dates
        );
      } catch (error) {
        console.warn("CareNest: day notes failed to load", error);
        showError();
      }
    }

    function scheduleReload() {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(load, 250);
    }

    load();
    // Filtered to the active family (RLS alone would pass every family the caller is in).
    // Realtime cannot filter DELETE events by column,
    // so deletes arrive unfiltered: reload only when a note on screen was deleted.
    client
      .channel(`carenest-day-notes-${householdId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "day_notes", filter: `household_id=eq.${householdId}` },
        scheduleReload
      )
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "day_notes" }, (payload) => {
        if (payload.old && shownIds.has(payload.old.id)) scheduleReload();
      })
      .subscribe();
    // A shift starting or ending, or the clock passing local midnight, can change the dates.
    shift.subscribe(() => {
      if (sessionDates().join(",") !== shownDates) scheduleReload();
    });
    armMidnight(scheduleReload);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") scheduleReload();
    });
    window.addEventListener("online", scheduleReload);

    if (!canEdit) return;

    if (addBtn) addBtn.hidden = false;

    function showWriteError(text) {
      if (!writeErrorEl) return;
      writeErrorEl.textContent = text || "";
      writeErrorEl.hidden = !text;
    }

    const dialog = document.getElementById("day-note-dialog");
    const form = document.getElementById("day-note-form");
    if (!dialog || !form) return;

    let editingNote = null;

    function showFormError(text) {
      const el = document.getElementById("day-note-error");
      if (!el) return;
      el.textContent = text || "";
      el.hidden = !text;
    }

    function openEditor(note) {
      editingNote = note;
      document.getElementById("day-note-dialog-title").textContent = note ? "Edit note" : "Add a note";
      form.elements.category.value = note ? note.category : "routine";
      form.elements.title.value = note ? note.title : "";
      form.elements.detail.value = note ? note.detail : "";
      showFormError("");
      dialog.showModal();
      form.elements.title.focus();
    }

    function closeEditor() {
      dialog.close();
    }

    if (addBtn) addBtn.addEventListener("click", () => openEditor(null));
    const cancel = document.getElementById("day-note-cancel");
    if (cancel) cancel.addEventListener("click", closeEditor);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const category = form.elements.category.value;
      const title = form.elements.title.value.trim();
      const detail = form.elements.detail.value.trim();
      if (!title) {
        showFormError("Please enter a title.");
        form.elements.title.focus();
        return;
      }
      const save = document.getElementById("day-note-save");
      save.disabled = true;
      showFormError("");
      const wasEdit = Boolean(editingNote);
      try {
        if (editingNote) {
          const result = await client
            .from("day_notes")
            .update({ category, title, detail })
            .eq("id", editingNote.id)
            .select("id");
          if (result.error) throw result.error;
          if (!result.data || !result.data.length) {
            throw Object.assign(
              new Error("This couldn't be saved. It may have been changed or removed. Reload the page and try again."),
              { friendly: true }
            );
          }
        } else {
          const { error } = await client.from("day_notes").insert({
            household_id: householdId,
            note_date: localDateKey(Date.now()),
            category,
            title,
            detail,
          });
          if (error) throw error;
        }
        closeEditor();
        announce(wasEdit ? "Note saved." : "Note added.");
        scheduleReload();
      } catch (error) {
        showFormError(error.friendly ? error.message : auth.friendlyError(error));
      } finally {
        save.disabled = false;
      }
    });

    listEl.addEventListener("click", async (event) => {
      const editBtn = event.target.closest("[data-edit-note]");
      const deleteBtn = event.target.closest("[data-delete-note]");
      if (editBtn) {
        const note = lastNotes.find((n) => n.id === editBtn.dataset.editNote);
        if (note) openEditor(note);
        return;
      }
      if (!deleteBtn) return;
      const note = lastNotes.find((n) => n.id === deleteBtn.dataset.deleteNote);
      if (!note) return;
      const ok = await auth.confirmDialog({
        title: `Delete ${note.title}?`,
        body: "Your sitter will no longer see this note. This cannot be undone.",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      const result = await client.from("day_notes").delete().eq("id", note.id).select("id");
      if (result.error || !result.data || !result.data.length) {
        showWriteError(
          result.error
            ? auth.friendlyError(result.error)
            : "This couldn't be deleted. Reload the page and try again."
        );
        return;
      }
      showWriteError("");
      announce("Note deleted.");
      scheduleReload();
    });
  }

  function initNavigation() {
    const links = Array.from(document.querySelectorAll(".primary-nav .nav-item"));
    if (!links.length) return;

    const updateCurrentPage = () => {
      const hash = window.location.hash || "#home";
      links.forEach((link) => {
        const target = new URL(link.href, window.location.href);
        const isHome = hash === "#home" && /index\.html$/.test(target.pathname) && !target.hash;
        if (isHome || target.hash === hash) {
          link.setAttribute("aria-current", "page");
        } else {
          link.removeAttribute("aria-current");
        }
      });
    };

    window.addEventListener("hashchange", updateCurrentPage);
    updateCurrentPage();
  }

  function renderFood() {
    const allergies = data.allergies;
    const list = document.getElementById("restriction-list");
    const careNoteEl = document.getElementById("care-note-body");

    const items = allergies.items || [];
    list.innerHTML = items.length
      ? items
          .map(
            (item) => `
      <article class="restriction-item">
        <span class="food-tile" aria-hidden="true"><img src="assets/grocery.svg" alt="" width="28" height="28" /></span>
        <div class="restriction-content">
          <div class="restriction-top">
            <h3 class="restriction-name">${escapeHtml(item.name)}${childChip(item)}</h3>
            ${item.severity ? `<span class="badge ${escapeHtml(item.severityClass || "")}">${item.severity === "Severe" ? '<img class="cn-icon" src="assets/icon-error.svg" alt="" width="20" height="20" />' : ""}${escapeHtml(item.severity)}</span>` : ""}
          </div>
          ${item.description ? `<p class="restriction-desc">${escapeHtml(item.description)}</p>` : ""}
        </div>
      </article>`
          )
          .join("")
      : emptyStateHtml("");

    if (allergies.careNote) careNoteEl.textContent = allergies.careNote;
    careNoteEl.closest(".care-note").hidden = !allergies.careNote;
  }

  function renderInfo() {
    const params = new URLSearchParams(window.location.search);
    const key = params.get("category") || "";
    const category = data.categories[key];
    const title = category ? category.title : "Care information";
    const titleEl = document.getElementById("info-title");
    if (titleEl) titleEl.textContent = title;
    document.title = `CareNest — ${title}`;

    const contentEl = document.getElementById("info-content");
    if (!contentEl) return;

    if (!category || !categoryHasContent(category)) {
      // The "Call 911" callout is static, so it shows even when the family hasn't filled in
      // emergency steps or contacts yet.
      contentEl.innerHTML =
        renderEmergencyCallout(category && category.callout) +
        `<section class="panel">${emptyStateHtml()}</section>`;
      return;
    }

    contentEl.innerHTML = [
      renderEmergencyCallout(category.callout),
      renderEmergencySteps(category.steps),
      renderHospital(category.hospital),
      renderEmergencyContacts(category.contacts),
      renderInfoItems(category.items),
    ].join("");
  }

  function categoryHasContent(category) {
    return Boolean(
      (category.items && category.items.length) ||
        (category.steps && category.steps.length) ||
        category.hospital ||
        (category.contacts && category.contacts.length)
    );
  }

  // Parents (signed in) also get a link to add the missing info; sitters see only the notice.
  function emptyStateHtml(cardClass = "card") {
    const nudge =
      data.viewerRole === "parent"
        ? ' <a class="empty-state-link" href="manage.html">Add it in Family info</a>'
        : "";
    return `<div class="${cardClass} empty-state"><p>No information provided.${nudge}</p></div>`;
  }

  // With several children, a per-child item on a family-wide page says whose it is (SI-45).
  function childChip(item) {
    return item.childName ? ` <span class="child-chip">${escapeHtml(item.childName.split(/\s+/)[0])}</span>` : "";
  }

  function renderInfoItems(items) {
    if (!items || !items.length) return "";
    return `
      <section class="panel">
        <div class="card">
        <ul class="info-list">
          ${items
            .map(
              (item) => `
            <li class="info-item">
              <h2 class="info-item-title">${escapeHtml(item.title)}${childChip(item)}</h2>
              ${item.detail ? `<p class="info-item-detail">${escapeHtml(item.detail)}</p>` : ""}
            </li>`
            )
            .join("")}
        </ul>
        </div>
      </section>`;
  }

  function renderEmergencyCallout(callout) {
    if (!callout) return "";
    return `
      <section class="emergency-callout" aria-label="Call 911">
        <p>${escapeHtml(callout.text)}</p>
        <a class="emergency-call-btn" href="${escapeHtml(callout.href)}">${escapeHtml(callout.label)}</a>
      </section>`;
  }

  function renderEmergencySteps(steps) {
    if (!steps || !steps.length) return "";
    return `
      <section class="panel" aria-labelledby="steps-heading">
        <h2 class="panel-title" id="steps-heading">What to do</h2>
        <div class="card">
          <ol class="emergency-steps">
            ${steps.map((step) => `<li>${stepHtml(step)}</li>`).join("")}
          </ol>
        </div>
      </section>`;
  }

  // Sample steps are strings; signed-in steps are care items ({ title, detail }).
  function stepHtml(step) {
    if (typeof step === "string") return escapeHtml(step);
    const title = `<strong>${escapeHtml(step.title)}</strong>`;
    return step.detail ? `${title} ${escapeHtml(step.detail)}` : title;
  }

  // A photo when there is one, otherwise the person's initials.
  function avatarHtml(src, name, className, size) {
    if (src) {
      return `<img class="${className}" src="${escapeHtml(src)}" alt="" width="${size}" height="${size}" />`;
    }
    return `<span class="${className} contact-initials" aria-hidden="true">${escapeHtml(initials(name || ""))}</span>`;
  }

  function callButtonHtml(contact) {
    if (!contact.phoneHref) return "";
    return `<a class="call-btn" href="${escapeHtml(contact.phoneHref)}" aria-label="Call ${escapeHtml(contact.name)}">
          <img src="assets/call.svg" alt="" width="23" height="22" />
        </a>`;
  }

  function renderHospital(hospital) {
    if (!hospital) return "";
    const callBtn = hospital.phoneHref
      ? `<a class="call-btn" href="${escapeHtml(hospital.phoneHref)}" aria-label="Call ${escapeHtml(hospital.name)}">
          <img src="assets/call.svg" alt="" width="23" height="22" />
        </a>`
      : "";
    const address = hospital.address
      ? `<p class="hospital-address">${escapeHtml(hospital.address)}</p>${mapLinkHtml(hospital.mapHref || mapsHref(hospital.address))}`
      : "";
    return `
      <section class="panel" aria-labelledby="hospital-heading">
        <h2 class="panel-title" id="hospital-heading">Hospital</h2>
        <div class="card hospital-card">
          <div class="hospital-meta">
            <p class="contact-name">${escapeHtml(hospital.name)}</p>
            ${hospital.system ? `<p class="hospital-system">${escapeHtml(hospital.system)}</p>` : ""}
            ${address ? `<div class="modal-location">
              <img src="assets/location.svg" alt="" width="16" height="16" />
              <div>${address}</div>
            </div>` : ""}
            ${hospital.phone ? `<p class="contact-phone">${escapeHtml(hospital.phone)}</p>` : ""}
          </div>
          ${callBtn}
        </div>
      </section>`;
  }

  // An ordinary link to the address in Google Maps: no embedded map or map image.
  function mapsHref(address) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  }

  function mapLinkHtml(href) {
    return `<a class="map-link" href="${escapeHtml(href)}" target="_blank" rel="noopener">Open in Maps<span class="visually-hidden"> (opens in a new tab)</span></a>`;
  }

  function renderEmergencyContacts(contacts) {
    if (!contacts || !contacts.length) return "";
    const resolved = contacts
      .map((c) => {
        if (!c.contactId) return c;
        const base = data.contacts.find((d) => d.id === c.contactId);
        return base ? Object.assign({}, base, c) : null;
      })
      .filter(Boolean);
    if (!resolved.length) return "";
    return `
      <section class="panel" aria-labelledby="who-heading">
        <h2 class="panel-title" id="who-heading">Who to contact</h2>
        <div class="card contacts-list">
          ${resolved
            .map((contact) => {
              const avatar = avatarHtml(null, contact.name, "contact-avatar", 35);
              return `
            <article class="contact-card">
              ${avatar}
              <div class="contact-meta">
                <p class="contact-name">${escapeHtml(contact.name)}</p>
                ${contact.role ? `<p class="contact-role">${escapeHtml(contact.role)}</p>` : ""}
                ${contact.phone ? `<p class="contact-phone">${escapeHtml(contact.phone)}</p>` : ""}
              </div>
              ${callButtonHtml(contact)}
            </article>`;
            })
            .join("")}
        </div>
      </section>`;
  }

  function initials(name) {
    return String(name)
      .replace(/^Dr\.\s*/, "")
      .split(/\s+/)
      .map((part) => part.charAt(0))
      .join("")
      .slice(0, 2)
      .toUpperCase();
  }

  function renderEmergencyEntry(el) {
    if (!el) return;
    const emergency = data.categories.emergency;
    if (!emergency) return;
    el.innerHTML = `
      <a class="emergency-card" href="info.html?category=emergency">
        <span class="emergency-card-icon" aria-hidden="true">
          <img src="assets/emergency.svg" alt="" width="22" height="22" />
        </span>
        <span class="emergency-card-meta">
          <span class="emergency-card-title">${escapeHtml(emergency.title)}</span>
          <span class="emergency-card-text">${escapeHtml(emergency.summary)}</span>
        </span>
        <span class="emergency-card-chevron" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" focusable="false"><path fill="currentColor" d="M9.4 18 8 16.6l4.6-4.6L8 7.4 9.4 6l6 6-6 6Z" /></svg></span>
      </a>`;
  }

  function renderShift() {
    const cardEl = document.getElementById("shift-card");
    if (!cardEl) return;

    const child = data.child;
    // Every child in the family (SI-45); a family with none still shows the shift's day and hours.
    const children = data.children && data.children.length ? data.children : [child];
    cardEl.innerHTML = `
      <div class="shift-timing">
        <p class="shift-date">${escapeHtml(child.dateLabel)}</p>
        ${child.shiftTime ? `<p class="shift-hours shift-tag">${escapeHtml(child.shiftTime)}</p>` : ""}
      </div>
      ${children
        .map(
          (kid) => `<div class="shift-child">
        ${avatarHtml(null, kid.name, "shift-avatar", 60)}
        <div class="shift-meta">
          <p class="shift-name">${escapeHtml((kid.name || "").trim() || "Child")}</p>
          ${kid.age ? `<p class="shift-age">${escapeHtml(kid.age)}</p>` : ""}
        </div>
      </div>`
        )
        .join("")}`;
  }

  // Today's schedule: the family's active tasks, with each checked task shown as it was when it
  // was checked (the check's snapshot), plus checked tasks that have since been archived.
  function scheduleRows() {
    const st = shift.state;
    const snapshotOf = (check) => ({
      title: check.snapshot.title,
      time: check.snapshot.time,
      detail: check.snapshot.detail,
      location: check.snapshot.location,
      careNote: check.snapshot.careNote,
    });
    const rows = data.schedule.map((task) => {
      const check = st.checks[task.id];
      return check
        ? Object.assign({}, task, snapshotOf(check), { completed: true, check })
        : Object.assign({}, task, { completed: false, check: null });
    });
    Object.keys(st.checks).forEach((taskId) => {
      if (data.schedule.some((t) => t.id === taskId)) return;
      const check = st.checks[taskId];
      rows.push(Object.assign({ id: taskId, map: null }, snapshotOf(check), { completed: true, check }));
    });
    return rows;
  }

  function proofPhotoPath(item) {
    return item.check && item.check.proof && item.check.proof.photoPath ? item.check.proof.photoPath : null;
  }

  // "Done by Mary" (a parent's no-photo check), "Photo removed by Mary", "Added after reopen".
  function checkMetaParts(check) {
    if (!check) return [];
    const parts = [];
    if (check.afterReopen) parts.push(`<span class="reopen-badge">Added after reopen</span>`);
    if (!check.proof) parts.push(`<span>Done by ${escapeHtml(check.checkedByName)}</span>`);
    else if (check.proof.photoRemoved) {
      parts.push(`<span>Photo removed by ${escapeHtml(check.proof.photoRemovedByName)}</span>`);
    }
    return parts;
  }

  // Fills <img data-photo-path> elements from the backend (object URLs or demo data URLs).
  function hydratePhotos(root) {
    if (!root || !shift) return;
    root.querySelectorAll("img[data-photo-path]").forEach((img) => {
      const path = img.dataset.photoPath;
      if (img.dataset.loadedPath === path) return;
      shift
        .photoUrl(path)
        .then((url) => {
          if (!url || img.dataset.photoPath !== path) return;
          img.src = url;
          img.dataset.loadedPath = path;
        })
        .catch(() => {
          img.alt = "Photo couldn't load";
          img.classList.add("photo-failed");
        });
    });
  }

  function renderSchedule(el) {
    if (!el) return;

    const st = shift.state;
    const shiftActive = st.active;
    const lockNote = document.getElementById("schedule-locked");
    if (lockNote) {
      const text = lockText(st);
      lockNote.textContent = text;
      lockNote.hidden = !text;
    }
    const items = scheduleRows();
    const countEl = document.getElementById("checklist-count");
    if (countEl) {
      countEl.textContent = `${items.filter((item) => item.completed).length} of ${items.length} done`;
      countEl.hidden = !items.length;
    }

    if (!items.length) {
      el.innerHTML = `<li><div class="empty-state checklist-empty"><p>No checklist items for today.</p></div></li>`;
      return;
    }

    el.innerHTML = items
      .map((item, index) => {
        const detailHtml = item.location
          ? `<div class="schedule-location">
              <img src="assets/location.svg" alt="" width="16" height="16" />
              <p>${escapeHtml(item.location)}</p>
            </div>`
          : `<p class="schedule-detail">${escapeHtml(item.detail || "")}</p>`;

        const path = proofPhotoPath(item);
        const photoThumb = path
          ? `<span class="photo-thumb">
                <img data-photo-path="${escapeHtml(path)}" alt="" width="36" height="36" />
              </span>`
          : "";

        const completedMark = item.completed
          ? `<span class="check-icon">
              <img src="assets/check.svg" alt="" width="24" height="24" />
            </span>`
          : "";

        const trailing =
          photoThumb || completedMark
            ? `<span class="schedule-trailing">${photoThumb}${completedMark}</span>`
            : "";

        const completeButton = item.completed
          ? ""
          : `<button type="button" class="check-btn" data-complete-id="${escapeHtml(item.id)}" aria-label="Mark ${escapeHtml(item.title)} as complete"${shiftActive ? "" : ` disabled aria-describedby="schedule-locked"`}>
              <img src="assets/check.svg" alt="" width="24" height="24" />
            </button>`;

        const divider =
          index < items.length - 1
            ? `<hr class="schedule-divider" />`
            : "";

        const meta = checkMetaParts(item.check);
        const metaHtml = meta.length ? `<p class="schedule-check-meta">${meta.join("")}</p>` : "";
        const completedLabel = item.completed
          ? `, completed${item.check && item.check.afterReopen ? ", added after reopen" : ""}`
          : "";

        return `
          <li class="schedule-row${item.completed ? " is-completed" : ""}">
            <div class="schedule-item-wrap">
              <button type="button" class="schedule-item" data-schedule-id="${escapeHtml(item.id)}" aria-label="View details for ${escapeHtml(item.title)}${completedLabel}">
                <span class="schedule-time">${escapeHtml(item.time)}</span>
                <div class="schedule-body">
                  <p class="schedule-title">${escapeHtml(item.title)}</p>
                  ${detailHtml}
                  ${metaHtml}
                </div>
                ${trailing}
              </button>
              ${completeButton}
            </div>
            ${divider}
          </li>`;
      })
      .join("");

    hydratePhotos(el);

    el.querySelectorAll("[data-schedule-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = items.find((s) => s.id === btn.dataset.scheduleId);
        if (item) openModal(item, btn);
      });
    });

    el.querySelectorAll("[data-complete-id]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const item = items.find((s) => s.id === btn.dataset.completeId);
        if (!item || item.completed || !shift.state.active) return;
        openCompleteModal(item, btn);
      });
    });
  }

  // Why the schedule can't be checked off right now, or "" when it can.
  function lockText(st) {
    if (st.loadError || st.noPlan || st.active) return "";
    if (!st.visit) {
      return page === "schedule"
        ? "Start your shift on Home to check off tasks."
        : "Start your shift to check off tasks.";
    }
    if (st.tooOld) {
      return `This shift was on ${dayLabel(st.visit.date)} and is read-only now. Shifts before yesterday can't be changed.`;
    }
    if (st.ended) {
      return st.canReopen
        ? `This shift has ended. Photos can't be added after a shift. If it ended by mistake, reopen it above and ${parentFirstName()} will be told.`
        : "This shift has ended. Photos can't be added after a shift.";
    }
    return "";
  }

  function dayLabel(isoDate) {
    const [y, m, d] = String(isoDate).split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }

  // SI-72: Home shows only the family's primary contact; every contact is on each child's page.
  function renderContacts(el) {
    if (!el) return;
    const allLink = document.querySelector("#contacts .panel-link");
    const firstChild = (data.children || []).find((child) => child && child.id);
    if (allLink) {
      allLink.href = firstChild ? `children.html?child=${encodeURIComponent(firstChild.id)}` : "children.html";
      allLink.hidden = !data.contacts.length;
    }
    // contacts.is_primary signed in (js/family-data.js), primaryContactId in demo (js/data.js).
    const primary = data.primaryContact || null;
    if (!primary) {
      el.innerHTML = `<div class="card empty-state contacts-empty"><p>No primary contact yet.</p></div>`;
      return;
    }
    el.innerHTML = [primary]
      .map(
        (contact) => `
      <article class="contact-card">
        ${avatarHtml(null, contact.name, "contact-avatar", 35)}
        <div class="contact-meta">
          <p class="contact-name">${escapeHtml(contact.name)}</p>
          ${contact.role ? `<p class="contact-role">${escapeHtml(contact.role)}</p>` : ""}
          ${contact.phone ? `<p class="contact-phone">${escapeHtml(contact.phone)}</p>` : ""}
        </div>
        ${callButtonHtml(contact)}
      </article>`
      )
      .join("");
  }

  function renderKnowTiles(el) {
    if (!el) return;
    el.innerHTML = data.knowTiles
      .map(
        (tile) => `
      <a class="know-tile" href="${tile.href}">
        <img src="${tile.icon}" alt="" width="24" height="24" />
        <span>${escapeHtml(tile.label)}</span>
      </a>`
      )
      .join("");
  }

  function initModal() {
    const overlay = document.getElementById("activity-modal");
    if (!overlay) return;

    const closeBtn = overlay.querySelector("[data-close-modal]");
    closeBtn.addEventListener("click", closeModal);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal();
    });
  }

  function initCompleteModal() {
    const overlay = document.getElementById("complete-modal");
    if (!overlay) return;

    const closeBtn = overlay.querySelector("[data-close-complete]");
    const uploadBtn = document.getElementById("complete-photo-upload");
    const cameraBtn = document.getElementById("complete-photo-camera-btn");
    const input = document.getElementById("complete-photo-input");
    const cameraInput = document.getElementById("complete-photo-camera-input");
    const captureBtn = document.getElementById("complete-photo-capture");
    const cancelCameraBtn = document.getElementById("complete-photo-camera-cancel");
    const sendBtn = document.getElementById("complete-send-btn");

    closeBtn.addEventListener("click", closeCompleteModal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeCompleteModal();
    });

    uploadBtn.addEventListener("click", () => {
      stopCamera();
      restorePhotoPreview();
      input.click();
    });
    cameraBtn.addEventListener("click", startCamera);
    captureBtn.addEventListener("click", captureCameraPhoto);
    cancelCameraBtn.addEventListener("click", cancelCamera);
    input.addEventListener("change", handlePhotoSelected);
    cameraInput.addEventListener("change", handlePhotoSelected);
    sendBtn.addEventListener("click", submitComplete);

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const completeOpen = overlay.classList.contains("is-open");
      const activityOpen = document
        .getElementById("activity-modal")
        ?.classList.contains("is-open");
      if (completeOpen) closeCompleteModal();
      else if (activityOpen) closeModal();
    });
  }

  function parentFirstName() {
    if (data.parentName) return data.parentName.split(/\s+/)[0];
    const contact = data.contacts && data.contacts[0];
    return (contact && contact.firstName) || "parent";
  }

  function taskDetailText(item) {
    return item.location || item.detail || "";
  }

  function openCompleteModal(item, opener) {
    const overlay = document.getElementById("complete-modal");
    if (!overlay) return;

    returnFocusEl = opener || document.activeElement;
    pendingCompleteItem = item;
    resetPhotoUpload();

    overlay.querySelector("[data-complete-time]").textContent = item.time;
    overlay.querySelector("[data-complete-title]").textContent = item.title;
    overlay.querySelector("[data-complete-detail]").textContent =
      taskDetailText(item);

    document.getElementById("complete-note").value = "";
    const noTag = overlay.querySelector('input[name="complete-tag"][value=""]');
    if (noTag) noTag.checked = true;
    const sendBtn = document.getElementById("complete-send-btn");
    sendBtn.textContent = `Send to ${parentFirstName()}`;
    sendBtn.disabled = false;

    closeModal(false);
    overlay.classList.add("is-open");
    overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    overlay.querySelector("[data-close-complete]").focus();
  }

  function closeCompleteModal(restoreFocus = true) {
    const overlay = document.getElementById("complete-modal");
    if (!overlay) return;
    const wasOpen = overlay.classList.contains("is-open");
    overlay.classList.remove("is-open");
    overlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    pendingCompleteItem = null;
    resetPhotoUpload();
    if (wasOpen && restoreFocus) restoreFocusAfterModal();
  }

  function restoreFocusAfterModal() {
    const el = returnFocusEl;
    returnFocusEl = null;
    if (el && el.isConnected && !el.disabled) el.focus();
  }

  function applyShiftLockToCompleteModal() {
    const overlay = document.getElementById("complete-modal");
    if (!overlay || !overlay.classList.contains("is-open")) return;
    if (shift.state.active) return;
    const error = document.getElementById("complete-photo-error");
    error.textContent = lockText(shift.state) || SHIFT_LOCKED_TEXT;
    error.hidden = false;
    document.getElementById("complete-send-btn").disabled = true;
  }

  function resetPhotoUpload() {
    const input = document.getElementById("complete-photo-input");
    const cameraInput = document.getElementById("complete-photo-camera-input");
    const preview = document.getElementById("complete-photo-preview");
    const stage = document.getElementById("complete-photo-stage");
    const error = document.getElementById("complete-photo-error");
    const cameraError = document.getElementById("complete-photo-camera-error");

    stopCamera();
    pendingPhotoFile = null;

    if (photoObjectUrl) {
      URL.revokeObjectURL(photoObjectUrl);
      photoObjectUrl = null;
    }

    if (input) input.value = "";
    if (cameraInput) cameraInput.value = "";
    if (preview) {
      preview.hidden = true;
      preview.removeAttribute("src");
      preview.alt = "";
    }
    if (stage) stage.hidden = true;
    if (error) {
      error.hidden = true;
      error.textContent = "Please add a photo before sending.";
    }
    if (cameraError) cameraError.hidden = true;

    const choices = document.getElementById("complete-photo-choices");
    if (choices) choices.hidden = false;
  }

  function handlePhotoSelected(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    const otherId =
      e.target.id === "complete-photo-input"
        ? "complete-photo-camera-input"
        : "complete-photo-input";
    const other = document.getElementById(otherId);
    if (other) other.value = "";

    stopCamera();
    setPendingPhoto(file);
  }

  function setPendingPhoto(file) {
    const preview = document.getElementById("complete-photo-preview");
    const stage = document.getElementById("complete-photo-stage");
    const error = document.getElementById("complete-photo-error");
    const cameraError = document.getElementById("complete-photo-camera-error");
    if (!file || !preview || !stage) return;

    pendingPhotoFile = file;
    if (photoObjectUrl) URL.revokeObjectURL(photoObjectUrl);
    photoObjectUrl = URL.createObjectURL(file);
    preview.src = photoObjectUrl;
    preview.alt = "Task photo";
    preview.hidden = false;
    stage.hidden = false;
    if (error) error.hidden = true;
    if (cameraError) cameraError.hidden = true;
  }

  function restorePhotoPreview() {
    const preview = document.getElementById("complete-photo-preview");
    const stage = document.getElementById("complete-photo-stage");
    const video = document.getElementById("complete-photo-video");
    if (video) video.hidden = true;
    if (pendingPhotoFile && preview && preview.getAttribute("src")) {
      preview.hidden = false;
      if (stage) stage.hidden = false;
      return;
    }
    if (preview) preview.hidden = true;
    if (stage) stage.hidden = true;
  }

  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = null;
    }

    const video = document.getElementById("complete-photo-video");
    if (video) {
      video.pause();
      video.srcObject = null;
      video.hidden = true;
    }

    const cameraActions = document.getElementById("complete-photo-camera-actions");
    const choices = document.getElementById("complete-photo-choices");
    if (cameraActions) cameraActions.hidden = true;
    if (choices) choices.hidden = false;
  }

  function startCamera() {
    const cameraError = document.getElementById("complete-photo-camera-error");
    const error = document.getElementById("complete-photo-error");
    if (error) error.hidden = true;
    if (cameraError) cameraError.hidden = true;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      document.getElementById("complete-photo-camera-input").click();
      return;
    }

    stopCamera();
    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      })
      .then((stream) => {
        cameraStream = stream;
        const video = document.getElementById("complete-photo-video");
        const preview = document.getElementById("complete-photo-preview");
        const stage = document.getElementById("complete-photo-stage");
        const choices = document.getElementById("complete-photo-choices");
        const cameraActions = document.getElementById(
          "complete-photo-camera-actions"
        );
        video.srcObject = stream;
        video.hidden = false;
        if (preview) preview.hidden = true;
        if (stage) stage.hidden = false;
        if (choices) choices.hidden = true;
        if (cameraActions) cameraActions.hidden = false;
        document.getElementById("complete-photo-capture").focus();
      })
      .catch(() => {
        restorePhotoPreview();
        if (cameraError) cameraError.hidden = false;
        document.getElementById("complete-photo-upload").focus();
      });
  }

  function cancelCamera() {
    stopCamera();
    restorePhotoPreview();
  }

  function captureCameraPhoto() {
    const video = document.getElementById("complete-photo-video");
    if (!video || !video.videoWidth) return;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const file = new File([blob], "task-photo.jpg", { type: "image/jpeg" });
        stopCamera();
        setPendingPhoto(file);
      },
      "image/jpeg",
      0.92
    );
  }

  function submitComplete() {
    const error = document.getElementById("complete-photo-error");
    const note = document.getElementById("complete-note").value.trim();

    if (cameraStream) {
      if (error) {
        error.textContent = "Capture the photo before sending.";
        error.hidden = false;
      }
      document.getElementById("complete-photo-capture").focus();
      return;
    }

    const file = pendingPhotoFile;

    if (!file) {
      if (error) {
        error.textContent = "Please add a photo before sending.";
        error.hidden = false;
      }
      document.getElementById("complete-photo-upload").focus();
      return;
    }

    if (!pendingCompleteItem) return;

    const item = pendingCompleteItem;
    const tagInput = document.querySelector('input[name="complete-tag"]:checked');
    const tag = tagInput ? tagInput.value : "";
    const sendBtn = document.getElementById("complete-send-btn");
    sendBtn.disabled = true;

    sendBtn.textContent = "Sending…";
    shift
      .completeTask({ taskId: item.id, file, note, tag })
      .then(() => {
        // The check button is gone after re-render; return focus to the task row.
        returnFocusEl = null;
        closeCompleteModal(false);
        const row = document.querySelector(
          `[data-schedule-id="${cssEscape(item.id)}"]`
        );
        if (row) row.focus();
        announce(`${item.title} sent to ${parentFirstName()}.`);
        // SI-34: prompt for care details about the task just completed (Skip closes it).
        if (careLog && shift.state.canLog && shift.state.checks[item.id]) {
          careLog.openModal(careLogTask(item.id), row, { prompt: true });
        }
      })
      .catch((err) => {
        sendBtn.textContent = `Send to ${parentFirstName()}`;
        sendBtn.disabled = !shift.state.active;
        if (error) {
          error.textContent = shift.errorMessage(err);
          error.hidden = false;
        }
      });
  }

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : String(value);
  }

  function announce(text) {
    const el = document.getElementById("app-status");
    if (!el) return;
    el.textContent = "";
    window.setTimeout(() => {
      el.textContent = text;
    }, 50);
  }

  function formatTime(ms) {
    return new Date(ms).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  // "5:02pm"
  function shortTime(ms) {
    return formatTime(ms).replace(/\s*([AaPp])\.?\s*[Mm]\.?$/, (m, ap) => `${ap.toLowerCase()}m`);
  }

  function renderShiftControls() {
    const el = document.getElementById("shift-controls");
    if (!el) return;
    const st = shift.state;
    const status = el.querySelector("[data-shift-status]");
    const q = (sel) => el.querySelector(sel);
    const show = (sel, on) => {
      const b = q(sel);
      if (b) b.hidden = !on;
    };
    const v = st.visit;
    let text;
    if (st.loadError) text = `We couldn't load your shift. ${st.loadError}`;
    else if (st.noPlan) text = "Your family hasn't added a schedule yet.";
    else if (!v) text = "No shift started yet.";
    else if (st.tooOld) text = `Your last shift was on ${dayLabel(v.date)}. It's read-only now.`;
    else if (st.ended) text = `Shift ended at ${shortTime(v.endedAt)} by ${v.endedByName}.`;
    else text = `Shift in progress since ${shortTime(v.startedAt)}.`;
    status.textContent = text;
    const card = document.getElementById("shift-card");
    if (card) card.dataset.state = st.active ? "active" : st.ended ? "ended" : "upcoming";
    const heading = document.getElementById("shift-heading");
    if (heading) heading.textContent = st.active ? "Current Shift" : "Your Next Shift";

    show("[data-retry-shift]", Boolean(st.loadError));
    show("[data-start-shift]", !st.loadError && st.canStart);
    show("[data-end-shift]", !st.loadError && st.active);
    show("[data-reopen-shift]", !st.loadError && st.canReopen);

    const history = q("[data-shift-history]");
    if (history) {
      const text = historyText(st);
      history.textContent = text;
      history.hidden = !text;
    }
  }

  // "Started 3:00pm by Bethany · ended 5:02pm by Bethany · reopened 5:10pm by Bethany"
  function historyText(st) {
    if (!st.visit || !st.events.length) return "";
    const parts = [`Started ${shortTime(st.visit.startedAt)} by ${st.visit.startedByName}`];
    st.events.forEach((e) => {
      const when = `${shortTime(e.at)} by ${e.actorName}`;
      if (e.kind === "ended") parts.push(`ended ${when}`);
      else if (e.kind === "reopened") parts.push(`reopened ${when}`);
      else if (e.kind === "unchecked") parts.push(`unchecked ${e.taskTitle || "a task"} ${when}`);
    });
    return parts.join(" · ");
  }

  function showShiftError(err) {
    const el = document.querySelector("[data-shift-error]");
    if (!el) return;
    el.textContent = err ? shift.errorMessage(err) : "";
    el.hidden = !err;
  }

  function focusShiftStatus() {
    const status = document.querySelector("[data-shift-status]");
    if (!status) return;
    status.setAttribute("tabindex", "-1");
    status.focus();
  }

  function initShiftButtons() {
    const startBtn = document.querySelector("[data-start-shift]");
    const retryBtn = document.querySelector("[data-retry-shift]");
    const reopenBtn = document.querySelector("[data-reopen-shift]");
    const dialog = document.getElementById("reopen-shift-dialog");

    if (startBtn) {
      startBtn.addEventListener("click", () => {
        showShiftError(null);
        startBtn.disabled = true;
        shift
          .startShift()
          .then(() => {
            announce("Shift started.");
            focusShiftStatus();
          })
          .catch(showShiftError)
          .finally(() => (startBtn.disabled = false));
      });
    }
    if (retryBtn) {
      retryBtn.addEventListener("click", () => {
        showShiftError(null);
        shift.refresh().catch(showShiftError);
      });
    }
    if (reopenBtn && dialog && typeof dialog.showModal === "function") {
      reopenBtn.addEventListener("click", () => {
        dialog.returnValue = "";
        dialog.showModal();
      });
      dialog.addEventListener("close", () => {
        if (dialog.returnValue !== "confirm") {
          reopenBtn.focus();
          return;
        }
        showShiftError(null);
        shift
          .reopenShift()
          .then(() => {
            announce(`Shift reopened. ${parentFirstName()} will be told.`);
            focusShiftStatus();
          })
          .catch(showShiftError);
      });
    }
  }

  function initEndShiftDialog() {
    const dialog = document.getElementById("end-shift-dialog");
    const openBtn = document.querySelector("[data-end-shift]");
    if (!dialog || !openBtn || typeof dialog.showModal !== "function") return;

    openBtn.addEventListener("click", () => {
      dialog.returnValue = "";
      dialog.showModal();
    });

    dialog.addEventListener("close", () => {
      if (dialog.returnValue === "confirm") {
        showShiftError(null);
        shift
          .endShift()
          .then(() => {
            announce("Shift ended. Photos can no longer be added.");
            focusShiftStatus();
          })
          .catch(showShiftError);
      } else {
        openBtn.focus();
      }
    });
  }

  // Dev-only controls so the moment prompt and shift lock can be tested quickly.
  // Dev-only controls. The sitter's moment trigger and the reset are demo-only: with real
  // accounts only a parent can move the moment (trigger_moment_now), from parent.html's demo tools.
  function renderDevTools() {
    if (!isDevHost) return;
    const host = document.querySelector(".side-column") || document.querySelector(".app");
    if (!host) return;
    const box = document.createElement("section");
    box.className = "panel dev-tools";
    box.setAttribute("aria-labelledby", "dev-tools-heading");
    const demoButtons = shift.demo
      ? `<button type="button" class="photo-source-btn" data-dev="moment">Trigger moment now</button>
        <button type="button" class="photo-source-btn" data-dev="reset">Start a new shift (clears data)</button>`
      : "";
    box.innerHTML = `
      <h2 class="panel-title" id="dev-tools-heading">Demo tools (not part of the product)</h2>
      <div class="dev-tools-actions">
        <a class="photo-source-btn dev-link" href="parent.html${shift.demo ? "?demo=1" : ""}" target="_blank" rel="noopener">Open parent view<span class="visually-hidden"> (opens in a new tab)</span></a>
        ${demoButtons}
      </div>`;
    const momentBtn = box.querySelector('[data-dev="moment"]');
    if (momentBtn) momentBtn.addEventListener("click", () => shift.triggerMomentNow());
    const resetBtn = box.querySelector('[data-dev="reset"]');
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        store.resetShift();
        announce("New shift started.");
      });
    }
    host.appendChild(box);
  }

  function senderName(sender) {
    if (sender === "parent") {
      if (data.parentName) return data.parentName;
      const contact = data.contacts && data.contacts[0];
      return (contact && contact.name) || "Parent";
    }
    return data.babysitter.name;
  }

  function photoImg(src, alt, className) {
    if (!store.isPhotoDataUrl(src)) return "";
    return `<img class="${className}" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" />`;
  }

  // Label for a task_proof/moment message, e.g. "Snack" or "Moment".
  function photoTitle(message) {
    if (!message) return "Photo";
    if (message.kind === "moment") return "Moment";
    const task = data.schedule.find((s) => s.id === message.taskId);
    return task ? task.title : "Task";
  }

  function openModal(item, opener) {
    const overlay = document.getElementById("activity-modal");
    if (!overlay) return;
    returnFocusEl = opener || document.activeElement;

    overlay.querySelector("[data-modal-time]").textContent = item.time;
    overlay.querySelector("[data-modal-date]").textContent = data.child.dateLabel;
    overlay.querySelector("[data-modal-title]").textContent = item.title;

    const mapLink = overlay.querySelector("[data-modal-map-link]");

    const locationEl = overlay.querySelector("[data-modal-location]");
    const locationText = overlay.querySelector("[data-modal-location-text]");
    const detailEl = overlay.querySelector("[data-modal-detail]");

    if (item.location) {
      locationText.textContent = item.location;
      if (mapLink) mapLink.href = mapsHref(item.location);
      locationEl.hidden = false;
      detailEl.hidden = true;
      detailEl.textContent = "";
    } else if (item.detail) {
      locationEl.hidden = true;
      locationText.textContent = "";
      detailEl.textContent = item.detail;
      detailEl.hidden = false;
    } else {
      locationEl.hidden = true;
      locationText.textContent = "";
      detailEl.hidden = true;
      detailEl.textContent = "";
    }

    const careEl = overlay.querySelector("[data-modal-care]");
    const careBody = overlay.querySelector("[data-modal-care-body]");
    if (item.careNote) {
      careBody.textContent = item.careNote;
      careEl.hidden = false;
    } else {
      careEl.hidden = true;
    }

    const emptyEl = overlay.querySelector("[data-modal-empty]");
    if (emptyEl) {
      emptyEl.hidden = Boolean(
        item.detail || item.location || item.map || item.careNote
      );
    }

    const photoWrap = overlay.querySelector("[data-modal-photo-wrap]");
    const photoEl = overlay.querySelector("[data-modal-photo]");
    const path = proofPhotoPath(item);
    photoEl.removeAttribute("src");
    delete photoEl.dataset.loadedPath;
    if (path) {
      photoEl.dataset.photoPath = path;
      photoEl.alt = `Submitted photo for ${item.title}`;
      photoWrap.hidden = false;
      hydratePhotos(photoWrap);
    } else {
      delete photoEl.dataset.photoPath;
      photoEl.alt = "";
      photoWrap.hidden = true;
    }

    const proof = item.check && item.check.proof;
    const tagEl = overlay.querySelector("[data-modal-tag]");
    if (tagEl) {
      tagEl.textContent = proof && proof.tag ? proof.tag : "";
      tagEl.hidden = !(proof && proof.tag);
    }

    const noteWrap = overlay.querySelector("[data-modal-note-wrap]");
    const noteEl = overlay.querySelector("[data-modal-note]");
    if (proof && proof.body) {
      noteEl.textContent = proof.body;
      noteWrap.hidden = false;
    } else {
      noteEl.textContent = "";
      noteWrap.hidden = true;
    }

    const metaEl = overlay.querySelector("[data-modal-check-meta]");
    if (metaEl) {
      const parts = checkMetaParts(item.check);
      metaEl.innerHTML = parts.join("");
      metaEl.hidden = !parts.length;
    }
    setupUncheck(overlay, item);
    renderModalLogs(overlay, item);

    closeCompleteModal(false);
    overlay.classList.add("is-open");
    overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    overlay.querySelector("[data-close-modal]").focus();
  }

  function closeModal(restoreFocus = true) {
    const overlay = document.getElementById("activity-modal");
    if (!overlay) return;
    const wasOpen = overlay.classList.contains("is-open");
    overlay.classList.remove("is-open");
    overlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    if (wasOpen && restoreFocus) restoreFocusAfterModal();
  }

  // Unchecking is allowed while the shift is open; after a reopen, unchecking a task from the
  // original shift is recorded in the shift history (by the database).
  function setupUncheck(overlay, item) {
    const btn = overlay.querySelector("[data-uncheck]");
    const err = overlay.querySelector("[data-uncheck-error]");
    if (!btn) return;
    if (err) err.hidden = true;
    const canUncheck = Boolean(item.completed && shift && shift.state.active);
    btn.hidden = !canUncheck;
    btn.disabled = false;
    btn.onclick = !canUncheck
      ? null
      : () => {
          const logged =
            item.check && !item.check.afterReopen && shift.state.events.some((e) => e.kind === "reopened");
          const photoNote = item.check && item.check.proof ? " The photo stays in the Gallery." : "";
          const body = logged
            ? `${item.title} will go back to not done. Because this shift was reopened, the uncheck is recorded in the shift history.${photoNote}`
            : `${item.title} will go back to not done.${photoNote}`;
          const ask = window.CareNestAuth && window.CareNestAuth.confirmDialog
            ? window.CareNestAuth.confirmDialog({ title: "Uncheck this task?", body, confirmLabel: "Uncheck" })
            : Promise.resolve(window.confirm(body));
          ask.then((ok) => {
            if (!ok) return;
            btn.disabled = true;
            shift
              .uncheckTask(item.id)
              .then(() => {
                closeModal();
                announce(`${item.title} unchecked.`);
              })
              .catch((e) => {
                btn.disabled = false;
                if (err) {
                  err.textContent = shift.errorMessage(e);
                  err.hidden = false;
                }
              });
          });
        };
  }

  // A function (not a const) because page set-up runs before this line is reached.
  // Bottom nav glyphs (Figma Nav Icon set 196:337, 28x28): an outline path for the default state
  // and a filled path for the active one. Inline with fill: currentColor so CSS recolours them and
  // swaps outline/filled from aria-current; Album has no Figma glyph and is drawn to match.
  const NAV_ICONS = {
    "home": [
      "M7 22.1667H10.5V15.1667H17.5V22.1667H21V11.6667L14 6.41667L7 11.6667V22.1667ZM4.66667 24.5V10.5L14 3.5L23.3333 10.5V24.5H15.1667V17.5H12.8333V24.5H4.66667Z",
      "M4.66667 24.5V10.5L14 3.5L23.3333 10.5V24.5H16.3333V16.3333H11.6667V24.5H4.66667Z",
    ],
    "schedule": [
      "M5.83333 25.6667C5.19167 25.6667 4.64236 25.4382 4.18542 24.9813C3.72847 24.5243 3.5 23.975 3.5 23.3333V7C3.5 6.35833 3.72847 5.80903 4.18542 5.35208C4.64236 4.89514 5.19167 4.66667 5.83333 4.66667H7V2.33333H9.33333V4.66667H18.6667V2.33333H21V4.66667H22.1667C22.8083 4.66667 23.3576 4.89514 23.8146 5.35208C24.2715 5.80903 24.5 6.35833 24.5 7V23.3333C24.5 23.975 24.2715 24.5243 23.8146 24.9813C23.3576 25.4382 22.8083 25.6667 22.1667 25.6667H5.83333ZM5.83333 23.3333H22.1667V11.6667H5.83333V23.3333ZM5.83333 9.33333H22.1667V7H5.83333V9.33333Z",
      "M5.83333 25.6667C5.19167 25.6667 4.64236 25.4382 4.18542 24.9813C3.72847 24.5243 3.5 23.975 3.5 23.3333V7C3.5 6.35833 3.72847 5.80903 4.18542 5.35208C4.64236 4.89514 5.19167 4.66667 5.83333 4.66667H7V2.33333H9.33333V4.66667H18.6667V2.33333H21V4.66667H22.1667C22.8083 4.66667 23.3576 4.89514 23.8146 5.35208C24.2715 5.80903 24.5 6.35833 24.5 7V23.3333C24.5 23.975 24.2715 24.5243 23.8146 24.9813C23.3576 25.4382 22.8083 25.6667 22.1667 25.6667H5.83333ZM5.83333 23.3333H22.1667V11.6667H5.83333V23.3333Z",
    ],
    "care-log": [
      "M16.3333 11.55V9.56667C16.975 9.29444 17.6312 9.09028 18.3021 8.95417C18.9729 8.81806 19.6778 8.75 20.4167 8.75C20.9222 8.75 21.4181 8.78889 21.9042 8.86667C22.3903 8.94444 22.8667 9.04167 23.3333 9.15833V11.025C22.8667 10.85 22.3951 10.7188 21.9187 10.6312C21.4424 10.5437 20.9417 10.5 20.4167 10.5C19.6778 10.5 18.9681 10.5924 18.2875 10.7771C17.6069 10.9618 16.9556 11.2194 16.3333 11.55ZM16.3333 17.9667V15.9833C16.975 15.7111 17.6312 15.5069 18.3021 15.3708C18.9729 15.2347 19.6778 15.1667 20.4167 15.1667C20.9222 15.1667 21.4181 15.2056 21.9042 15.2833C22.3903 15.3611 22.8667 15.4583 23.3333 15.575V17.4417C22.8667 17.2667 22.3951 17.1354 21.9187 17.0479C21.4424 16.9604 20.9417 16.9167 20.4167 16.9167C19.6778 16.9167 18.9681 17.0042 18.2875 17.1792C17.6069 17.3542 16.9556 17.6167 16.3333 17.9667ZM16.3333 14.7583V12.775C16.975 12.5028 17.6312 12.2986 18.3021 12.1625C18.9729 12.0264 19.6778 11.9583 20.4167 11.9583C20.9222 11.9583 21.4181 11.9972 21.9042 12.075C22.3903 12.1528 22.8667 12.25 23.3333 12.3667V14.2333C22.8667 14.0583 22.3951 13.9271 21.9187 13.8396C21.4424 13.7521 20.9417 13.7083 20.4167 13.7083C19.6778 13.7083 18.9681 13.8007 18.2875 13.9854C17.6069 14.1701 16.9556 14.4278 16.3333 14.7583ZM7.58333 18.6667C8.49722 18.6667 9.38681 18.7687 10.2521 18.9729C11.1174 19.1771 11.9778 19.4833 12.8333 19.8917V8.4C12.0361 7.93333 11.1903 7.58333 10.2958 7.35C9.40139 7.11667 8.49722 7 7.58333 7C6.88333 7 6.18819 7.06806 5.49792 7.20417C4.80764 7.34028 4.14167 7.54444 3.5 7.81667V19.3667C4.18056 19.1333 4.85625 18.9583 5.52708 18.8417C6.19792 18.725 6.88333 18.6667 7.58333 18.6667ZM15.1667 19.8917C16.0222 19.4833 16.8826 19.1771 17.7479 18.9729C18.6132 18.7687 19.5028 18.6667 20.4167 18.6667C21.1167 18.6667 21.8021 18.725 22.4729 18.8417C23.1437 18.9583 23.8194 19.1333 24.5 19.3667V7.81667C23.8583 7.54444 23.1924 7.34028 22.5021 7.20417C21.8118 7.06806 21.1167 7 20.4167 7C19.5028 7 18.5986 7.11667 17.7042 7.35C16.8097 7.58333 15.9639 7.93333 15.1667 8.4V19.8917ZM14 23.3333C13.0667 22.5944 12.0556 22.0208 10.9667 21.6125C9.87778 21.2042 8.75 21 7.58333 21C6.76667 21 5.96458 21.1069 5.17708 21.3208C4.38958 21.5347 3.63611 21.8361 2.91667 22.225C2.50833 22.4389 2.11458 22.4292 1.73542 22.1958C1.35625 21.9625 1.16667 21.6222 1.16667 21.175V7.11667C1.16667 6.90278 1.22014 6.69861 1.32708 6.50417C1.43403 6.30972 1.59444 6.16389 1.80833 6.06667C2.70278 5.6 3.63611 5.25 4.60833 5.01667C5.58056 4.78333 6.57222 4.66667 7.58333 4.66667C8.71111 4.66667 9.81458 4.8125 10.8937 5.10417C11.9729 5.39583 13.0083 5.83333 14 6.41667C14.9917 5.83333 16.0271 5.39583 17.1062 5.10417C18.1854 4.8125 19.2889 4.66667 20.4167 4.66667C21.4278 4.66667 22.4194 4.78333 23.3917 5.01667C24.3639 5.25 25.2972 5.6 26.1917 6.06667C26.4056 6.16389 26.566 6.30972 26.6729 6.50417C26.7799 6.69861 26.8333 6.90278 26.8333 7.11667V21.175C26.8333 21.6222 26.6437 21.9625 26.2646 22.1958C25.8854 22.4292 25.4917 22.4389 25.0833 22.225C24.3639 21.8361 23.6104 21.5347 22.8229 21.3208C22.0354 21.1069 21.2333 21 20.4167 21C19.25 21 18.1222 21.2042 17.0333 21.6125C15.9444 22.0208 14.9333 22.5944 14 23.3333Z",
      "M16.3333 11.55V9.56667C16.975 9.29444 17.6312 9.09028 18.3021 8.95417C18.9729 8.81806 19.6778 8.75 20.4167 8.75C20.9222 8.75 21.4181 8.78889 21.9042 8.86667C22.3903 8.94444 22.8667 9.04167 23.3333 9.15833V11.025C22.8667 10.85 22.3951 10.7188 21.9187 10.6312C21.4424 10.5437 20.9417 10.5 20.4167 10.5C19.6778 10.5 18.9681 10.5924 18.2875 10.7771C17.6069 10.9618 16.9556 11.2194 16.3333 11.55ZM16.3333 17.9667V15.9833C16.975 15.7111 17.6312 15.5069 18.3021 15.3708C18.9729 15.2347 19.6778 15.1667 20.4167 15.1667C20.9222 15.1667 21.4181 15.2056 21.9042 15.2833C22.3903 15.3611 22.8667 15.4583 23.3333 15.575V17.4417C22.8667 17.2667 22.3951 17.1354 21.9187 17.0479C21.4424 16.9604 20.9417 16.9167 20.4167 16.9167C19.6778 16.9167 18.9681 17.0042 18.2875 17.1792C17.6069 17.3542 16.9556 17.6167 16.3333 17.9667ZM16.3333 14.7583V12.775C16.975 12.5028 17.6312 12.2986 18.3021 12.1625C18.9729 12.0264 19.6778 11.9583 20.4167 11.9583C20.9222 11.9583 21.4181 11.9972 21.9042 12.075C22.3903 12.1528 22.8667 12.25 23.3333 12.3667V14.2333C22.8667 14.0583 22.3951 13.9271 21.9187 13.8396C21.4424 13.7521 20.9417 13.7083 20.4167 13.7083C19.6778 13.7083 18.9681 13.8007 18.2875 13.9854C17.6069 14.1701 16.9556 14.4278 16.3333 14.7583ZM15.1667 19.8917C16.0222 19.4833 16.8826 19.1771 17.7479 18.9729C18.6132 18.7687 19.5028 18.6667 20.4167 18.6667C21.1167 18.6667 21.8021 18.725 22.4729 18.8417C23.1437 18.9583 23.8194 19.1333 24.5 19.3667V7.81667C23.8583 7.54444 23.1924 7.34028 22.5021 7.20417C21.8118 7.06806 21.1167 7 20.4167 7C19.5028 7 18.5986 7.11667 17.7042 7.35C16.8097 7.58333 15.9639 7.93333 15.1667 8.4V19.8917ZM14 23.3333C13.0667 22.5944 12.0556 22.0208 10.9667 21.6125C9.87778 21.2042 8.75 21 7.58333 21C6.76667 21 5.96458 21.1069 5.17708 21.3208C4.38958 21.5347 3.63611 21.8361 2.91667 22.225C2.50833 22.4389 2.11458 22.4292 1.73542 22.1958C1.35625 21.9625 1.16667 21.6222 1.16667 21.175V7.11667C1.16667 6.90278 1.22014 6.69861 1.32708 6.50417C1.43403 6.30972 1.59444 6.16389 1.80833 6.06667C2.72222 5.61944 3.66042 5.27431 4.62292 5.03125C5.58542 4.78819 6.57222 4.66667 7.58333 4.66667C8.71111 4.66667 9.81458 4.8125 10.8937 5.10417C11.9729 5.39583 13.0083 5.83333 14 6.41667C14.9917 5.83333 16.0271 5.39583 17.1062 5.10417C18.1854 4.8125 19.2889 4.66667 20.4167 4.66667C21.4278 4.66667 22.4146 4.78819 23.3771 5.03125C24.3396 5.27431 25.2778 5.61944 26.1917 6.06667C26.4056 6.16389 26.566 6.30972 26.6729 6.50417C26.7799 6.69861 26.8333 6.90278 26.8333 7.11667V21.175C26.8333 21.6222 26.6437 21.9625 26.2646 22.1958C25.8854 22.4292 25.4917 22.4389 25.0833 22.225C24.3639 21.8361 23.6104 21.5347 22.8229 21.3208C22.0354 21.1069 21.2333 21 20.4167 21C19.25 21 18.1222 21.2042 17.0333 21.6125C15.9444 22.0208 14.9333 22.5944 14 23.3333Z",
    ],
    "children": [
      "M15.8812 13.2854C15.5993 13.0035 15.4583 12.6583 15.4583 12.25C15.4583 11.8417 15.5993 11.4965 15.8812 11.2146C16.1632 10.9326 16.5083 10.7917 16.9167 10.7917C17.325 10.7917 17.6701 10.9326 17.9521 11.2146C18.234 11.4965 18.375 11.8417 18.375 12.25C18.375 12.6583 18.234 13.0035 17.9521 13.2854C17.6701 13.5674 17.325 13.7083 16.9167 13.7083C16.5083 13.7083 16.1632 13.5674 15.8812 13.2854ZM10.0479 13.2854C9.76597 13.0035 9.625 12.6583 9.625 12.25C9.625 11.8417 9.76597 11.4965 10.0479 11.2146C10.3299 10.9326 10.675 10.7917 11.0833 10.7917C11.4917 10.7917 11.8368 10.9326 12.1187 11.2146C12.4007 11.4965 12.5417 11.8417 12.5417 12.25C12.5417 12.6583 12.4007 13.0035 12.1187 13.2854C11.8368 13.5674 11.4917 13.7083 11.0833 13.7083C10.675 13.7083 10.3299 13.5674 10.0479 13.2854ZM10.8354 18.8708C9.89236 18.2292 9.19722 17.3833 8.75 16.3333H19.25C18.8028 17.3833 18.1076 18.2292 17.1646 18.8708C16.2215 19.5125 15.1667 19.8333 14 19.8333C12.8333 19.8333 11.7785 19.5125 10.8354 18.8708ZM9.90208 23.6687C8.62847 23.1146 7.52014 22.366 6.57708 21.4229C5.63403 20.4799 4.88542 19.3715 4.33125 18.0979C3.77708 16.8243 3.5 15.4583 3.5 14C3.5 12.5417 3.77708 11.1757 4.33125 9.90208C4.88542 8.62847 5.63403 7.52014 6.57708 6.57708C7.52014 5.63403 8.62847 4.88542 9.90208 4.33125C11.1757 3.77708 12.5417 3.5 14 3.5C15.4583 3.5 16.8243 3.77708 18.0979 4.33125C19.3715 4.88542 20.4799 5.63403 21.4229 6.57708C22.366 7.52014 23.1146 8.62847 23.6687 9.90208C24.2229 11.1757 24.5 12.5417 24.5 14C24.5 15.4583 24.2229 16.8243 23.6687 18.0979C23.1146 19.3715 22.366 20.4799 21.4229 21.4229C20.4799 22.366 19.3715 23.1146 18.0979 23.6687C16.8243 24.2229 15.4583 24.5 14 24.5C12.5417 24.5 11.1757 24.2229 9.90208 23.6687ZM19.775 19.775C21.3694 18.1806 22.1667 16.2556 22.1667 14C22.1667 11.7444 21.3694 9.81944 19.775 8.225C18.1806 6.63056 16.2556 5.83333 14 5.83333H13.65C13.5333 5.83333 13.4167 5.85278 13.3 5.89167C13.1833 6.00833 13.1056 6.13472 13.0667 6.27083C13.0278 6.40694 13.0083 6.55278 13.0083 6.70833C13.0083 7.11667 13.1493 7.46181 13.4312 7.74375C13.7132 8.02569 14.0583 8.16667 14.4667 8.16667C14.6417 8.16667 14.8021 8.1375 14.9479 8.07917C15.0937 8.02083 15.2444 7.99167 15.4 7.99167C15.6333 7.99167 15.8278 8.07917 15.9833 8.25417C16.1389 8.42917 16.2167 8.63333 16.2167 8.86667C16.2167 9.31389 16.0076 9.60069 15.5896 9.72708C15.1715 9.85347 14.7972 9.91667 14.4667 9.91667C13.5917 9.91667 12.8382 9.60069 12.2062 8.96875C11.5743 8.33681 11.2583 7.58333 11.2583 6.70833V6.53333C11.2583 6.475 11.2681 6.39722 11.2875 6.3C9.67361 6.88333 8.36111 7.86528 7.35 9.24583C6.33889 10.6264 5.83333 12.2111 5.83333 14C5.83333 16.2556 6.63056 18.1806 8.225 19.775C9.81944 21.3694 11.7444 22.1667 14 22.1667C16.2556 22.1667 18.1806 21.3694 19.775 19.775Z",
      "M17.9521 13.2854C18.234 13.0035 18.375 12.6583 18.375 12.25C18.375 11.8417 18.234 11.4965 17.9521 11.2146C17.6701 10.9326 17.325 10.7917 16.9167 10.7917C16.5083 10.7917 16.1632 10.9326 15.8812 11.2146C15.5993 11.4965 15.4583 11.8417 15.4583 12.25C15.4583 12.6583 15.5993 13.0035 15.8812 13.2854C16.1632 13.5674 16.5083 13.7083 16.9167 13.7083C17.325 13.7083 17.6701 13.5674 17.9521 13.2854ZM12.1187 13.2854C12.4007 13.0035 12.5417 12.6583 12.5417 12.25C12.5417 11.8417 12.4007 11.4965 12.1187 11.2146C11.8368 10.9326 11.4917 10.7917 11.0833 10.7917C10.675 10.7917 10.3299 10.9326 10.0479 11.2146C9.76597 11.4965 9.625 11.8417 9.625 12.25C9.625 12.6583 9.76597 13.0035 10.0479 13.2854C10.3299 13.5674 10.675 13.7083 11.0833 13.7083C11.4917 13.7083 11.8368 13.5674 12.1187 13.2854ZM17.1646 18.8708C18.1076 18.2292 18.8028 17.3833 19.25 16.3333H8.75C9.19722 17.3833 9.89236 18.2292 10.8354 18.8708C11.7785 19.5125 12.8333 19.8333 14 19.8333C15.1667 19.8333 16.2215 19.5125 17.1646 18.8708ZM9.90208 23.6687C8.62847 23.1146 7.52014 22.366 6.57708 21.4229C5.63403 20.4799 4.88542 19.3715 4.33125 18.0979C3.77708 16.8243 3.5 15.4583 3.5 14C3.5 12.5417 3.77708 11.1757 4.33125 9.90208C4.88542 8.62847 5.63403 7.52014 6.57708 6.57708C7.52014 5.63403 8.62847 4.88542 9.90208 4.33125C11.1757 3.77708 12.5417 3.5 14 3.5C15.4583 3.5 16.8243 3.77708 18.0979 4.33125C19.3715 4.88542 20.4799 5.63403 21.4229 6.57708C22.366 7.52014 23.1146 8.62847 23.6687 9.90208C24.2229 11.1757 24.5 12.5417 24.5 14C24.5 15.4583 24.2229 16.8243 23.6687 18.0979C23.1146 19.3715 22.366 20.4799 21.4229 21.4229C20.4799 22.366 19.3715 23.1146 18.0979 23.6687C16.8243 24.2229 15.4583 24.5 14 24.5C12.5417 24.5 11.1757 24.2229 9.90208 23.6687ZM14.4667 9.91667C14.7972 9.91667 15.1715 9.85347 15.5896 9.72708C16.0076 9.60069 16.2167 9.31389 16.2167 8.86667C16.2167 8.63333 16.1389 8.42917 15.9833 8.25417C15.8278 8.07917 15.6333 7.99167 15.4 7.99167C15.2444 7.99167 15.0937 8.02083 14.9479 8.07917C14.8021 8.1375 14.6417 8.16667 14.4667 8.16667C14.0583 8.16667 13.7132 8.02569 13.4312 7.74375C13.1493 7.46181 13.0083 7.11667 13.0083 6.70833C13.0083 6.49444 13.0424 6.31458 13.1104 6.16875C13.1785 6.02292 13.2806 5.92083 13.4167 5.8625C13.0472 5.90139 12.6875 5.95 12.3375 6.00833C11.9875 6.06667 11.6472 6.16389 11.3167 6.3C11.2972 6.35833 11.2826 6.42639 11.2729 6.50417C11.2632 6.58194 11.2583 6.65 11.2583 6.70833C11.2583 7.58333 11.5743 8.33681 12.2062 8.96875C12.8382 9.60069 13.5917 9.91667 14.4667 9.91667Z",
    ],
    "profile": [
      "M6.825 19.95C7.81667 19.1917 8.925 18.5938 10.15 18.1563C11.375 17.7188 12.6583 17.5 14 17.5C15.3417 17.5 16.625 17.7188 17.85 18.1563C19.075 18.5938 20.1833 19.1917 21.175 19.95C21.8556 19.1528 22.3854 18.2486 22.7646 17.2375C23.1438 16.2264 23.3333 15.1472 23.3333 14C23.3333 11.4139 22.4243 9.21181 20.6063 7.39375C18.7882 5.57569 16.5861 4.66667 14 4.66667C11.4139 4.66667 9.21181 5.57569 7.39375 7.39375C5.57569 9.21181 4.66667 11.4139 4.66667 14C4.66667 15.1472 4.85625 16.2264 5.23542 17.2375C5.61458 18.2486 6.14444 19.1528 6.825 19.95ZM11.0979 13.9854C10.3104 13.1979 9.91667 12.2306 9.91667 11.0833C9.91667 9.93611 10.3104 8.96875 11.0979 8.18125C11.8854 7.39375 12.8528 7 14 7C15.1472 7 16.1146 7.39375 16.9021 8.18125C17.6896 8.96875 18.0833 9.93611 18.0833 11.0833C18.0833 12.2306 17.6896 13.1979 16.9021 13.9854C16.1146 14.7729 15.1472 15.1667 14 15.1667C12.8528 15.1667 11.8854 14.7729 11.0979 13.9854ZM14 25.6667C12.3861 25.6667 10.8694 25.3604 9.45 24.7479C8.03056 24.1354 6.79583 23.3042 5.74583 22.2542C4.69583 21.2042 3.86458 19.9694 3.25208 18.55C2.63958 17.1306 2.33333 15.6139 2.33333 14C2.33333 12.3861 2.63958 10.8694 3.25208 9.45C3.86458 8.03056 4.69583 6.79583 5.74583 5.74583C6.79583 4.69583 8.03056 3.86458 9.45 3.25208C10.8694 2.63958 12.3861 2.33333 14 2.33333C15.6139 2.33333 17.1306 2.63958 18.55 3.25208C19.9694 3.86458 21.2042 4.69583 22.2542 5.74583C23.3042 6.79583 24.1354 8.03056 24.7479 9.45C25.3604 10.8694 25.6667 12.3861 25.6667 14C25.6667 15.6139 25.3604 17.1306 24.7479 18.55C24.1354 19.9694 23.3042 21.2042 22.2542 22.2542C21.2042 23.3042 19.9694 24.1354 18.55 24.7479C17.1306 25.3604 15.6139 25.6667 14 25.6667ZM16.9167 22.8813C17.8306 22.5799 18.6667 22.1472 19.425 21.5833C18.6667 21.0194 17.8306 20.5868 16.9167 20.2854C16.0028 19.984 15.0306 19.8333 14 19.8333C12.9694 19.8333 11.9972 19.984 11.0833 20.2854C10.1694 20.5868 9.33333 21.0194 8.575 21.5833C9.33333 22.1472 10.1694 22.5799 11.0833 22.8813C11.9972 23.1826 12.9694 23.3333 14 23.3333C15.0306 23.3333 16.0028 23.1826 16.9167 22.8813ZM15.2542 12.3375C15.5847 12.0069 15.75 11.5889 15.75 11.0833C15.75 10.5778 15.5847 10.1597 15.2542 9.82917C14.9236 9.49861 14.5056 9.33333 14 9.33333C13.4944 9.33333 13.0764 9.49861 12.7458 9.82917C12.4153 10.1597 12.25 10.5778 12.25 11.0833C12.25 11.5889 12.4153 12.0069 12.7458 12.3375C13.0764 12.6681 13.4944 12.8333 14 12.8333C14.5056 12.8333 14.9236 12.6681 15.2542 12.3375Z",
      "M6.825 19.95C7.81667 19.1917 8.925 18.5938 10.15 18.1563C11.375 17.7188 12.6583 17.5 14 17.5C15.3417 17.5 16.625 17.7188 17.85 18.1563C19.075 18.5938 20.1833 19.1917 21.175 19.95C21.8556 19.1528 22.3854 18.2486 22.7646 17.2375C23.1438 16.2264 23.3333 15.1472 23.3333 14C23.3333 11.4139 22.4243 9.21181 20.6063 7.39375C18.7882 5.57569 16.5861 4.66667 14 4.66667C11.4139 4.66667 9.21181 5.57569 7.39375 7.39375C5.57569 9.21181 4.66667 11.4139 4.66667 14C4.66667 15.1472 4.85625 16.2264 5.23542 17.2375C5.61458 18.2486 6.14444 19.1528 6.825 19.95ZM11.0979 13.9854C10.3104 13.1979 9.91667 12.2306 9.91667 11.0833C9.91667 9.93611 10.3104 8.96875 11.0979 8.18125C11.8854 7.39375 12.8528 7 14 7C15.1472 7 16.1146 7.39375 16.9021 8.18125C17.6896 8.96875 18.0833 9.93611 18.0833 11.0833C18.0833 12.2306 17.6896 13.1979 16.9021 13.9854C16.1146 14.7729 15.1472 15.1667 14 15.1667C12.8528 15.1667 11.8854 14.7729 11.0979 13.9854ZM14 25.6667C12.3861 25.6667 10.8694 25.3604 9.45 24.7479C8.03056 24.1354 6.79583 23.3042 5.74583 22.2542C4.69583 21.2042 3.86458 19.9694 3.25208 18.55C2.63958 17.1306 2.33333 15.6139 2.33333 14C2.33333 12.3861 2.63958 10.8694 3.25208 9.45C3.86458 8.03056 4.69583 6.79583 5.74583 5.74583C6.79583 4.69583 8.03056 3.86458 9.45 3.25208C10.8694 2.63958 12.3861 2.33333 14 2.33333C15.6139 2.33333 17.1306 2.63958 18.55 3.25208C19.9694 3.86458 21.2042 4.69583 22.2542 5.74583C23.3042 6.79583 24.1354 8.03056 24.7479 9.45C25.3604 10.8694 25.6667 12.3861 25.6667 14C25.6667 15.6139 25.3604 17.1306 24.7479 18.55C24.1354 19.9694 23.3042 21.2042 22.2542 22.2542C21.2042 23.3042 19.9694 24.1354 18.55 24.7479C17.1306 25.3604 15.6139 25.6667 14 25.6667Z",
    ],
    "album": [
      "M3.5 8.17V22.17C3.5 23.46 4.54 24.5 5.83 24.5H19.83V22.17H5.83V8.17ZM9.83 3.5H22.17C23.46 3.5 24.5 4.54 24.5 5.83V17.67C24.5 18.96 23.46 20 22.17 20H9.83C8.54 20 7.5 18.96 7.5 17.67V5.83C7.5 4.54 8.54 3.5 9.83 3.5ZM9.83 5.83V17.67H22.17V5.83ZM11.08 16.33 14.58 11.67 17.21 15.17 19 12.83 21.08 16.33Z",
      "M3.5 8.17V22.17C3.5 23.46 4.54 24.5 5.83 24.5H19.83V22.17H5.83V8.17ZM9.83 3.5H22.17C23.46 3.5 24.5 4.54 24.5 5.83V17.67C24.5 18.96 23.46 20 22.17 20H9.83C8.54 20 7.5 18.96 7.5 17.67V5.83C7.5 4.54 8.54 3.5 9.83 3.5ZM11.08 16.33 14.58 11.67 17.21 15.17 19 12.83 21.08 16.33Z",
    ],
  };

  function navIconSvg(id) {
    const [outline, filled] = NAV_ICONS[id] || NAV_ICONS.home;
    const rule = id === "album" ? ' fill-rule="evenodd"' : "";
    return `<svg class="nav-icon" viewBox="0 0 28 28" aria-hidden="true" focusable="false"><path class="nav-icon-outline"${rule} d="${outline}" /><path class="nav-icon-filled"${rule} d="${filled}" /></svg>`;
  }

  function navItemHtml(id, href, label, current, extra) {
    return `<a class="nav-item" href="${href}"${extra || ""}${id === current ? ' aria-current="page"' : ""}>${navIconSvg(id)}<span>${label}</span></a>`;
  }

  function parentNavItems() {
    return [
      { id: "home", href: "parent.html#today", label: "Home" },
      { id: "schedule", href: "schedule.html?as=parent", label: "Schedule" },
      { id: "care-log", href: "care-log.html?as=parent", label: "Care Log" },
      // The parent's saved photos (photo_saves), shown by parent.js at #album.
      { id: "album", href: "parent.html#album", label: "Album" },
      { id: "children", href: "children.html?as=parent", label: "Children" },
      { id: "profile", href: "profile.html?as=parent", label: "Profile" },
    ];
  }

  // Parent-side primary nav (static markup only).
  function renderParentNav(current) {
    const nav = document.querySelector(".primary-nav");
    if (!nav) return;
    nav.setAttribute("aria-label", "Parent navigation");
    nav.innerHTML = parentNavItems()
      .map((item) => navItemHtml(item.id, item.href, item.label, current, ` data-nav="${item.id}"`))
      .join("");
  }

  // The five primary destinations match the product's information architecture.
  // Secondary content stays inside these areas instead of competing in the main bar.
  // index.html carries a static copy of this markup for first paint; keep the two in sync.
  function renderSitterNav(current) {
    const nav = document.querySelector(".primary-nav");
    if (!nav) return;
    const items = [
      ["home", "index.html", "Home"],
      ["schedule", "schedule.html", "Schedule"],
      ["care-log", "care-log.html", "Care Log"],
      ["children", "children.html", "Children"],
      ["profile", "profile.html", "Profile"],
    ];
    nav.innerHTML = items.map(([id, href, label]) => navItemHtml(id, href, label, current)).join("");
  }

  // Shared helpers for js/parent.js.
  window.CareNestUI = {
    escapeHtml,
    announce,
    formatTime,
    shortTime,
    senderName,
    photoTitle,
    photoImg,
    avatarHtml,
    renderParentNav,
    renderSitterNav,
    isDevHost,
  };

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
