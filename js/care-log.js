// CareNestCareLog — care details logged under completed tasks (SI-28 "Logging Care Details").
//
// Shared by the sitter home (index.html: the log modal, the activity modal), the parent home
// (parent.html: a read-only Care log), and the Care Log page (care-log.html, js/care-log-page.js:
// the current session's entries about each child, SI-63). Data comes from js/shift-data.js:
// state.checks (completed tasks) and state.logs (append-only entries, oldest first), and new
// entries go through backend.addCareLog(), which checks the same rules again (the database has
// the final say through CHECK constraints and the stamp_care_log trigger).
//
// Pure helpers (parseAgeMonths, categoriesFor, validate, timeline) have no DOM dependency so
// tests/care-log-age.test.mjs can load this file in Node.
//
// Load order: before js/shift-data.js (its backends call validate()).
(function (root) {
  const MAX_NOTE = 1000;
  const BABY_UNDER_MONTHS = 24;
  const MESSAGES = {
    empty: "No information provided",
    bottleRange: "Enter between 0.5 and 16 oz.",
    noteTooLong: `Keep the note to ${MAX_NOTE} characters or fewer.`,
    entryChild: "Choose which child this entry is about.",
    entryNoChildren: "This family space has no children yet, so there is no one to log about.",
    entryNote: "Write what happened before saving.",
  };
  const CATEGORY_LABELS = { meal: "Meal", bottle: "Bottle", care: "Care" };
  // A Care Log page entry (care_logs.category 'note'): about a child, not tied to a task.
  const ENTRY_CATEGORY = "note";
  const AMOUNT_LABELS = { all: "Ate all", most: "Ate most", some: "Ate some", none: "Ate none" };
  const AMOUNTS = ["all", "most", "some", "none"];

  // ---------------------------------------------------------------- age

  // Months from a free-text age label (households.child_age_label): "Age 3", "8 months",
  // "18 mo", "1 year", "2.5 yrs", "1 year 6 months", "newborn". A number with no unit is years
  // ("Age 3"). Returns null when the label says nothing we can read.
  const UNIT_MONTHS = { y: 12, m: 1, w: 12 / 52, d: 12 / 365 };
  const AGE_PART =
    /(\d+(?:\.\d+)?)\s*(years?|yrs?|y\.?o\.?|y|months?|mos?|mths?|m|weeks?|wks?|w|days?|d)?(?![a-z])/g;

  function parseAgeMonths(label) {
    const text = String(label == null ? "" : label).trim().toLowerCase();
    if (!text) return null;
    if (/\b(newborn|infant|baby)\b/.test(text)) return 0;
    let total = 0;
    let found = false;
    let match;
    AGE_PART.lastIndex = 0;
    while ((match = AGE_PART.exec(text))) {
      const value = Number(match[1]);
      if (!Number.isFinite(value)) continue;
      const unit = match[2] ? match[2].charAt(0) : "y";
      total += value * UNIT_MONTHS[unit];
      found = true;
    }
    return found ? Math.round(total * 10) / 10 : null;
  }

  // Which categories to offer, in order. Babies (under 2) get Bottle first; a child known to be
  // 2 or older gets no Bottle; when the age is unknown all three are offered.
  function categoriesFor(ageLabel) {
    const months = parseAgeMonths(ageLabel);
    if (months === null) return ["meal", "bottle", "care"];
    if (months < BABY_UNDER_MONTHS) return ["bottle", "meal", "care"];
    return ["meal", "care"];
  }

  // ---------------------------------------------------------------- validation

  // Returns { error } or { entry } with only the fields the category uses. Mirrors the
  // database's CHECK constraints so the person sees the problem before a round trip.
  function validate(input) {
    const category = input && input.category;
    if (!CATEGORY_LABELS[category]) return { error: MESSAGES.empty };
    const note = String((input && input.note) || "").trim();
    if (note.length > MAX_NOTE) return { error: MESSAGES.noteTooLong };
    if (category === "meal") {
      const amount = AMOUNTS.includes(input.mealAmount) ? input.mealAmount : null;
      if (!amount && !note) return { error: MESSAGES.empty };
      return { entry: { category, note, mealAmount: amount, bottleOz: null } };
    }
    if (category === "bottle") {
      const raw = input.bottleOz;
      const blank = raw === null || raw === undefined || String(raw).trim() === "";
      if (blank) return { error: note ? MESSAGES.bottleRange : MESSAGES.empty };
      const oz = Number(raw);
      if (!Number.isFinite(oz) || oz < 0.5 || oz > 16) return { error: MESSAGES.bottleRange };
      return { entry: { category, note, mealAmount: null, bottleOz: Math.round(oz * 10) / 10 } };
    }
    if (!note) return { error: MESSAGES.empty };
    return { entry: { category, note, mealAmount: null, bottleOz: null } };
  }

  // ---------------------------------------------------------------- timeline

  // Completed tasks of the shift in check-time order, each with its logs oldest first. A task
  // that was unchecked after logs were added keeps its logs (they are a record of what happened)
  // and is placed by its first log.
  function timeline(state, schedule) {
    const checks = (state && state.checks) || {};
    // Care Log page entries (no task) are listed on that page, not under a task.
    const logs = ((state && state.logs) || []).filter((l) => l.taskId).sort((a, b) => a.createdAt - b.createdAt);
    const rows = Object.keys(checks).map((taskId) => {
      const check = checks[taskId];
      return {
        taskId,
        title: (check.snapshot && check.snapshot.title) || "Task",
        check,
        at: check.checkedAt,
        logs: [],
      };
    });
    logs.forEach((log) => {
      let row = rows.find((r) => r.taskId === log.taskId);
      if (!row) {
        const task = (schedule || []).find((t) => t.id === log.taskId);
        row = { taskId: log.taskId, title: (task && task.title) || "Task", check: null, at: log.createdAt, logs: [] };
        rows.push(row);
      }
      row.logs.push(log);
    });
    return rows.sort((a, b) => a.at - b.at);
  }

  function logsFor(state, taskId) {
    return ((state && state.logs) || []).filter((l) => l.taskId && l.taskId === taskId).sort((a, b) => a.createdAt - b.createdAt);
  }

  // ---------------------------------------------------------------- Care Log page (SI-63)

  // A new entry: { childId, note } checked against the family's children (ids). With one child
  // the picker is skipped and that child is used. Mirrors stamp_care_log() and the CHECKs
  // (child_required, child_not_found, care_logs_not_empty, the 1000-character note).
  function validateEntry(input, childIds) {
    const ids = Array.isArray(childIds) ? childIds : [];
    if (!ids.length) return { error: MESSAGES.entryNoChildren };
    const childId = ids.length === 1 ? ids[0] : input && input.childId;
    if (!childId || !ids.includes(childId)) return { error: MESSAGES.entryChild, field: "child" };
    const note = String((input && input.note) || "").trim();
    if (!note) return { error: MESSAGES.entryNote, field: "note" };
    if (note.length > MAX_NOTE) return { error: MESSAGES.noteTooLong, field: "note" };
    return { entry: { childId, note, category: ENTRY_CATEGORY } };
  }

  function firstName(name) {
    return String(name || "").trim().split(/\s+/)[0] || "";
  }

  // Every entry of the session, oldest first: Care Log entries (about a child) and the details
  // logged under completed tasks. children: the family's children ({ id, name }). A child still in
  // that list shows their current name, or "Child" while the name is blank (create_household
  // makes the first child with name ''). A child no longer in it was removed: the entry keeps
  // the name it was written under (care_logs.child_name), else reads "A removed child".
  function sessionEntries(state, children, schedule) {
    const kids = children || [];
    const checks = (state && state.checks) || {};
    return ((state && state.logs) || [])
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((log) => {
        const child = log.childId ? kids.find((c) => c.id === log.childId) : null;
        const childName = String((child ? child.name : log.childName) || "").trim();
        const childLabel = childName ? firstName(childName) : child ? "Child" : "A removed child";
        let taskTitle = null;
        if (log.taskId) {
          const check = checks[log.taskId];
          const task = (schedule || []).find((t) => t.id === log.taskId);
          taskTitle = (check && check.snapshot && check.snapshot.title) || (task && task.title) || "Task";
        }
        const facts = [];
        if (log.category === "meal" && log.mealAmount) facts.push(AMOUNT_LABELS[log.mealAmount] || "");
        if (log.category === "bottle" && log.bottleOz != null) facts.push(formatOz(log.bottleOz));
        return {
          id: log.id,
          kind: log.taskId ? "task" : "entry",
          childName,
          childFirst: firstName(childName),
          childLabel,
          childRemoved: !child,
          taskTitle,
          category: log.category,
          facts: facts.filter(Boolean),
          note: log.note || "",
          authorName: log.authorName || "",
          createdAt: log.createdAt,
        };
      });
  }

  function initialsOf(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2);
    return letters.toUpperCase();
  }

  // The list on the Care Log page. Each entry shows its child (or the task it is about), the
  // content, and the time.
  function sessionLogHtml(entries) {
    return entries
      .map((e) => {
        const iso = new Date(e.createdAt).toISOString();
        const badge =
          e.kind === "task"
            ? `<span class="session-log-badge session-log-badge--task" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M9.6 16.2 5.4 12l-1.4 1.4 5.6 5.6 12-12-1.4-1.4z" fill="currentColor"/></svg></span>`
            : `<span class="session-log-badge" aria-hidden="true">${escapeHtml(initialsOf(e.childName))}</span>`;
        const subject =
          e.kind === "task"
            ? `${escapeHtml(e.taskTitle)}<span class="session-log-kind"> · ${escapeHtml(CATEGORY_LABELS[e.category] || "Care")}</span>`
            : escapeHtml(e.childLabel);
        const about = e.childName || (e.childRemoved ? "a removed child" : "your child");
        const label = e.kind === "task" ? `Task details: ${e.taskTitle}` : `Entry about ${about}`;
        return `<li class="session-log-entry" data-entry-id="${escapeHtml(e.id)}">
          <article class="session-log-card" aria-label="${escapeHtml(label)}">
            <div class="session-log-entry-head">
              ${badge}
              <p class="session-log-subject">${subject}</p>
              <time class="session-log-time" datetime="${iso}">${escapeHtml(shortTime(e.createdAt))}</time>
            </div>
            ${e.facts.length ? `<p class="session-log-fact">${escapeHtml(e.facts.join(" · "))}</p>` : ""}
            ${e.note ? `<p class="session-log-text">${escapeHtml(e.note)}</p>` : ""}
            ${e.authorName ? `<p class="session-log-author">By ${escapeHtml(e.authorName)}</p>` : ""}
          </article>
        </li>`;
      })
      .join("");
  }

  // ---------------------------------------------------------------- rendering

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // "5:02pm"
  function shortTime(ms) {
    return new Date(ms)
      .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      .replace(/\s*([AaPp])\.?\s*[Mm]\.?$/, (m, ap) => `${ap.toLowerCase()}m`);
  }

  function formatOz(oz) {
    return `${Number(oz).toLocaleString([], { maximumFractionDigits: 1 })} oz`;
  }

  // Entries under one task. Later entries are labelled "Update" (an edit never rewrites the
  // earlier entry or the task's own time).
  function entriesHtml(logs) {
    if (!logs.length) return "";
    return `<ol class="care-log-entries">${logs
      .map((log, i) => {
        const facts = [];
        if (log.category === "meal" && log.mealAmount) facts.push(AMOUNT_LABELS[log.mealAmount] || "");
        if (log.category === "bottle" && log.bottleOz != null) facts.push(formatOz(log.bottleOz));
        const iso = new Date(log.createdAt).toISOString();
        return `<li class="care-log-entry">
          <p class="care-log-entry-head"><span class="care-log-cat">${escapeHtml(CATEGORY_LABELS[log.category] || "Care")}</span>${
            i > 0 ? `<span class="care-log-update">Update</span>` : ""
          }${facts.length ? `<span class="care-log-fact">${escapeHtml(facts.join(" · "))}</span>` : ""}</p>
          ${log.note ? `<p class="care-log-note">${escapeHtml(log.note)}</p>` : ""}
          <p class="schedule-check-meta"><time datetime="${iso}">${escapeHtml(shortTime(log.createdAt))}</time><span>${escapeHtml(log.authorName || "")}</span></p>
        </li>`;
      })
      .join("")}</ol>`;
  }

  function addButtonHtml(taskId, title, hasLogs) {
    const label = hasLogs ? "Add update" : "Add details";
    return `<button type="button" class="photo-source-btn care-log-add" data-log-task="${escapeHtml(taskId)}" aria-label="${escapeHtml(`${label} for ${title}`)}">${label}</button>`;
  }

  // The whole Care log list. opts.canAdd shows the add buttons (sitter, shift in the window).
  function timelineHtml(state, opts) {
    const options = opts || {};
    const rows = timeline(state, options.schedule);
    if (!rows.length) return `<p class="people-sub care-log-empty">No tasks completed yet.</p>`;
    return `<ol class="care-log-list">${rows
      .map((row) => {
        const meta = row.check
          ? `<span>Done by ${escapeHtml(row.check.checkedByName || "")}</span>`
          : `<span>No longer checked off</span>`;
        const time = row.check
          ? `<time class="parent-task-time" datetime="${new Date(row.at).toISOString()}">${escapeHtml(shortTime(row.at))}</time>`
          : "";
        return `<li class="care-log-task">
          <div class="care-log-task-head">
            <div class="care-log-task-main">
              <p class="parent-task-title">${time}${time ? " " : ""}${escapeHtml(row.title)}</p>
              <p class="schedule-check-meta">${meta}</p>
            </div>
            ${options.canAdd && row.check ? addButtonHtml(row.taskId, row.title, row.logs.length > 0) : ""}
          </div>
          ${entriesHtml(row.logs)}
        </li>`;
      })
      .join("")}</ol>`;
  }

  // ---------------------------------------------------------------- log modal (sitter page)

  let modal = null; // { overlay, shift, ageLabel, announce, task, returnFocus, onSaved }

  function initModal(options) {
    const overlay = document.getElementById("log-modal");
    if (!overlay || modal) return;
    modal = Object.assign({ overlay, task: null, returnFocus: null }, options);
    const form = overlay.querySelector("#log-form");
    overlay.querySelector("[data-close-log]").addEventListener("click", () => closeModal());
    overlay.querySelector("[data-log-skip]").addEventListener("click", () => closeModal());
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && overlay.classList.contains("is-open")) closeModal();
    });
    form.addEventListener("change", (e) => {
      if (e.target.name === "log-category") showCategory(e.target.value);
      if (e.target.name === "log-category" || e.target.name === "log-amount") setError("");
    });
    form.addEventListener("input", () => setError(""));
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submit();
    });
  }

  function q(sel) {
    return modal.overlay.querySelector(sel);
  }

  function setError(text) {
    const el = q("#log-error");
    el.textContent = text || "";
    el.hidden = !text;
  }

  const NOTE_LABELS = {
    meal: "What did they eat? (optional)",
    bottle: "Anything else? (optional)",
    care: "What happened?",
  };

  function showCategory(category) {
    q("[data-log-meal]").hidden = category !== "meal";
    q("[data-log-bottle]").hidden = category !== "bottle";
    q("[data-log-note-label]").textContent = NOTE_LABELS[category] || NOTE_LABELS.care;
  }

  // task: { taskId, title, time }. opts.prompt: right after completing the task (shows Skip).
  function openModal(task, opener, opts) {
    if (!modal) return;
    const options = opts || {};
    const st = modal.shift.state;
    const hasLogs = logsFor(st, task.taskId).length > 0;
    modal.task = task;
    modal.returnFocus = opener || document.activeElement;

    q("#log-modal-heading").textContent = options.prompt
      ? "Add details about this task?"
      : hasLogs
        ? "Add an update"
        : "Add details";
    q("[data-log-time]").textContent = task.time || "";
    q("[data-log-title]").textContent = task.title || "";

    const categories = categoriesFor(modal.ageLabel());
    q("[data-log-categories]").innerHTML = categories
      .map(
        (c, i) => `<label class="tag-option"><input type="radio" name="log-category" value="${c}"${i === 0 ? " checked" : ""} /><span>${CATEGORY_LABELS[c]}</span></label>`
      )
      .join("");
    q("#log-form").querySelectorAll('input[name="log-amount"]').forEach((input) => {
      input.checked = false;
    });
    q("#log-oz").value = "";
    q("#log-note").value = "";
    showCategory(categories[0]);
    setError("");
    q("[data-log-skip]").hidden = !options.prompt;
    const save = q("#log-save");
    save.disabled = false;
    save.textContent = "Save details";

    modal.overlay.classList.add("is-open");
    modal.overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    const first = q('input[name="log-category"]:checked');
    if (first) first.focus();
  }

  function closeModal(restoreFocus = true) {
    if (!modal || !modal.overlay.classList.contains("is-open")) return;
    modal.overlay.classList.remove("is-open");
    modal.overlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    const taskId = modal.task && modal.task.taskId;
    modal.task = null;
    let el = modal.returnFocus;
    modal.returnFocus = null;
    if (!restoreFocus) return;
    // The opener is often re-rendered by the save; fall back to the same task's add button.
    if ((!el || !el.isConnected) && taskId && window.CSS && CSS.escape) {
      const id = CSS.escape(taskId);
      el =
        el && el.dataset && el.dataset.scheduleId
          ? document.querySelector(`[data-schedule-id="${id}"]`)
          : document.querySelector(`#care-log-list [data-log-task="${id}"]`);
    }
    if (el && el.isConnected && !el.disabled) el.focus();
  }

  function isOpen() {
    return Boolean(modal && modal.overlay.classList.contains("is-open"));
  }

  function submit() {
    if (!modal || !modal.task) return;
    const form = q("#log-form");
    const category = (form.querySelector('input[name="log-category"]:checked') || {}).value;
    const amount = (form.querySelector('input[name="log-amount"]:checked') || {}).value || null;
    const result = validate({
      category,
      note: q("#log-note").value,
      mealAmount: amount,
      bottleOz: q("#log-oz").value,
    });
    if (result.error) {
      setError(result.error);
      const target =
        category === "bottle"
          ? q("#log-oz")
          : category === "meal"
            ? form.querySelector('input[name="log-amount"]')
            : q("#log-note");
      if (target) target.focus();
      return;
    }
    const task = modal.task;
    const save = q("#log-save");
    save.disabled = true;
    save.textContent = "Saving…";
    modal.shift
      .addCareLog(Object.assign({ taskId: task.taskId }, result.entry))
      .then(() => {
        closeModal();
        if (modal.announce) modal.announce(`Details saved under ${task.title}.`);
      })
      .catch((err) => {
        save.disabled = false;
        save.textContent = "Save details";
        setError(modal.shift.errorMessage(err));
      });
  }

  const api = {
    MAX_NOTE,
    MESSAGES,
    CATEGORY_LABELS,
    AMOUNT_LABELS,
    ENTRY_CATEGORY,
    validateEntry,
    sessionEntries,
    sessionLogHtml,
    initialsOf,
    parseAgeMonths,
    categoriesFor,
    validate,
    timeline,
    logsFor,
    entriesHtml,
    addButtonHtml,
    timelineHtml,
    initModal,
    openModal,
    closeModal,
    isOpen,
  };

  if (root) root.CareNestCareLog = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : null);
