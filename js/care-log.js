// CareNestCareLog — care details logged under completed tasks (SI-28 "Logging Care Details").
//
// Shared by the sitter home (index.html: the Care log section, the log modal, the activity modal)
// and the parent home (parent.html: a read-only Care log). Data comes from js/shift-data.js:
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
  };
  const CATEGORY_LABELS = { meal: "Meal", bottle: "Bottle", care: "Care" };
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
    const logs = ((state && state.logs) || []).slice().sort((a, b) => a.createdAt - b.createdAt);
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
    return ((state && state.logs) || []).filter((l) => l.taskId === taskId).sort((a, b) => a.createdAt - b.createdAt);
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

  // "5:02 PM" (Figma 303:634). Display only: every caller renders the result as text.
  function shortTime(ms) {
    return new Date(ms)
      .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      .replace(/\s*([AaPp])\.?\s*[Mm]\.?$/, (m, ap) => ` ${ap.toUpperCase()}M`);
  }

  function formatOz(oz) {
    return `${Number(oz).toLocaleString([], { maximumFractionDigits: 1 })} oz`;
  }

  // "3:00pm", "3:00 PM", "15:00", "15:00:00" -> "3:00 PM", or "" when unreadable. Display only.
  function clockText(value) {
    const match = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])?\.?\s*m?\.?$/i.exec(String(value || "").trim());
    if (!match) return "";
    let hours = Number(match[1]);
    const period = (match[3] || "").toLowerCase();
    if (period === "p" && hours !== 12) hours += 12;
    if (period === "a" && hours === 12) hours = 0;
    if (hours > 23) return "";
    return `${hours % 12 === 0 ? 12 : hours % 12}:${match[2]} ${hours >= 12 ? "PM" : "AM"}`;
  }

  // Today's session window from the family's schedule (data.appointments), "3:00 PM - 7:00 PM",
  // or "" when there is no session today. With two sessions today, the first one not yet over.
  function shiftWindowText(appointments, now) {
    const current = now || new Date();
    const key = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-${String(current.getDate()).padStart(2, "0")}`;
    const nowText = `${String(current.getHours()).padStart(2, "0")}:${String(current.getMinutes()).padStart(2, "0")}`;
    const to24 = (text) => {
      const m = /^(\d+):(\d{2}) (AM|PM)$/.exec(text);
      if (!m) return "";
      const h = (Number(m[1]) % 12) + (m[3] === "PM" ? 12 : 0);
      return `${String(h).padStart(2, "0")}:${m[2]}`;
    };
    const today = (appointments || [])
      .filter((a) => a && a.date === key && clockText(a.start_time))
      .map((a) => ({ start: clockText(a.start_time), end: clockText(a.end_time) }))
      .sort((a, b) => (to24(a.start) < to24(b.start) ? -1 : 1));
    if (!today.length) return "";
    const pick = today.find((a) => !a.end || to24(a.end) > nowText) || today[today.length - 1];
    return pick.end ? `${pick.start} - ${pick.end}` : pick.start;
  }

  // Small Material-style glyphs (decorative; the text next to them carries the meaning).
  const ICON_PATHS = {
    meal: "M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2v7Zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4Z",
    bottle: "M9 2h6v2h-1v1.1A4 4 0 0 1 17 9v11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9a4 4 0 0 1 3-3.9V4H9V2Zm0 9v2h3v-2H9Zm0 4v2h3v-2H9Z",
    care: "M12 21.35 10.55 20.03C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35Z",
    done: "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17Z",
    clock: "M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2ZM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8Zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7Z",
    alert: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-2h2v2Zm0-4h-2V7h2v6Z",
    check: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9Z",
  };

  function iconSvg(name, size) {
    const px = size || 18;
    return `<svg class="care-log-icon" viewBox="0 0 24 24" width="${px}" height="${px}" aria-hidden="true" focusable="false"><path fill="currentColor" d="${ICON_PATHS[name] || ICON_PATHS.done}"/></svg>`;
  }

  // "Meal • Ate most", "Bottle • 4 oz": the category plus whatever amount was saved.
  function factsText(log) {
    const facts = [CATEGORY_LABELS[log.category] || "Care"];
    if (log.category === "meal" && log.mealAmount) facts.push(AMOUNT_LABELS[log.mealAmount] || "");
    if (log.category === "bottle" && log.bottleOz != null) facts.push(formatOz(log.bottleOz));
    return facts.filter(Boolean).join(" • ");
  }

  // Entries under one task. Later entries are labelled "Update" (an edit never rewrites the
  // earlier entry or the task's own time).
  function entriesHtml(logs) {
    if (!logs.length) return "";
    return `<ol class="care-log-entries">${logs
      .map((log, i) => {
        const iso = new Date(log.createdAt).toISOString();
        return `<li class="care-log-entry">
          <p class="care-log-entry-head"><span class="care-log-fact">${escapeHtml(factsText(log))}</span>${
            i > 0 ? `<span class="care-log-update">Update</span>` : ""
          }</p>
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

  // Timeline rows narrowed to one category (opts.category), keeping only that category's logs.
  // "all" or nothing keeps every row, including completed tasks with no details yet.
  function filteredRows(state, opts) {
    const options = opts || {};
    const rows = timeline(state, options.schedule);
    const category = options.category;
    if (!category || category === "all") return rows;
    return rows
      .map((row) => Object.assign({}, row, { logs: row.logs.filter((l) => l.category === category) }))
      .filter((row) => row.logs.length);
  }

  // The whole Care log list (Figma 303:634): a rail of category dots, one card per completed
  // task with its time on the right and its details below. opts.canAdd shows the add buttons
  // (sitter, shift in the window); opts.category narrows the list (care-log.html filter chips).
  function timelineHtml(state, opts) {
    const options = opts || {};
    const rows = filteredRows(state, options);
    if (!rows.length) {
      const filtered = options.category && options.category !== "all";
      return filtered
        ? `<p class="care-log-empty care-log-empty--filtered">No ${escapeHtml(CATEGORY_LABELS[options.category] || "")} entries yet.</p>`
        : `<p class="care-log-empty">No Entries Logged Yet</p>`;
    }
    return `<ol class="care-log-list">${rows
      .map((row) => {
        const meta = row.check
          ? `<span>Done by ${escapeHtml(row.check.checkedByName || "")}</span>`
          : `<span>No longer checked off</span>`;
        const time = row.check
          ? `<time class="care-log-time" datetime="${new Date(row.at).toISOString()}">${escapeHtml(shortTime(row.at))}</time>`
          : "";
        const icon = row.logs.length ? row.logs[row.logs.length - 1].category : "done";
        return `<li class="care-log-task">
          <span class="care-log-dot" data-category="${escapeHtml(icon)}">${iconSvg(icon, 16)}</span>
          <div class="care-log-item">
            <div class="care-log-task-head">
              <p class="care-log-task-title">${escapeHtml(row.title)}</p>
              ${time}
            </div>
            ${entriesHtml(row.logs)}
            <div class="care-log-task-foot">
              <p class="schedule-check-meta">${meta}</p>
              ${options.canAdd && row.check ? addButtonHtml(row.taskId, row.title, row.logs.length > 0) : ""}
            </div>
          </div>
        </li>`;
      })
      .join("")}</ol>`;
  }

  // ---------------------------------------------------------------- care-log.html page

  // The Care Log tab (Figma 303:634 / 303:886): the current shift's timeline, read-only. Rendered
  // from the same shift state parent.html uses; nothing on this page writes. options:
  // { shift, data, isParent, logHref, galleryHref }
  function mountPage(el, options) {
    const shift = options.shift;
    const data = options.data || {};
    const kids = (typeof window !== "undefined" && window.CareNestChildren) || null;
    let category = "all";

    el.innerHTML = `<header class="schedule-topnav"><h1>Care Log</h1></header>
      <div class="care-log-page">
        <section class="care-log-child-card" aria-label="Current shift" data-cl-child></section>
        <fieldset class="tag-picker care-log-filter">
          <legend class="visually-hidden">Show entries</legend>
          <div class="tag-options" data-cl-chips></div>
        </fieldset>
        <section class="care-log-timeline" aria-labelledby="care-log-timeline-heading">
          <div class="care-log-heading-row">
            <h2 id="care-log-timeline-heading">Shift Timeline</h2>
            <p class="care-log-count" data-cl-count role="status" aria-live="polite"></p>
          </div>
          <div data-cl-list></div>
          <p class="care-log-logged-by" data-cl-by hidden></p>
        </section>
        <nav class="care-log-more" aria-labelledby="care-log-more-heading">
          <h2 id="care-log-more-heading">More</h2>
          <ul>
            <li><a href="${escapeHtml(options.galleryHref)}"><span>Photo updates</span><small>Photos and moments shared with the care team</small></a></li>
            <li class="care-log-more-static"><span>Past sessions</span><small>Review prior care sessions and their shared updates. Coming soon.</small></li>
          </ul>
        </nav>
      </div>`;

    const q = (sel) => el.querySelector(sel);

    function childCardHtml(st) {
      const children = (data.children || []).length ? data.children : [{ name: (data.child && data.child.name) || "Child" }];
      const windowText = shiftWindowText(data.appointments) || (data.child && data.child.shiftTime) || "";
      const live = Boolean(st.active);
      const rows = children
        .map((child, i) => {
          const name = kids ? kids.displayName(child) : child.name || "Child";
          const parts = kids ? kids.displayParts(child) : [];
          return `<li class="care-log-kid">
            <span class="care-log-avatar" aria-hidden="true">${escapeHtml(kids ? kids.initials(name) : name.charAt(0))}</span>
            <div class="care-log-kid-text">
              <p class="care-log-kid-name">${escapeHtml(name)}${
                live && i === 0 ? `<span class="care-log-live" title="Shift in progress"><span class="visually-hidden">Shift in progress</span></span>` : ""
              }</p>
              ${parts.length ? `<p class="care-log-kid-sub">${escapeHtml(parts.join(" • "))}</p>` : ""}
            </div>
          </li>`;
        })
        .join("");
      const status = !st.visit
        ? "No shift started yet"
        : st.ended
          ? "This shift has ended"
          : "";
      let action = "";
      if (!options.isParent) {
        if (st.canLog && st.visit) {
          action = `<a class="care-log-activity-btn" href="${escapeHtml(options.logHref)}">${iconSvg("done", 22)}<span>Log Activity</span></a>
            <p class="care-log-action-hint">Check off a task, then add its details.</p>`;
        } else {
          const reason = !st.visit
            ? "Start today’s shift on Home to log activity."
            : "This shift is too old to add care details.";
          action = `<button type="button" class="care-log-activity-btn" disabled aria-describedby="care-log-action-reason">${iconSvg("done", 22)}<span>Log Activity</span></button>
            <p class="care-log-action-hint" id="care-log-action-reason">${escapeHtml(reason)}</p>`;
        }
      }
      return `<ul class="care-log-kids">${rows}</ul>
        ${windowText ? `<p class="care-log-shift">${iconSvg("clock", 14)}<span>Shift: ${escapeHtml(windowText)}</span></p>` : ""}
        ${status ? `<p class="care-log-shift-status">${escapeHtml(status)}</p>` : ""}
        ${action ? `<div class="care-log-actions">${action}</div>` : ""}`;
    }

    function chipsHtml(st, total) {
      const age = data.child && data.child.age;
      const present = new Set((st.logs || []).map((l) => l.category));
      const offered = new Set(categoriesFor(age).concat([...present]));
      const cats = ["meal", "bottle", "care"].filter((c) => offered.has(c));
      if (category !== "all" && !cats.includes(category)) category = "all";
      const chip = (value, label) =>
        `<label class="tag-option"><input type="radio" name="care-log-filter" value="${value}"${value === category ? " checked" : ""} /><span>${
          value === "all" ? "" : iconSvg(value, 14)
        }${escapeHtml(label)}</span></label>`;
      return chip("all", `All (${total})`) + cats.map((c) => chip(c, CATEGORY_LABELS[c])).join("");
    }

    function render() {
      const st = shift.state;
      if (st.loadError) {
        q("[data-cl-list]").innerHTML = `<p class="locked-note">We couldn’t load this shift’s care log. Reload the page to try again.</p>`;
        return;
      }
      const all = filteredRows(st, { schedule: data.schedule });
      const focused = document.activeElement && document.activeElement.name === "care-log-filter" ? document.activeElement.value : null;
      q("[data-cl-child]").innerHTML = childCardHtml(st);
      q("[data-cl-chips]").innerHTML = chipsHtml(st, all.length);
      if (focused) {
        const again = q(`input[name="care-log-filter"][value="${focused}"]`);
        if (again) again.focus();
      }
      const shown = filteredRows(st, { schedule: data.schedule, category });
      q("[data-cl-count]").textContent = `${shown.length} ${shown.length === 1 ? "entry" : "entries"} logged`;
      q("[data-cl-list]").innerHTML = timelineHtml(st, { schedule: data.schedule, canAdd: false, category });
      const authors = [];
      (st.logs || []).forEach((l) => {
        const label = `${l.authorName || ""} (${l.authorRole === "parent" ? "Parent" : "Sitter"})`;
        if (l.authorName && !authors.includes(label)) authors.push(label);
      });
      const by = q("[data-cl-by]");
      by.textContent = authors.length ? `Logged by: ${authors.join(", ")}` : "";
      by.hidden = !authors.length;
    }

    q("[data-cl-chips]").addEventListener("change", (e) => {
      if (e.target.name !== "care-log-filter") return;
      category = e.target.value;
      render();
    });
    render();
    if (shift.subscribe) shift.subscribe(render);
  }

  // ---------------------------------------------------------------- log modal (sitter page)

  let modal = null; // { overlay, shift, ageLabel, children, shiftWindow, announce, task, returnFocus }

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

  // The note's prompt (now the placeholder under "Caregiver Notes & Details") and whether
  // validate() needs it: Care needs a note; Meal and Bottle have their amount.
  const NOTE_PROMPTS = {
    meal: "What did they eat?",
    bottle: "Anything else?",
    care: "What happened?",
  };

  function saveLabel(category) {
    return `Log ${CATEGORY_LABELS[category] || "Care"} Entry`;
  }

  function currentCategory() {
    return (q('input[name="log-category"]:checked') || {}).value || "care";
  }

  function setSaveText(text) {
    q("#log-save-text").textContent = text;
  }

  // The severe food items per child, for the Allergy Safety Notice (Figma 303:1139).
  function allergyHtml() {
    const kids = window.CareNestChildren;
    const children = (modal.children && modal.children()) || [];
    if (!kids) return "";
    const lines = children
      .map((child) => ({ name: kids.firstName(child), items: kids.severeAllergies(child) }))
      .filter((c) => c.items.length)
      .map((c) => `${escapeHtml(c.name)} is strictly ${c.items.map((i) => `<strong>${escapeHtml(i)}</strong>`).join(" &amp; ")}.`);
    return lines.length
      ? `<span class="care-log-allergy-icon">${iconSvg("alert", 24)}</span>
        <div><p class="care-log-allergy-title">Allergy Safety Notice <span class="care-log-severe">Severe</span></p>
        <p class="care-log-allergy-text">${lines.join(" ")} Always verify kitchen ingredients and packaging labels prior to serving.</p></div>`
      : "";
  }

  function showCategory(category) {
    q("[data-log-meal]").hidden = category !== "meal";
    q("[data-log-bottle]").hidden = category !== "bottle";
    q("#log-note").placeholder = NOTE_PROMPTS[category] || NOTE_PROMPTS.care;
    q("[data-log-note-hint]").textContent = category === "care" ? "Required" : "Optional";
    const notice = q("[data-log-allergy]");
    const html = category === "meal" || category === "bottle" ? allergyHtml() : "";
    notice.innerHTML = html;
    notice.hidden = !html;
    const save = q("#log-save");
    if (!save.disabled) setSaveText(saveLabel(category));
  }

  // The child strip at the top of the form: initials, name, age chip, today's shift window.
  function childStripHtml() {
    const kids = window.CareNestChildren;
    const children = (modal.children && modal.children()) || [];
    const windowText = (modal.shiftWindow && modal.shiftWindow()) || "";
    const live = Boolean(modal.shift.state && modal.shift.state.active);
    if (!kids || !children.length) return "";
    return `<ul class="care-log-strip-kids">${children
      .map((child) => {
        const name = kids.displayName(child);
        const age = String(child.age || "").trim();
        return `<li><span class="care-log-avatar care-log-avatar--sm" aria-hidden="true">${escapeHtml(kids.initials(name))}</span><span class="care-log-strip-name">${escapeHtml(name)}</span>${
          age ? `<span class="care-log-age-chip">${escapeHtml(age)}</span>` : ""
        }</li>`;
      })
      .join("")}</ul>
      <div class="care-log-strip-foot">${windowText ? `<p class="care-log-shift">${iconSvg("clock", 14)}<span>Shift: ${escapeHtml(windowText)}</span></p>` : "<span></span>"}${
        live ? `<span class="care-log-live-pill">Live Shift</span>` : ""
      }</div>`;
  }

  // task: { taskId, title, time }. opts.prompt: right after completing the task (shows Skip).
  function openModal(task, opener, opts) {
    if (!modal) return;
    const options = opts || {};
    const st = modal.shift.state;
    const hasLogs = logsFor(st, task.taskId).length > 0;
    modal.task = task;
    modal.returnFocus = opener || document.activeElement;

    // After a check-off the form is an offer ("Add details", with Skip); otherwise the Figma title.
    q("#log-modal-heading").textContent = options.prompt ? "Add details" : hasLogs ? "Add an update" : "Log Care Activity";
    const strip = q("[data-log-child]");
    strip.innerHTML = childStripHtml();
    strip.hidden = !strip.innerHTML.trim();
    q("[data-log-time]").textContent = task.time || "";
    q("[data-log-title]").textContent = task.title || "";

    const categories = categoriesFor(modal.ageLabel());
    q("[data-log-categories]").innerHTML = categories
      .map(
        (c, i) => `<label class="tag-option care-log-tile"><input type="radio" name="log-category" value="${c}"${i === 0 ? " checked" : ""} /><span><span class="care-log-tile-icon">${iconSvg(c, 20)}</span>${CATEGORY_LABELS[c]}</span></label>`
      )
      .join("");
    q("#log-form").querySelectorAll('input[name="log-amount"]').forEach((input) => {
      input.checked = false;
    });
    q("#log-oz").value = "";
    q("#log-note").value = "";
    const save = q("#log-save");
    save.disabled = false;
    q("#log-head-save").disabled = false;
    showCategory(categories[0]);
    setError("");
    q("[data-log-skip]").hidden = !options.prompt;

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
    q("#log-head-save").disabled = true;
    setSaveText("Saving…");
    modal.shift
      .addCareLog(Object.assign({ taskId: task.taskId }, result.entry))
      .then(() => {
        closeModal();
        if (modal.announce) modal.announce(`Details saved under ${task.title}.`);
      })
      .catch((err) => {
        save.disabled = false;
        q("#log-head-save").disabled = false;
        setSaveText(saveLabel(currentCategory()));
        setError(modal.shift.errorMessage(err));
      });
  }

  const api = {
    MAX_NOTE,
    MESSAGES,
    CATEGORY_LABELS,
    AMOUNT_LABELS,
    parseAgeMonths,
    categoriesFor,
    validate,
    timeline,
    logsFor,
    entriesHtml,
    addButtonHtml,
    timelineHtml,
    shiftWindowText,
    mountPage,
    initModal,
    openModal,
    closeModal,
    isOpen,
  };

  if (root) root.CareNestCareLog = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : null);
