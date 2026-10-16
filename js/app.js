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
  // The shift backend (js/shift-data.js): Supabase when signed in, the localStorage store in demo.
  let shift = null;

  const SHIFT_LOCKED_TEXT = "This shift has ended. Photos can't be added after a shift.";
  const isDevHost =
    ["localhost", "127.0.0.1", "[::1]", ""].includes(window.location.hostname) ||
    demoFlag();
  // Until real accounts exist, the parent side is the same app opened as parent.html or
  // messages.html?as=parent (a second tab in the same browser stays in sync via the store).
  const role =
    page === "parent" ||
    ((page === "messages" || page === "gallery") && new URLSearchParams(window.location.search).get("as") === "parent")
      ? "parent"
      : "sitter";
  if (role === "parent") document.body.dataset.role = "parent";

  // ?demo=1 turns on the demo/dev controls for this browser tab (e.g. on the deployed site).
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
    if ((page === "home" || page === "messages") && window.CareNestShift) {
      window.CareNestShift.ready.then((backend) => {
        shift = backend;
        if (page === "home") {
          initHome();
          initDayNotes(ctx);
        } else initMessages();
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
    initNavigation();
    renderHomeFamily();
    renderShiftControls();
    renderKnowTiles(document.getElementById("know-grid"));
    initModal();
    initCompleteModal();
    initCareLog();
    initEndShiftDialog();
    initShiftButtons();
    renderDevTools();

    shift.subscribe(() => {
      renderShiftControls();
      renderSchedule(document.getElementById("schedule-list"));
      renderCareLog();
      applyShiftLockToCompleteModal();
    });
    onFamilyChange(renderHomeFamily);
  }

  // Everything on the home page drawn from the family's data (sitter, child, schedule, contacts).
  function renderHomeFamily() {
    const profileHeading = document.getElementById("profile-heading");
    if (profileHeading) profileHeading.textContent = `Welcome ${data.babysitter.name}`;
    // The profile card's static markup is the sample sitter; replace it with real data.
    const profileAvatar = document.querySelector(".profile-avatar");
    if (profileAvatar) {
      profileAvatar.outerHTML = avatarHtml(data.babysitter.avatar, data.babysitter.name, "profile-avatar", 56);
    }
    const profileAddress = document.querySelector(".profile-address");
    if (profileAddress) {
      profileAddress.textContent = data.babysitter.address || "";
      profileAddress.hidden = !data.babysitter.address;
    }
    renderSitterHeader(document.getElementById("sitter-header"));
    renderShift();
    renderSchedule(document.getElementById("schedule-list"));
    renderCareLog();
    renderEmergencyEntry(document.getElementById("emergency-entry"));
    renderContacts(document.getElementById("contacts-list"));
  }

  // ---------- care log (SI-28): completed tasks in check-time order with their details ----------

  function initCareLog() {
    const list = document.getElementById("care-log-list");
    if (!careLog || !list) return;
    careLog.initModal({ shift, ageLabel: () => data.child.age, announce });
    list.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-log-task]");
      if (btn) careLog.openModal(careLogTask(btn.dataset.logTask), btn);
    });
  }

  function renderCareLog() {
    const list = document.getElementById("care-log-list");
    if (!careLog || !list) return;
    list.innerHTML = careLog.timelineHtml(shift.state, { canAdd: shift.state.canLog, schedule: data.schedule });
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

  function dayNoteHtml(note) {
    const category = DAY_NOTE_CATEGORIES.find((c) => c.key === note.category) || DAY_NOTE_CATEGORIES[4];
    const updated = note.updatedAt > note.createdAt
      ? `<span class="badge day-note-updated">Updated ${escapeHtml(clockLabel(note.updatedAt))}</span>`
      : "";
    const head = `<span class="tag-chip day-note-chip day-note-chip--${escapeHtml(category.key)}">${escapeHtml(category.label)}</span>
      <span class="day-note-title">${escapeHtml(note.title)}</span>${updated}`;
    if (!note.detail) {
      return `<li class="day-note"><div class="day-note-summary day-note-plain">${head}</div></li>`;
    }
    return `<li class="day-note">
      <details class="day-note-details" data-note-id="${escapeHtml(note.id)}">
        <summary class="day-note-summary">${head}</summary>
        <p class="day-note-detail">${escapeHtml(note.detail)}</p>
      </details>
    </li>`;
  }

  function initDayNotes(ctx) {
    const listEl = document.getElementById("day-notes-list");
    const statusEl = document.getElementById("day-notes-status");
    const dateEl = document.getElementById("day-notes-date");
    if (!listEl || !statusEl) return;

    const live = Boolean(ctx && !ctx.demo && ctx.client && ctx.household && !shift.demo);
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
      shownIds = new Set(groups.flatMap((g) => g.notes.map((n) => n.id)));
      listEl.innerHTML =
        dates.length === 1
          ? groups.map((g) => g.notes.map(dayNoteHtml).join("")).join("")
          : groups
              .map(
                (g) => `<li class="day-notes-group">
      <h3 class="day-notes-group-title">${escapeHtml(g.date === dates[0] ? "Today" : dateLabel(g.date))}</h3>
      <ul class="day-notes-list">${g.notes.map(dayNoteHtml).join("")}</ul>
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
    // RLS limits the stream to this household. Realtime cannot filter DELETE events by column,
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
  }

  function initNavigation() {
    const links = Array.from(document.querySelectorAll(".primary-nav .nav-item"));
    if (!links.length) return;

    const updateCurrentPage = () => {
      const hash = window.location.hash || "#home";
      links.forEach((link) => {
        if (link.getAttribute("href") === hash) {
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
        ${item.image ? `<img class="restriction-thumb" src="${escapeHtml(item.image)}" alt="" width="64" height="64" />` : ""}
        <div class="restriction-content">
          <div class="restriction-top">
            <h3 class="restriction-name">${escapeHtml(item.name)}</h3>
            ${item.severity ? `<span class="badge ${escapeHtml(item.severityClass || "")}">${escapeHtml(item.severity)}</span>` : ""}
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

  function renderInfoItems(items) {
    if (!items || !items.length) return "";
    return `
      <section class="panel">
        <ul class="info-list">
          ${items
            .map(
              (item) => `
            <li class="info-item">
              <h2 class="info-item-title">${escapeHtml(item.title)}</h2>
              ${item.detail ? `<p class="info-item-detail">${escapeHtml(item.detail)}</p>` : ""}
            </li>`
            )
            .join("")}
        </ul>
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
    const address = !hospital.address
      ? ""
      : hospital.mapHref
      ? `<a class="hospital-address" href="${escapeHtml(hospital.mapHref)}" target="_blank" rel="noopener">${escapeHtml(hospital.address)}<span class="visually-hidden"> (opens map in a new tab)</span></a>`
      : `<p class="hospital-address">${escapeHtml(hospital.address)}</p>`;
    return `
      <section class="panel" aria-labelledby="hospital-heading">
        <h2 class="panel-title" id="hospital-heading">Hospital</h2>
        <div class="card hospital-card">
          <div class="hospital-meta">
            <p class="contact-name">${escapeHtml(hospital.name)}</p>
            ${hospital.system ? `<p class="hospital-system">${escapeHtml(hospital.system)}</p>` : ""}
            ${address ? `<div class="modal-location">
              <img src="assets/location.svg" alt="" width="16" height="16" />
              ${address}
            </div>` : ""}
            ${hospital.phone ? `<p class="contact-phone">${escapeHtml(hospital.phone)}</p>` : ""}
          </div>
          ${callBtn}
        </div>
      </section>`;
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
        <div class="contacts-list">
          ${resolved
            .map((contact) => {
              const avatar = avatarHtml(contact.avatar, contact.name, "contact-avatar", 35);
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
      </a>`;
  }

  function renderSitterHeader(el) {
    if (!el) return;
    const sitter = data.babysitter;
    el.innerHTML = `
      ${avatarHtml(sitter.avatar, sitter.name, "sitter-avatar", 39)}
      <div class="sitter-meta">
        <p class="sitter-welcome">Welcome ${escapeHtml(sitter.name)}</p>
        ${sitter.address ? `<p class="sitter-address">${escapeHtml(sitter.address)}</p>` : ""}
      </div>`;
  }

  function renderShift() {
    const cardEl = document.getElementById("shift-card");
    if (!cardEl) return;

    const child = data.child;
    cardEl.innerHTML = `
      <div class="shift-timing">
        <p class="shift-date">${escapeHtml(child.dateLabel)}</p>
        ${child.shiftTime ? `<p class="shift-hours">${escapeHtml(child.shiftTime)}</p>` : ""}
      </div>
      <div class="shift-child">
        ${avatarHtml(child.avatar, child.name, "shift-avatar", 60)}
        <div class="shift-meta">
          <p class="shift-name">${escapeHtml(child.name)}</p>
          ${child.age ? `<p class="shift-age">${escapeHtml(child.age)}</p>` : ""}
        </div>
      </div>`;
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

    if (!items.length) {
      el.innerHTML = `<li>${emptyStateHtml("")}</li>`;
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
    if (!st.visit) return "Start your shift to check off tasks.";
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

  function renderContacts(el) {
    if (!el) return;
    if (!data.contacts.length) {
      el.innerHTML = emptyStateHtml();
      return;
    }
    el.innerHTML = data.contacts
      .map(
        (contact) => `
      <article class="contact-card">
        ${avatarHtml(contact.avatar, contact.name, "contact-avatar", 35)}
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
  // accounts only a parent can move the moment (trigger_moment_now), from messages.html?as=parent.
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
        <a class="photo-source-btn dev-link" href="parent.html" target="_blank" rel="noopener">Open parent view<span class="visually-hidden"> (opens in a new tab)</span></a>
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

  // Parent side of messages.html, signed in, on localhost: move this shift's moment prompt to
  // 1-5 minutes from now (trigger_moment_now; the database refuses sitters).
  function renderParentMomentTrigger(host) {
    if (!isDevHost || shift.demo || role !== "parent" || !host) return;
    const box = document.createElement("section");
    box.className = "panel dev-tools";
    box.innerHTML = `
      <h2 class="panel-title">Demo tools (not part of the product)</h2>
      <div class="dev-tools-actions">
        <button type="button" class="photo-source-btn" data-dev="parent-moment">Trigger the sitter's moment (1–5 min)</button>
      </div>
      <p class="photo-upload-error" role="alert" hidden></p>`;
    const err = box.querySelector("[role=alert]");
    box.querySelector("button").addEventListener("click", () => {
      err.hidden = true;
      shift
        .triggerMomentNow()
        .then(() => announce("The sitter's moment prompt will appear within 5 minutes."))
        .catch((e) => {
          err.textContent = shift.errorMessage(e);
          err.hidden = false;
        });
    });
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

  function messageMeta(message) {
    const iso = new Date(message.sentAt).toISOString();
    return `<p class="msg-meta">${escapeHtml(senderName(message.sender))} · <time datetime="${iso}">${escapeHtml(formatTime(message.sentAt))}</time></p>`;
  }

  // Label for a task_proof/moment message, e.g. "Snack" or "Moment".
  function photoTitle(message) {
    if (!message) return "Photo";
    if (message.kind === "moment") return "Moment";
    const task = data.schedule.find((s) => s.id === message.taskId);
    return task ? task.title : "Task";
  }

  function threadPhotoHtml(message, alt) {
    if (message.photoPath) {
      return `<img class="msg-photo" data-photo-path="${escapeHtml(message.photoPath)}" alt="${escapeHtml(alt)}" />`;
    }
    if (message.photoRemoved) {
      return `<p class="photo-removed">Photo removed by ${escapeHtml(message.photoRemovedByName || "a parent")}</p>`;
    }
    return "";
  }

  function threadMeta(message) {
    const iso = new Date(message.createdAt).toISOString();
    return `<p class="msg-meta">${escapeHtml(message.senderName)} · <time datetime="${iso}">${escapeHtml(formatTime(message.createdAt))}</time></p>`;
  }

  function threadPhotoTitle(message) {
    if (!message) return "an earlier";
    if (message.kind === "moment") return "Moment";
    return message.taskTitle || "Task";
  }

  function renderThreadMessage(message, byId) {
    const side = message.mine ? "is-mine" : "is-theirs";

    if (message.kind === "task_proof") {
      const title = message.taskTitle || "Task";
      return `
        <li class="msg ${side}" id="msg-${escapeHtml(message.id)}">
          <article class="msg-card proof-card" aria-label="Task completed: ${escapeHtml(title)}">
            <p class="msg-card-kicker">
              <img src="assets/check.svg" alt="" width="16" height="16" />
              Task completed
            </p>
            <h2 class="msg-card-title">${escapeHtml(title)}${message.taskTime ? ` <span class="msg-card-time">${escapeHtml(message.taskTime)}</span>` : ""}</h2>
            ${threadPhotoHtml(message, `Photo for ${title}`)}
            ${message.tag ? `<p class="tag-chip">${escapeHtml(message.tag)}</p>` : ""}
            ${message.body ? `<p class="msg-card-note">${escapeHtml(message.body)}</p>` : ""}
            ${threadMeta(message)}
          </article>
        </li>`;
    }

    if (message.kind === "moment") {
      return `
        <li class="msg ${side}" id="msg-${escapeHtml(message.id)}">
          <article class="msg-card moment-card" aria-label="Moment${message.late ? ", late" : ""}">
            <p class="msg-card-kicker">
              Moment
              ${message.late ? `<span class="late-badge">Late</span>` : ""}
            </p>
            ${threadPhotoHtml(message, "Moment photo from the shift")}
            ${message.body ? `<p class="msg-card-note">${escapeHtml(message.body)}</p>` : ""}
            ${threadMeta(message)}
          </article>
        </li>`;
    }

    // Photo message (sent from the gallery): the photo, then the caption if there is one.
    if (message.photoPath || message.photoRemoved) {
      return `
      <li class="msg ${side}" id="msg-${escapeHtml(message.id)}">
        <article class="msg-card photo-msg-card" aria-label="Photo from ${escapeHtml(message.senderName)}">
          ${threadPhotoHtml(message, `Photo message from ${message.senderName}`)}
          ${message.body ? `<p class="msg-card-note">${escapeHtml(message.body)}</p>` : ""}
          ${threadMeta(message)}
        </article>
      </li>`;
    }

    const target = message.replyTo ? byId[message.replyTo] : null;
    const replyRef = message.replyTo
      ? target
        ? `<a class="msg-reply-ref" href="#msg-${escapeHtml(message.replyTo)}">Reply to ${escapeHtml(threadPhotoTitle(target))} photo</a>`
        : `<span class="msg-reply-ref">Reply to an earlier photo</span>`
      : "";
    return `
      <li class="msg ${side}">
        <div class="msg-bubble">
          ${replyRef}
          <p class="msg-body">${escapeHtml(message.body)}</p>
        </div>
        ${threadMeta(message)}
      </li>`;
  }

  function initMessages() {
    const list = document.getElementById("message-list");
    const form = document.getElementById("message-form");
    const input = document.getElementById("message-input");
    const error = document.getElementById("message-error");
    const title = document.getElementById("messages-title");
    const sendBtn = form.querySelector('button[type="submit"]');
    // The other person in the thread, from the viewer's side (re-read when family data changes).
    let parentName;
    const renderNames = () => {
      parentName = role === "parent" ? data.babysitter.name : parentFirstName();
      if (title) title.textContent = `Messages with ${parentName}`;
      if (input) input.placeholder = `Message ${parentName}`;
      const label = document.querySelector('label[for="message-input"]');
      if (label) label.textContent = `Message to ${parentName}`;
    };
    renderNames();
    if (role === "parent") renderParentNav("messages");
    renderParentMomentTrigger(document.querySelector(".messages-main"));

    let lastCount = -1;
    const render = () => {
      const st = shift.state;
      const messages = st.thread;
      const byId = {};
      messages.forEach((m) => {
        byId[m.id] = m;
      });
      list.innerHTML = st.loadError
        ? `<li class="empty-state msg-empty"><p>${escapeHtml(st.loadError)}</p></li>`
        : messages.length
        ? messages.map((m) => renderThreadMessage(m, byId)).join("")
        : `<li class="empty-state msg-empty"><p>No messages yet. Say hi to ${escapeHtml(parentName)}!</p></li>`;
      hydratePhotos(list);
      const lock = document.getElementById("messages-locked");
      if (lock) lock.hidden = role === "parent" || !(st.ended || st.tooOld);
      if (messages.length !== lastCount) {
        lastCount = messages.length;
        const last = list.lastElementChild;
        if (last) last.scrollIntoView({ block: "end" });
      }
    };

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      error.hidden = true;
      if (!input.value.trim()) {
        error.textContent = "Type a message first.";
        error.hidden = false;
        input.focus();
        return;
      }
      sendBtn.disabled = true;
      shift
        .sendChat(input.value)
        .then(() => {
          input.value = "";
          announce(`Message sent to ${parentName}.`);
        })
        .catch((err) => {
          error.textContent = shift.errorMessage(err);
          error.hidden = false;
        })
        .finally(() => {
          sendBtn.disabled = false;
          input.focus();
        });
    });

    shift.subscribe(render);
    render();
    onFamilyChange(() => {
      renderNames();
      render();
    });
  }

  function openModal(item, opener) {
    const overlay = document.getElementById("activity-modal");
    if (!overlay) return;
    returnFocusEl = opener || document.activeElement;

    overlay.querySelector("[data-modal-time]").textContent = item.time;
    overlay.querySelector("[data-modal-date]").textContent = data.child.dateLabel;
    overlay.querySelector("[data-modal-title]").textContent = item.title;

    const mapEl = overlay.querySelector("[data-modal-map]");
    if (item.map) {
      mapEl.src = item.map;
      mapEl.hidden = false;
    } else {
      mapEl.hidden = true;
      mapEl.removeAttribute("src");
    }

    const locationEl = overlay.querySelector("[data-modal-location]");
    const locationText = overlay.querySelector("[data-modal-location-text]");
    const detailEl = overlay.querySelector("[data-modal-detail]");

    if (item.location) {
      locationText.textContent = item.location;
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
          const photoNote = item.check && item.check.proof ? " The photo message stays in Messages." : "";
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

  // A function (not a const) because initMessages runs before this line is reached.
  function parentNavItems() {
    return [
    {
      id: "today",
      href: "parent.html#today",
      label: "Today",
      icon: '<path d="m12 3 9 7.5V21h-6v-6H9v6H3v-10.5L12 3Z" />',
    },
    {
      id: "album",
      href: "parent.html#album",
      label: "Album",
      icon: '<path d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2ZM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5Z" />',
    },
    {
      id: "gallery",
      href: "gallery.html?as=parent",
      label: "Gallery",
      icon: '<path d="M22 16V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2Zm-11-4 2.03 2.71L16 11l4 5H8l3-4ZM2 6v14a2 2 0 0 0 2 2h14v-2H4V6H2Z" />',
    },
    {
      id: "messages",
      href: "messages.html?as=parent",
      label: "Messages",
      icon: '<path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8.4L4.6 21.2A1 1 0 0 1 3 20.4V5a2 2 0 0 1 1-2Zm3 6a1.25 1.25 0 1 0 0 2.5A1.25 1.25 0 0 0 7 9Zm5 0a1.25 1.25 0 1 0 0 2.5A1.25 1.25 0 0 0 12 9Zm5 0a1.25 1.25 0 1 0 0 2.5A1.25 1.25 0 0 0 17 9Z" />',
    },
    {
      id: "manage",
      href: "manage.html",
      label: "Family info",
      icon: '<path d="M14.06 4.94 19.06 9.94 8 21H3v-5L14.06 4.94Zm1.41-1.41 1.42-1.42a2 2 0 0 1 2.83 0l2.17 2.17a2 2 0 0 1 0 2.83l-1.42 1.42-5-5Z" />',
    },
    {
      id: "people",
      href: "people.html",
      label: "People",
      icon: '<path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8-1a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM9 13c-3.87 0-7 2.24-7 5v3h14v-3c0-2.76-3.13-5-7-5Zm8.24.05c-.45-.03-.91-.05-1.38-.05a11.5 11.5 0 0 0-2.66.3c1.73.96 2.8 2.37 2.8 4V21H22v-3c0-2.42-2.1-4.47-4.76-4.95Z" />',
    },
  ];
  }

  // Parent-side primary nav (static markup only).
  function renderParentNav(current) {
    const nav = document.querySelector(".primary-nav");
    if (!nav) return;
    nav.setAttribute("aria-label", "Parent navigation");
    const account = nav.querySelector("[data-account-button]"); // added by js/auth.js
    nav.innerHTML = parentNavItems().map(
      (item) => `
        <a class="nav-item" href="${item.href}" data-nav="${item.id}"${item.id === current ? ' aria-current="page"' : ""}>
          <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">${item.icon}</svg>
          <span>${item.label}</span>
        </a>`
    ).join("");
    if (account) nav.appendChild(account);
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
    renderParentNav,
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
