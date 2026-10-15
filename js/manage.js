// manage.html (parents only): edit the child's name and age, the schedule (the household's one
// plan and its tasks), care items per category, and contacts. The database enforces who may
// write (RLS: parents only); this page is the convenience on top.
(function () {
  const auth = window.CareNestAuth;
  const esc = auth.escapeHtml;

  const CATEGORIES = [
    { key: "preferences", title: "Preferences", noun: "preference" },
    { key: "where", title: "Where things are", noun: "item" },
    { key: "instructions", title: "Instructions", noun: "instruction" },
    { key: "emergency", title: "Emergency steps", noun: "step", hint: "Shown in order under \"What to do\" on the emergency page. The Call 911 box always shows above them." },
    { key: "food", title: "Food & allergies", noun: "food or allergy", hint: "Add a severity for allergies and restrictions." },
  ];

  const SEVERITIES = ["Mild", "Moderate", "Severe"];

  // "Important today" notes (public.day_notes): one calendar date each, shown to the sitter at the
  // top of their page on that date. Listed in this category order, then oldest first.
  const DAY_NOTE_CATEGORIES = [
    { value: "routine", label: "Routine change" },
    { value: "instructions", label: "Special instruction" },
    { value: "schedule", label: "Schedule change" },
    { value: "food_meds", label: "Food or medication" },
    { value: "other", label: "Other" },
  ];
  const DAY_NOTE_FIELDS = [
    { name: "category", label: "Type", type: "select", options: DAY_NOTE_CATEGORIES, required: true },
    { name: "title", label: "Title", type: "text", max: 140, required: true },
    { name: "detail", label: "Details", type: "textarea", max: 2000, optional: true },
  ];

  // Today's date in the browser's time zone (YYYY-MM-DD), the sitter page's default too.
  function localToday() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function clockLabel(iso) {
    const d = new Date(iso);
    const h = d.getHours();
    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, "0")}${h >= 12 ? "pm" : "am"}`;
  }

  // Field definitions per list. type: text | textarea | time | tel | select.
  const TASK_FIELDS = [
    { name: "time_of_day", label: "Time", type: "time", optional: true },
    { name: "title", label: "Title", type: "text", max: 140, required: true },
    { name: "detail", label: "Details", type: "textarea", max: 1000, optional: true },
    { name: "location", label: "Location", type: "text", max: 200, optional: true },
    { name: "care_note", label: "Care note", type: "textarea", max: 1000, optional: true },
  ];
  const CARE_FIELDS = [
    { name: "title", label: "Title", type: "text", max: 140, required: true },
    { name: "detail", label: "Details", type: "textarea", max: 2000, optional: true },
  ];
  const FOOD_FIELDS = CARE_FIELDS.concat([
    { name: "severity", label: "Severity", type: "select", options: SEVERITIES, optional: true },
  ]);
  const CONTACT_FIELDS = [
    { name: "name", label: "Name", type: "text", max: 80, required: true },
    { name: "role", label: "Role", type: "text", max: 40, optional: true, list: "contact-roles" },
    { name: "phone", label: "Phone", type: "tel", max: 40, optional: true },
    { name: "address", label: "Address", type: "text", max: 200, optional: true },
  ];

  function formatTaskTime(value) {
    const match = /^(\d{1,2}):(\d{2})/.exec(value || "");
    if (!match) return "";
    const hours = Number(match[1]);
    const h12 = hours % 12 === 0 ? 12 : hours % 12;
    return `${h12}:${match[2]}${hours >= 12 ? "pm" : "am"}`;
  }

  function friendly(error) {
    const message = (error && error.message) || "";
    if (/task_archived/.test(message)) {
      return "This task was removed from the schedule, so it can't be changed. Reload the page.";
    }
    if (/row-level security|permission denied/i.test(message)) {
      return "Only a parent can change this.";
    }
    return auth.friendlyError(error);
  }

  auth.whenReady((ctx) => {
    const main = document.querySelector(".manage-main");
    if (!ctx || ctx.demo) {
      main.innerHTML =
        '<p class="signin-note">Editing family info needs a signed-in parent. <a href="signin.html">Sign in</a></p>';
      return;
    }
    if (window.CareNestUI) window.CareNestUI.renderParentNav("manage");
    auth.mountChrome(ctx);

    const client = ctx.client;
    const householdId = ctx.household.id;
    const state = { plan: null, tasks: [], care: {}, contacts: [], dayNotes: [], dayNotesError: null };
    CATEGORIES.forEach((c) => (state.care[c.key] = []));

    const sectionsEl = document.getElementById("manage-sections");
    const loadingEl = document.getElementById("manage-loading");
    const loadErrorEl = document.getElementById("manage-load-error");
    const pageError = document.getElementById("manage-error");

    function show(el, text) {
      el.textContent = text;
      el.hidden = !text;
    }

    function announce(text) {
      const status = document.getElementById("app-status");
      if (status) status.textContent = text;
    }

    // ---------- care sections markup ----------

    document.getElementById("care-sections").innerHTML = CATEGORIES.map(
      (c) => `<section class="card auth-card manage-care" aria-labelledby="care-${c.key}-heading">
        <h2 class="panel-title" id="care-${c.key}-heading">${esc(c.title)}</h2>
        ${c.hint ? `<p class="signin-note">${esc(c.hint)}</p>` : ""}
        <ul class="people-list" id="list-care-${c.key}"></ul>
        <button type="button" class="primary-btn" data-add="care-${c.key}">Add ${esc(c.noun)}</button>
      </section>`
    ).join("");

    // ---------- lists ----------

    // Each list knows its table, rows, fields, and how to describe a row.
    function listConfig(key) {
      if (key === "tasks") {
        return {
          table: "tasks",
          noun: "task",
          rows: state.tasks,
          fields: TASK_FIELDS,
          summary: (r) => [formatTaskTime(r.time_of_day), r.title].filter(Boolean).join(" · "),
          sub: (r) => r.location || r.detail || "",
        };
      }
      if (key === "day-notes") {
        return {
          table: "day_notes",
          noun: "note",
          rows: state.dayNotes,
          fields: DAY_NOTE_FIELDS,
          reorder: false,
          empty: state.dayNotesError || "No notes for this day.",
          summary: (r) => r.title,
          sub: (r) =>
            [
              (DAY_NOTE_CATEGORIES.find((c) => c.value === r.category) || {}).label,
              Date.parse(r.updated_at) > Date.parse(r.created_at) ? `Updated ${clockLabel(r.updated_at)}` : "",
              r.detail,
            ]
              .filter(Boolean)
              .join(" · "),
        };
      }
      if (key === "contacts") {
        return {
          table: "contacts",
          noun: "contact",
          rows: state.contacts,
          fields: CONTACT_FIELDS,
          summary: (r) => r.name,
          sub: (r) => [r.role, r.phone].filter(Boolean).join(" · "),
        };
      }
      const category = CATEGORIES.find((c) => `care-${c.key}` === key);
      return {
        table: "care_items",
        category: category.key,
        noun: category.noun,
        rows: state.care[category.key],
        fields: category.key === "food" ? FOOD_FIELDS : CARE_FIELDS,
        summary: (r) => r.title,
        sub: (r) => [r.severity, r.detail].filter(Boolean).join(" · "),
      };
    }

    function renderList(key) {
      const config = listConfig(key);
      const list = document.getElementById(`list-${key}`);
      const rows = config.rows;
      if (!rows.length) {
        list.innerHTML = `<li class="people-row"><p class="people-sub">${esc(config.empty || "No information provided")}</p></li>`;
        return;
      }
      list.innerHTML = rows
        .map((row, index) => {
          const name = config.summary(row);
          const sub = config.sub(row);
          return `<li class="people-row manage-row">
            <div class="people-meta">
              <p class="people-name">${esc(name)}</p>
              ${sub ? `<p class="people-sub manage-sub">${esc(sub)}</p>` : ""}
            </div>
            <div class="manage-actions">
              ${config.reorder === false ? "" : `<button type="button" class="photo-source-btn manage-icon-btn" data-move="-1" data-list="${key}" data-id="${esc(row.id)}" aria-label="Move ${esc(name)} up"${index === 0 ? " disabled" : ""}>↑</button>
              <button type="button" class="photo-source-btn manage-icon-btn" data-move="1" data-list="${key}" data-id="${esc(row.id)}" aria-label="Move ${esc(name)} down"${index === rows.length - 1 ? " disabled" : ""}>↓</button>`}
              <button type="button" class="photo-source-btn people-action" data-edit data-list="${key}" data-id="${esc(row.id)}" aria-label="Edit ${esc(name)}">Edit</button>
              ${key === "tasks"
                ? `<button type="button" class="danger-btn people-action" data-delete data-list="${key}" data-id="${esc(row.id)}" aria-label="Remove ${esc(name)} from schedule">Remove from schedule</button>`
                : `<button type="button" class="danger-btn people-action" data-delete data-list="${key}" data-id="${esc(row.id)}" aria-label="Delete ${esc(name)}">Delete</button>`}
            </div>
          </li>`;
        })
        .join("");
    }

    function allListKeys() {
      return ["day-notes", "tasks", "contacts"].concat(CATEGORIES.map((c) => `care-${c.key}`));
    }

    function renderAll() {
      document.getElementById("child-name").value = ctx.household.child_name || "";
      document.getElementById("child-age").value = ctx.household.child_age_label || "";
      document.getElementById("plan-hours").value = state.plan ? state.plan.schedule || "" : "";
      allListKeys().forEach(renderList);
    }

    // ---------- load ----------

    function sortTasks(tasks) {
      return tasks.slice().sort((a, b) => {
        if (a.position !== b.position) return a.position - b.position;
        const at = a.time_of_day || "99";
        const bt = b.time_of_day || "99";
        if (at !== bt) return at < bt ? -1 : 1;
        return String(a.created_at).localeCompare(String(b.created_at));
      });
    }

    // Day notes load on their own: a failure here (for example before the day_notes migration is
    // applied) shows in this list only and leaves the rest of the page editable.
    const dayNotesDateEl = document.getElementById("day-notes-date");
    dayNotesDateEl.value = localToday();

    async function loadDayNotes() {
      const order = (r) => DAY_NOTE_CATEGORIES.findIndex((c) => c.value === r.category);
      const { data, error } = await client
        .from("day_notes")
        .select("id, category, title, detail, created_at, updated_at")
        .eq("household_id", householdId)
        .eq("note_date", dayNotesDateEl.value || localToday())
        .order("created_at", { ascending: true });
      state.dayNotesError = error ? friendly(error) : null;
      state.dayNotes = error
        ? []
        : data.slice().sort((a, b) => order(a) - order(b) || String(a.created_at).localeCompare(String(b.created_at)));
    }

    dayNotesDateEl.addEventListener("change", async () => {
      if (!dayNotesDateEl.value) dayNotesDateEl.value = localToday();
      await loadDayNotes();
      renderList("day-notes");
    });

    async function load() {
      loadingEl.hidden = false;
      loadErrorEl.hidden = true;
      const [household, contacts, careItems, plans] = await Promise.all([
        client.from("households").select("child_name, child_age_label").eq("id", householdId).single(),
        client
          .from("contacts")
          .select("id, name, role, phone, address, position")
          .eq("household_id", householdId)
          .order("position", { ascending: true })
          .order("created_at", { ascending: true }),
        client
          .from("care_items")
          .select("id, category, title, detail, severity, position")
          .eq("household_id", householdId)
          .order("position", { ascending: true })
          .order("created_at", { ascending: true }),
        client
          .from("plans")
          .select("id, title, schedule, tasks(id, title, time_of_day, detail, location, care_note, position, created_at, archived_at)")
          .eq("household_id", householdId)
          .order("position", { ascending: true })
          .order("created_at", { ascending: true })
          .limit(1),
        loadDayNotes(),
      ]);
      loadingEl.hidden = true;
      const error = household.error || contacts.error || careItems.error || plans.error;
      if (error) {
        document.getElementById("manage-load-error-text").textContent = friendly(error);
        loadErrorEl.hidden = false;
        sectionsEl.hidden = true;
        return;
      }
      Object.assign(ctx.household, household.data);
      state.contacts = contacts.data;
      CATEGORIES.forEach((c) => {
        state.care[c.key] = careItems.data.filter((item) => item.category === c.key);
      });
      state.plan = plans.data[0] || null;
      // Archived tasks are off the schedule and frozen (the database refuses edits); past
      // shifts keep them through their check snapshots.
      state.tasks = state.plan ? sortTasks((state.plan.tasks || []).filter((t) => !t.archived_at)) : [];
      sectionsEl.hidden = false;
      renderAll();
    }

    document.getElementById("manage-retry").addEventListener("click", load);

    // The household has one plan. Create it the first time a parent edits the schedule.
    async function ensurePlan() {
      if (state.plan) return state.plan;
      const { data, error } = await client
        .from("plans")
        .insert({ household_id: householdId, title: "Daily schedule" })
        .select("id, title, schedule")
        .single();
      if (error) throw error;
      state.plan = Object.assign(data, { tasks: [] });
      return state.plan;
    }

    // ---------- child and plan forms ----------

    function bindSimpleForm(formId, save) {
      const form = document.getElementById(formId);
      const errorEl = form.querySelector("[data-form-error]");
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        show(errorEl, "");
        const button = form.querySelector("button[type=submit]");
        button.disabled = true;
        try {
          await save(form);
        } catch (error) {
          show(errorEl, friendly(error));
        } finally {
          button.disabled = false;
        }
      });
    }

    bindSimpleForm("child-form", async (form) => {
      const values = {
        child_name: form.child_name.value.trim(),
        child_age_label: form.child_age_label.value.trim(),
      };
      const { error } = await client.from("households").update(values).eq("id", householdId);
      if (error) throw error;
      Object.assign(ctx.household, values);
      announce("Child details saved.");
    });

    bindSimpleForm("plan-form", async (form) => {
      const plan = await ensurePlan();
      const schedule = form.schedule.value.trim();
      const { error } = await client.from("plans").update({ schedule }).eq("id", plan.id);
      if (error) throw error;
      plan.schedule = schedule;
      announce("Shift hours saved.");
    });

    // ---------- edit dialog ----------

    const dialog = document.getElementById("edit-dialog");
    const editForm = document.getElementById("edit-form");
    const editFields = document.getElementById("edit-fields");
    const editError = document.getElementById("edit-error");
    let editing = null; // { key, row|null, opener }

    function fieldHtml(field, value) {
      const id = `edit-${field.name}`;
      const label = `<label class="field-label" for="${id}">${esc(field.label)}${field.optional ? ' <span class="field-optional">(optional)</span>' : ""}</label>`;
      const required = field.required ? " required" : "";
      const max = field.max ? ` maxlength="${field.max}"` : "";
      let control;
      if (field.type === "textarea") {
        control = `<textarea class="text-input manage-textarea" id="${id}" name="${field.name}" rows="3"${max}${required}>${esc(value || "")}</textarea>`;
      } else if (field.type === "select") {
        const options = field.options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
        control = `<select class="text-input" id="${id}" name="${field.name}"${required}>
          ${field.required ? "" : '<option value="">None</option>'}
          ${options.map((o) => `<option value="${esc(o.value)}"${o.value === value ? " selected" : ""}>${esc(o.label)}</option>`).join("")}
        </select>`;
      } else {
        const v = field.type === "time" ? (value || "").slice(0, 5) : value || "";
        const list = field.list ? ` list="${field.list}"` : "";
        control = `<input class="text-input" id="${id}" name="${field.name}" type="${field.type}" value="${esc(v)}" autocomplete="off"${max}${required}${list} />`;
      }
      return `<div class="manage-field">${label}${control}</div>`;
    }

    function openEditor(key, row, opener) {
      const config = listConfig(key);
      editing = { key, row, opener };
      document.getElementById("edit-title").textContent = `${row ? "Edit" : "Add"} ${config.noun}`;
      editFields.innerHTML = config.fields.map((f) => fieldHtml(f, row ? row[f.name] : "")).join("");
      show(editError, "");
      dialog.showModal();
      const first = editFields.querySelector("input, textarea, select");
      if (first) first.focus();
    }

    function closeEditor() {
      dialog.close();
    }

    dialog.addEventListener("close", () => {
      const opener = editing && editing.opener;
      editing = null;
      if (opener && opener.isConnected) opener.focus();
    });
    document.getElementById("edit-cancel").addEventListener("click", closeEditor);

    editForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!editing) return;
      const config = listConfig(editing.key);
      const values = {};
      for (const field of config.fields) {
        const raw = editForm.elements[field.name].value;
        const value = field.type === "time" || field.type === "select" ? raw : raw.trim();
        if (field.required && !value) {
          show(editError, `Please enter a ${field.label.toLowerCase()}.`);
          editForm.elements[field.name].focus();
          return;
        }
        values[field.name] = (field.type === "time" || field.type === "select") && !value ? null : value;
      }
      const save = document.getElementById("edit-save");
      save.disabled = true;
      show(editError, "");
      try {
        if (editing.row) {
          const { error } = await client.from(config.table).update(values).eq("id", editing.row.id);
          if (error) throw error;
        } else {
          const insert = Object.assign({}, values);
          if (config.reorder !== false) {
            insert.position = config.rows.reduce((max, r) => Math.max(max, r.position), -1) + 1;
          }
          if (config.table === "tasks") insert.plan_id = (await ensurePlan()).id;
          else insert.household_id = householdId;
          if (config.table === "day_notes") insert.note_date = dayNotesDateEl.value || localToday();
          if (config.category) insert.category = config.category;
          const { error } = await client.from(config.table).insert(insert);
          if (error) throw error;
        }
        const noun = config.noun;
        closeEditor();
        announce(`${noun.charAt(0).toUpperCase()}${noun.slice(1)} saved.`);
        await load();
      } catch (error) {
        show(editError, friendly(error));
      } finally {
        save.disabled = false;
      }
    });

    // ---------- list actions ----------

    sectionsEl.addEventListener("click", async (event) => {
      const add = event.target.closest("[data-add]");
      if (add) {
        openEditor(add.dataset.add, null, add);
        return;
      }
      const button = event.target.closest("[data-list]");
      if (!button) return;
      const key = button.dataset.list;
      const config = listConfig(key);
      const row = config.rows.find((r) => r.id === button.dataset.id);
      if (!row) return;
      show(pageError, "");

      if (button.hasAttribute("data-edit")) {
        openEditor(key, row, button);
      } else if (button.hasAttribute("data-delete")) {
        const name = config.summary(row);
        if (config.table === "tasks") {
          // Archive, never delete: past shifts keep the task and what was checked. The database
          // stamps archived_at itself; any non-null value asks for it.
          const ok = await auth.confirmDialog({
            title: `Remove ${name} from the schedule?`,
            body: "Your sitter won't see it on new shifts and it can't be edited anymore. Past shifts keep it, including whether it was checked off. To bring it back, add it again as a new task.",
            confirmLabel: "Remove from schedule",
            danger: true,
          });
          if (!ok) return;
          const { error } = await client
            .from("tasks")
            .update({ archived_at: new Date().toISOString() })
            .eq("id", row.id);
          if (error) show(pageError, friendly(error));
          else announce(`${name} removed from the schedule.`);
          await load();
          return;
        }
        const ok = await auth.confirmDialog({
          title: `Delete ${name}?`,
          body: `Your sitter will no longer see this ${config.noun}. This cannot be undone.`,
          confirmLabel: "Delete",
          danger: true,
        });
        if (!ok) return;
        const { error } = await client.from(config.table).delete().eq("id", row.id);
        if (error) show(pageError, friendly(error));
        else announce(`${name} deleted.`);
        await load();
      } else if (button.dataset.move) {
        await move(config, row, Number(button.dataset.move));
      }
    });

    // Moves a row one place and renumbers the list's positions 0..n-1 (only changed rows are
    // written).
    async function move(config, row, delta) {
      const rows = config.rows.slice();
      const from = rows.indexOf(row);
      const to = from + delta;
      if (to < 0 || to >= rows.length) return;
      rows.splice(to, 0, rows.splice(from, 1)[0]);
      const changes = rows
        .map((r, index) => ({ id: r.id, position: index, changed: r.position !== index }))
        .filter((c) => c.changed);
      const results = await Promise.all(
        changes.map((c) => client.from(config.table).update({ position: c.position }).eq("id", c.id))
      );
      const failed = results.find((r) => r.error);
      if (failed) show(pageError, friendly(failed.error));
      else announce(`${config.summary(row)} moved ${delta < 0 ? "up" : "down"}.`);
      await load();
    }

    load();
  });
})();
