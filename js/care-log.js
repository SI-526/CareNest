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
          childId: child ? child.id : null,
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

  // Category icons from the design system (Figma 186:320): a white glyph in a 30px Deep Teal
  // circle. Meal and Bottle map to Snack and Feed; anything else (Care, Care Log notes) uses the
  // generic note icon, since the data has no finer category (SI-83).
  // Glyphs: snack "cookie" (186:330) and feed "mdi:baby-bottle" (186:379) on a 20 grid; the
  // note is Material "description" on a 24 grid.
  const CATEGORY_ICONS = {
    meal: ["0 0 20 20", "M10 18.3334C8.84722 18.3334 7.76389 18.1147 6.75 17.6772C5.73611 17.2397 4.85417 16.6459 4.10417 15.8959C3.35417 15.1459 2.76042 14.264 2.32292 13.2501C1.88542 12.2362 1.66667 11.1529 1.66667 10.0001C1.66667 8.95842 1.86806 7.93758 2.27083 6.93758C2.67361 5.93758 3.23611 5.04522 3.95833 4.2605C4.68056 3.47578 5.54861 2.84383 6.5625 2.36466C7.57639 1.8855 8.6875 1.64591 9.89583 1.64591C10.1875 1.64591 10.4861 1.6598 10.7917 1.68758C11.0972 1.71536 11.4097 1.76397 11.7292 1.83341C11.6042 2.45841 11.6458 3.04869 11.8542 3.60425C12.0625 4.1598 12.375 4.62161 12.7917 4.98967C13.2083 5.35772 13.7049 5.61119 14.2812 5.75008C14.8576 5.88897 15.4514 5.85425 16.0625 5.64592C15.7014 6.46536 15.7535 7.25008 16.2187 8.00008C16.684 8.75008 17.375 9.13897 18.2917 9.16675C18.3056 9.31953 18.316 9.46189 18.3229 9.59383C18.3299 9.72578 18.3333 9.86814 18.3333 10.0209C18.3333 11.1598 18.1146 12.2327 17.6771 13.2397C17.2396 14.2466 16.6458 15.1286 15.8958 15.8855C15.1458 16.6424 14.2639 17.2397 13.25 17.6772C12.2361 18.1147 11.1528 18.3334 10 18.3334ZM8.75 8.33342C9.09722 8.33342 9.39236 8.21189 9.63542 7.96883C9.87847 7.72578 10 7.43064 10 7.08342C10 6.73619 9.87847 6.44105 9.63542 6.198C9.39236 5.95494 9.09722 5.83342 8.75 5.83342C8.40278 5.83342 8.10764 5.95494 7.86458 6.198C7.62153 6.44105 7.5 6.73619 7.5 7.08342C7.5 7.43064 7.62153 7.72578 7.86458 7.96883C8.10764 8.21189 8.40278 8.33342 8.75 8.33342ZM7.08333 12.5001C7.43056 12.5001 7.72569 12.3786 7.96875 12.1355C8.21181 11.8924 8.33333 11.5973 8.33333 11.2501C8.33333 10.9029 8.21181 10.6077 7.96875 10.3647C7.72569 10.1216 7.43056 10.0001 7.08333 10.0001C6.73611 10.0001 6.44097 10.1216 6.19792 10.3647C5.95486 10.6077 5.83333 10.9029 5.83333 11.2501C5.83333 11.5973 5.95486 11.8924 6.19792 12.1355C6.44097 12.3786 6.73611 12.5001 7.08333 12.5001ZM12.5 13.3334C12.7361 13.3334 12.934 13.2536 13.0938 13.0938C13.2535 12.9341 13.3333 12.7362 13.3333 12.5001C13.3333 12.264 13.2535 12.0661 13.0938 11.9063C12.934 11.7466 12.7361 11.6667 12.5 11.6667C12.2639 11.6667 12.066 11.7466 11.9062 11.9063C11.7465 12.0661 11.6667 12.264 11.6667 12.5001C11.6667 12.7362 11.7465 12.9341 11.9062 13.0938C12.066 13.2536 12.2639 13.3334 12.5 13.3334Z"],
    bottle: ["0 0 20 20", "M9.4 2.33333L8.98333 2.75C8.43348 2.44336 7.82636 2.25329 7.19981 2.19164C6.57327 2.12999 5.94074 2.19808 5.34167 2.39167L5.275 2.33333C4.8781 1.97854 4.36043 1.78915 3.82828 1.80404C3.29612 1.81893 2.78986 2.03698 2.41342 2.41342C2.03698 2.78986 1.81893 3.29612 1.80404 3.82828C1.78915 4.36043 1.97854 4.8781 2.33333 5.275L2.39167 5.34167C2.19808 5.94074 2.12999 6.57327 2.19164 7.19981C2.25329 7.82636 2.44336 8.43348 2.75 8.98333L2.33333 9.4C2.09925 9.63438 1.96777 9.95208 1.96777 10.2833C1.96777 10.6146 2.09925 10.9323 2.33333 11.1667L3.50833 12.35C3.74271 12.5841 4.06042 12.7156 4.39167 12.7156C4.72292 12.7156 5.04062 12.5841 5.275 12.35L5.56667 12.05L11.4667 17.9417C11.701 18.1758 12.0187 18.3072 12.35 18.3072C12.6813 18.3072 12.999 18.1758 13.2333 17.9417L17.9417 13.2333C18.1758 12.999 18.3072 12.6813 18.3072 12.35C18.3072 12.0187 18.1758 11.701 17.9417 11.4667L12.05 5.56667L12.35 5.275C12.5841 5.04062 12.7156 4.72292 12.7156 4.39167C12.7156 4.06042 12.5841 3.74271 12.35 3.50833L11.1667 2.33333C10.9323 2.09925 10.6146 1.96777 10.2833 1.96777C9.95208 1.96777 9.63438 2.09925 9.4 2.33333ZM11.4667 4.39167L4.39167 11.4667L3.21667 10.2833L10.2833 3.21667M12.35 9.69167L9.69167 12.35L8.80833 11.4667L11.4667 8.80833M14.1167 11.4667L11.4667 14.1167L10.575 13.2333L13.2333 10.575L14.1167 11.4667Z"],
    note: ["0 0 24 24", "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm2 16H8v-2h8v2Zm0-4H8v-2h8v2Zm-3-5V3.5L18.5 9H13Z"],
  };

  function categoryIconHtml(category, cls) {
    const [box, path] = CATEGORY_ICONS[category] || CATEGORY_ICONS.note;
    return `<span class="${cls || "care-log-dot"}" data-category="${escapeHtml(category || "note")}" aria-hidden="true"><svg viewBox="${box}" width="20" height="20" focusable="false"><path fill="currentColor" d="${path}"/></svg></span>`;
  }

  // The Shift Timeline on the Care Log page (Figma 303:634): a rail of category dots, one card
  // per entry with its title and time, and the details in an inset box.
  function sessionLogHtml(entries) {
    return entries
      .map((e) => {
        const iso = new Date(e.createdAt).toISOString();
        const title = e.kind === "task" ? e.taskTitle : e.childLabel;
        const kind =
          e.kind === "task"
            ? `Task details · ${escapeHtml(CATEGORY_LABELS[e.category] || "Care")}`
            : "Note";
        const about = e.childName || (e.childRemoved ? "a removed child" : "your child");
        const label = e.kind === "task" ? `Task details: ${e.taskTitle}` : `Entry about ${about}`;
        const detail =
          e.facts.length || e.note
            ? `<div class="session-log-detail">
              ${e.facts.length ? `<p class="session-log-fact">${escapeHtml(e.facts.join(" • "))}</p>` : ""}
              ${e.note ? `<p class="session-log-text">${escapeHtml(e.note)}</p>` : ""}
            </div>`
            : "";
        return `<li class="session-log-entry" data-entry-id="${escapeHtml(e.id)}">
          ${categoryIconHtml(e.kind === "task" ? e.category : "note", "session-log-dot")}
          <article class="session-log-card" aria-label="${escapeHtml(label)}">
            <div class="session-log-entry-head">
              <div class="session-log-heading">
                <p class="session-log-subject">${escapeHtml(title)}</p>
                <p class="session-log-kind">${kind}</p>
              </div>
              <time class="session-log-time" datetime="${iso}">${escapeHtml(shortTime(e.createdAt))}</time>
            </div>
            ${detail}
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
  // (sitter, shift in the window); opts.category narrows the list to one category.
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
          ${categoryIconHtml(icon)}
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
    q("[data-log-time]").textContent = clockText(task.time) || task.time || "";
    q("[data-log-title]").textContent = task.title || "";

    const categories = categoriesFor(modal.ageLabel());
    q("[data-log-categories]").innerHTML = categories
      .map(
        (c, i) => `<label class="tag-option care-log-tile"><input type="radio" name="log-category" value="${c}"${i === 0 ? " checked" : ""} /><span>${categoryIconHtml(c, "care-log-tile-icon")}${CATEGORY_LABELS[c]}</span></label>`
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
    ENTRY_CATEGORY,
    validateEntry,
    sessionEntries,
    sessionLogHtml,
    categoryIconHtml,
    initialsOf,
    parseAgeMonths,
    categoriesFor,
    validate,
    timeline,
    logsFor,
    entriesHtml,
    addButtonHtml,
    timelineHtml,
    shiftWindowText,
    initModal,
    openModal,
    closeModal,
    isOpen,
  };

  if (root) root.CareNestCareLog = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : null);
