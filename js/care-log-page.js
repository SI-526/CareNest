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
    sub: $("session-log-sub"),
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

    const children = () => (data.children || []).filter((c) => c && c.id);
    const canAdd = () => {
      const st = shift.state;
      return !isParent && st.loaded !== false && !st.loadError && Boolean(st.visit) && st.canLog && children().length > 0;
    };

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

    function render() {
      const st = shift.state;
      els.sub.textContent = sessionLine(st);
      const status = statusText(st);
      els.status.textContent = status;
      els.status.hidden = !status;
      els.add.hidden = !canAdd();

      const entries = careLog.sessionEntries(st, children(), data.schedule);
      els.list.innerHTML = careLog.sessionLogHtml(entries);
      els.list.hidden = !entries.length;
      els.empty.hidden = entries.length > 0 || Boolean(st.loadError);
      els.emptyCopy.textContent = isParent
        ? "Notes your sitter adds during the session will show up here."
        : canAdd()
          ? "Tap New entry to note meals, naps, moods, or anything the parents should know."
          : "Entries added during a session will show up here.";
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
          return `<label class="tag-option session-entry-child-option"><input type="radio" name="entry-child" value="${ui.escapeHtml(c.id)}"${c.id === picked ? " checked" : ""} aria-describedby="entry-error" /><span>${ui.escapeHtml(name)}</span></label>`;
        })
        .join("");
    }

    function showView() {
      const wantEntry = window.location.hash === "#new" && canAdd();
      const wasEntry = !els.entryView.hidden;
      els.entryView.hidden = !wantEntry;
      els.logView.hidden = wantEntry;
      if (wantEntry && !wasEntry) {
        lastIds = null;
        renderPicker();
        const st = shift.state;
        els.when.textContent = st.visit ? sessionLine(st).replace(/^Current session · /, "") : "";
        updateCount();
        const first = els.picker.hidden ? els.note : els.children.querySelector("input:checked") || els.children.querySelector("input");
        if (first) first.focus();
      } else if (!wantEntry && wasEntry) {
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
    els.children.addEventListener("change", () => setError(""));
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
      els.save.textContent = "Saving…";
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
          els.save.textContent = "Save entry";
        });
    });

    shift.subscribe(render);
    if (window.CareNestFamily && window.CareNestFamily.subscribe) window.CareNestFamily.subscribe(render);
    render();
  }
})();
