// The Care Log page (care-log.html, SI-63): the current session's log and, for the sitter, a new
// entry about one child (SI-64, SI-65).
//
// The session is the family's latest shift (js/shift-data.js state.visit). Entries are care_logs
// rows of that shift, oldest first: Care Log entries (category 'note', about a child) and the
// details logged under completed tasks. A new entry goes through backend.addSessionEntry(), which
// checks the same rules as the database (stamp_care_log: member, shift window, child of this
// family space). Parents read the same log (care-log.html?as=parent); only sitters add.
//
// Load order: after js/care-log.js, js/store.js, js/shift-data.js, and js/app.js (CareNestUI).
(function () {
  const careLog = window.CareNestCareLog;
  const ui = window.CareNestUI;
  const shiftApi = window.CareNestShift;
  const auth = window.CareNestAuth;
  if (!careLog || !ui || !shiftApi || !document.getElementById("session-log-list")) return;

  const $ = (id) => document.getElementById(id);
  const els = {
    logView: $("session-log-view"),
    entryView: $("session-entry-view"),
    sub: $("session-log-sub-text"),
    family: $("session-log-family"),
    kids: $("session-log-kids"),
    filters: $("session-log-filters"),
    logCount: $("session-log-count"),
    emptyTitle: $("session-log-empty-title"),
    logBack: $("session-log-back"),
    status: $("session-log-status"),
    add: $("session-log-add"),
    list: $("session-log-list"),
    empty: $("session-log-empty"),
    emptyCopy: $("session-log-empty-copy"),
    form: $("session-entry-form"),
    when: $("entry-when"),
    picker: $("entry-child-picker"),
    children: $("entry-children"),
    oneChild: $("entry-one-child"),
    note: $("entry-note"),
    count: $("entry-count"),
    error: $("entry-error"),
    save: $("entry-save"),
    saveText: $("entry-save-text"),
    headSave: $("entry-head-save"),
    title: $("entry-title"),
    cancel: $("entry-cancel"),
    back: $("entry-back"),
  };

  const readySource = window.CareNestFamily || auth;
  Promise.all([readySource ? readySource.ready : Promise.resolve(null), shiftApi.ready]).then(([ctx, shift]) => {
    const isParent = Boolean(ctx && ctx.role === "parent");
    if (isParent) ui.renderParentNav("care-log");
    else ui.renderSitterNav("care-log");
    init(shift, isParent);
  });

  function init(shift, isParent) {
    const data = window.CareNestData;
    let saving = false;
    let openedHere = false; // the form was opened from this page (so Back can use history.back())
    let lastIds = null;
    let filter = "all"; // "all", "task", or a child id (chips under the session card)
    let clockTimer = null;
    const kidsApi = window.CareNestChildren;
    const esc = ui.escapeHtml;
    if (isParent) els.logBack.href = "parent.html" + window.location.search;
    else els.logBack.href = "index.html" + window.location.search;

    const children = () => (data.children || []).filter((c) => c && c.id);
    const canAdd = () => {
      const st = shift.state;
      return !isParent && st.loaded !== false && !st.loadError && Boolean(st.visit) && st.canLog && children().length > 0;
    };

    // The clock line on the session card: "Today, 3:00 PM - 7:00 PM" when today's schedule has a
    // window, else "Today · Started 5:35pm".
    function cardLine(st) {
      if (!st.visit) return "No session yet";
      const windowText = careLog.shiftWindowText(data.appointments);
      const day = dayLabel(st.visit.date);
      if (windowText && day === "Today") return `${day}, ${windowText}`;
      return sessionLine(st).replace(/^Current session · /, "");
    }

    function sessionLine(st) {
      if (!st.visit) return "No session yet";
      const parts = [];
      const day = dayLabel(st.visit.date);
      if (day) parts.push(day);
      if (st.visit.startedAt) parts.push(`Started ${ui.shortTime(st.visit.startedAt)}`);
      if (st.visit.endedAt) parts.push(`Ended ${ui.shortTime(st.visit.endedAt)}`);
      return `Current session · ${parts.join(" · ")}`;
    }

    // 'YYYY-MM-DD' -> "Today", "Yesterday", "Tomorrow", or "Mon, Nov 3". Demo shifts carry no date.
    function dayLabel(iso) {
      if (!iso) return "Today";
      const local = (offset) => {
        const d = new Date();
        d.setDate(d.getDate() + offset);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      };
      if (iso === local(0)) return "Today";
      if (iso === local(-1)) return "Yesterday";
      if (iso === local(1)) return "Tomorrow";
      const d = new Date(`${iso}T12:00:00`);
      return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    }

    function statusText(st) {
      if (st.loadError) return st.loadError;
      if (isParent) return "";
      if (!st.visit) return "Your session hasn't started yet. Start your shift on Home, then add entries here.";
      if (!st.canLog) return "This session is over, so its log is read-only.";
      if (!children().length) return "This family space has no children yet, so there is no one to log about.";
      return "";
    }

    const firstName = (c) => (kidsApi ? kidsApi.firstName(c) : String(c.name || "").split(/\s+/)[0]) || "Child";

    // The child and session card (Figma 303:634 "child-profile"): initials, never photos.
    function renderKids() {
      const kids = children();
      els.kids.classList.toggle("is-single", kids.length === 1);
      els.kids.innerHTML = kids
        .map((c) => {
          const name = kidsApi ? kidsApi.displayName(c) : c.name || "Child";
          const initials = kidsApi ? kidsApi.initials(name) : careLog.initialsOf(name);
          const parts = kidsApi ? kidsApi.displayParts(c) : [];
          return `<li class="session-log-kid"><span class="session-log-avatar" aria-hidden="true">${esc(initials)}</span><span class="session-log-kid-text"><span class="session-log-kid-name">${esc(name)}</span>${
            parts.length ? `<span class="session-log-kid-details">${parts.map(esc).join('<span class="session-log-dot-sep" aria-hidden="true"></span>')}</span>` : ""
          }</span></li>`;
        })
        .join("");
      els.kids.hidden = !kids.length;
    }

    // Filter chips: All, one per child (only with two or more children), and Task details when
    // the session has any. These are the only groupings the data supports (no categories, SI-83).
    function renderFilters(entries) {
      const kids = children();
      const chips = [{ id: "all", label: "All", n: entries.length }];
      if (kids.length > 1) {
        kids.forEach((c) => chips.push({ id: c.id, label: firstName(c), n: entries.filter((e) => e.kind !== "task" && e.childId === c.id).length }));
      }
      const tasks = entries.filter((e) => e.kind === "task").length;
      if (tasks) chips.push({ id: "task", label: "Task details", n: tasks });
      if (!chips.some((c) => c.id === filter)) filter = "all";
      els.filters.innerHTML = chips
        .map((c) => `<button type="button" class="session-log-chip" data-filter="${esc(c.id)}" aria-pressed="${c.id === filter}">${esc(c.label)} (${c.n})</button>`)
        .join("");
      els.filters.hidden = !entries.length;
    }

    function render() {
      const st = shift.state;
      const familyName = data.familyName && kidsApi && kidsApi.familyBase ? `${kidsApi.familyBase(data.familyName)} Family` : "Care Log";
      els.family.textContent = familyName;
      els.sub.textContent = cardLine(st);
      const status = statusText(st);
      els.status.textContent = status;
      els.status.hidden = !status;
      els.add.hidden = !canAdd();
      renderKids();

      const entries = careLog.sessionEntries(st, children(), data.schedule);
      renderFilters(entries);
      const shown = entries.filter((e) => filter === "all" || (filter === "task" ? e.kind === "task" : e.kind !== "task" && e.childId === filter));
      els.logCount.textContent = `${entries.length} ${entries.length === 1 ? "entry" : "entries"} logged`;
      els.list.innerHTML = careLog.sessionLogHtml(shown);
      els.list.hidden = !shown.length;
      els.empty.hidden = shown.length > 0 || Boolean(st.loadError);
      const kid = children().find((c) => c.id === filter);
      els.emptyTitle.textContent = entries.length ? (kid ? `No entries about ${firstName(kid)} yet` : "No task details yet") : "No Entries Logged Yet";
      els.emptyCopy.textContent = entries.length
        ? ""
        : isParent
          ? "Notes your sitter adds during the session will show up here."
          : canAdd()
            ? "Tap Log Activity to note meals, naps, moods, or anything the parents should know."
            : "Entries added during a session will show up here.";
      els.emptyCopy.hidden = !els.emptyCopy.textContent;
      if (!els.entryView.hidden) renderPicker();
      showView();
    }

    // The child picker: radios styled as chips. Skipped when the family has one child.
    function renderPicker() {
      const kids = children();
      const ids = kids.map((c) => c.id).join("|");
      if (ids === lastIds) return; // keep the sitter's choice while nothing changed
      lastIds = ids;
      const picked = (els.children.querySelector("input:checked") || {}).value;
      els.picker.hidden = kids.length < 2;
      els.oneChild.hidden = kids.length !== 1;
      els.oneChild.textContent = kids.length === 1 ? `About ${kids[0].name || "your child"}` : "";
      els.children.innerHTML = kids
        .map((c) => {
          const name = c.name || "Child";
          const initials = kidsApi ? kidsApi.initials(name) : careLog.initialsOf(name);
          return `<label class="tag-option care-log-tile session-entry-child-option"><input type="radio" name="entry-child" value="${ui.escapeHtml(c.id)}"${c.id === picked ? " checked" : ""} aria-describedby="entry-error" /><span><span class="care-log-tile-icon session-entry-initials" aria-hidden="true">${ui.escapeHtml(initials)}</span>${ui.escapeHtml(name)}</span></label>`;
        })
        .join("");
      updateTitle();
    }

    // "Log Care for Jack" (Figma 421:1058) once the child is known.
    function updateTitle() {
      const kids = children();
      const id = kids.length === 1 ? kids[0].id : (els.children.querySelector("input:checked") || {}).value;
      const kid = kids.find((c) => c.id === id);
      els.title.textContent = kid ? `Log Care for ${firstName(kid)}` : "Log Care";
    }

    function updateClock() {
      els.when.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }

    function showView() {
      const wantEntry = window.location.hash === "#new" && canAdd();
      const wasEntry = !els.entryView.hidden;
      els.entryView.hidden = !wantEntry;
      els.logView.hidden = wantEntry;
      if (wantEntry && !wasEntry) {
        lastIds = null;
        renderPicker();
        updateClock();
        clearInterval(clockTimer);
        clockTimer = setInterval(updateClock, 30000);
        updateCount();
        const first = els.picker.hidden ? els.note : els.children.querySelector("input:checked") || els.children.querySelector("input");
        if (first) first.focus();
      } else if (!wantEntry && wasEntry) {
        clearInterval(clockTimer);
        els.add.focus();
      }
    }

    function setError(text) {
      els.error.textContent = text || "";
      els.error.hidden = !text;
    }

    function updateCount() {
      els.count.textContent = `${els.note.value.length} / ${careLog.MAX_NOTE}`;
    }

    function openForm() {
      if (!canAdd()) return;
      setError("");
      openedHere = true;
      window.location.hash = "new";
    }

    function closeForm() {
      if (openedHere && window.location.hash === "#new") {
        openedHere = false;
        window.history.back();
        return;
      }
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      showView();
    }

    els.add.addEventListener("click", openForm);
    els.back.addEventListener("click", closeForm); // keeps what was typed
    els.cancel.addEventListener("click", () => {
      els.form.reset();
      setError("");
      closeForm();
    });
    els.note.addEventListener("input", () => {
      updateCount();
      setError("");
    });
    els.children.addEventListener("change", () => {
      setError("");
      updateTitle();
    });
    els.filters.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-filter]");
      if (!chip) return;
      filter = chip.dataset.filter;
      render();
      const again = els.filters.querySelector(`[data-filter="${CSS.escape(filter)}"]`);
      if (again) again.focus();
    });
    window.addEventListener("hashchange", showView);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !els.entryView.hidden && !saving) closeForm();
    });

    els.form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (saving) return;
      const ids = children().map((c) => c.id);
      const input = {
        childId: (els.children.querySelector("input:checked") || {}).value || null,
        note: els.note.value,
      };
      const result = careLog.validateEntry(input, ids);
      if (result.error) {
        setError(result.error);
        const target = result.field === "child" ? els.children.querySelector("input") : els.note;
        if (target) target.focus();
        return;
      }
      saving = true;
      els.save.disabled = true;
      els.headSave.disabled = true;
      els.saveText.textContent = "Saving…";
      setError("");
      const child = children().find((c) => c.id === result.entry.childId);
      shift
        .addSessionEntry(input, ids)
        .then(() => {
          els.form.reset();
          lastIds = null;
          closeForm();
          ui.announce(`Entry saved${child && child.name ? ` for ${child.name}` : ""}.`);
        })
        .catch((err) => {
          // What was typed stays in the form so the sitter can try again.
          setError(`Your entry wasn't saved. ${shift.errorMessage(err)}`);
          els.save.focus();
        })
        .finally(() => {
          saving = false;
          els.save.disabled = false;
          els.headSave.disabled = false;
          els.saveText.textContent = "Log Activity";
        });
    });

    shift.subscribe(render);
    if (window.CareNestFamily && window.CareNestFamily.subscribe) window.CareNestFamily.subscribe(render);
    render();
  }
})();
