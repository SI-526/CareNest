// Schedule, care log, child profile, and profile/settings pages. Parents see the same
// information as sitters and can edit family-owned information in place.
(function () {
  const data = window.CareNestData;
  const page = document.body.dataset.page;
  const ui = window.CareNestUI;
  const auth = window.CareNestAuth;
  const root = document.getElementById("secondary-content");
  if (!data || !ui || !root || !auth) return;

  const esc = auth.escapeHtml;
  const ready = (window.CareNestFamily || auth).ready;
  ready.then((ctx) => {
    const isParent = ctx && ctx.role === "parent";
    if (isParent) ui.renderParentNav(page === "carelog" ? "care-log" : page);
    else ui.renderSitterNav(page === "carelog" ? "care-log" : page);
    render(ctx);
  });

  function taskRows(editable) {
    if (!data.schedule.length) return '<li class="secondary-row"><span><strong>No tasks yet</strong><small>Add the first task for this session.</small></span></li>';
    return data.schedule.map((item) => `<li class="secondary-row"><span class="secondary-time">${esc(item.time || "Any time")}</span><span><strong>${esc(item.title)}</strong><small>${esc(item.detail || item.location || "Details available in the session")}</small></span>${editable ? `<button class="photo-source-btn secondary-row-action" type="button" data-edit="task" data-id="${esc(item.id)}">Edit</button>` : ""}</li>`).join("");
  }

  function sitterProfile(ctx) {
    const key = `carenest:sitter-profile:${ctx.user ? ctx.user.id : "demo"}`;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(key) || "{}"); } catch (e) { /* start with defaults */ }
    const defaults = {
      name: data.babysitter && data.babysitter.name || "",
      bio: "Friendly, dependable care for busy families.",
      phone: "",
      availability: "Weekday afternoons and weekends",
      showBio: true,
      showPhone: false,
      showAvailability: true,
      updates: true,
    };
    const profile = { ...defaults, ...saved };
    return `<section class="profile-settings-layout"><article class="panel secondary-panel public-profile-card"><p class="page-eyebrow">VISIBLE TO PARENTS</p><h2 class="section-title">Your public profile</h2><p class="supporting-copy">Parents only see the fields you choose to share below.</p><form class="profile-settings-form" id="profile-settings-form"><label class="field-label" for="profile-name">Display name</label><input class="text-input" id="profile-name" name="name" maxlength="80" value="${esc(profile.name)}"><label class="field-label" for="profile-bio">About you</label><textarea class="text-input profile-textarea" id="profile-bio" name="bio" maxlength="500" rows="4">${esc(profile.bio)}</textarea><label class="field-label" for="profile-phone">Phone number</label><input class="text-input" id="profile-phone" name="phone" type="tel" maxlength="40" value="${esc(profile.phone)}"><label class="field-label" for="profile-availability">Availability</label><input class="text-input" id="profile-availability" name="availability" maxlength="160" value="${esc(profile.availability)}"><fieldset class="profile-visibility"><legend class="field-label">What parents can see</legend><label><input type="checkbox" name="showBio"${profile.showBio ? " checked" : ""}> About you</label><label><input type="checkbox" name="showPhone"${profile.showPhone ? " checked" : ""}> Phone number</label><label><input type="checkbox" name="showAvailability"${profile.showAvailability ? " checked" : ""}> Availability</label></fieldset><fieldset class="profile-visibility"><legend class="field-label">Your preferences</legend><label><input type="checkbox" name="updates"${profile.updates ? " checked" : ""}> Receive session update reminders</label></fieldset><div class="profile-save-row"><button class="primary-btn" type="submit">Save profile</button><p class="profile-save-status" id="profile-save-status" role="status" aria-live="polite"></p></div></form></article><aside class="panel secondary-panel profile-preview"><p class="page-eyebrow">PARENT PREVIEW</p><h2 class="section-title" id="profile-preview-name">${esc(profile.name) || "Your name"}</h2><p class="supporting-copy" id="profile-preview-bio"${profile.showBio ? "" : " hidden"}>${esc(profile.bio)}</p><p class="supporting-copy" id="profile-preview-phone"${profile.showPhone ? "" : " hidden"}>${esc(profile.phone)}</p><p class="supporting-copy" id="profile-preview-availability"${profile.showAvailability ? "" : " hidden"}>${esc(profile.availability)}</p><p class="profile-private-note">Private fields stay visible only to you.</p></aside></section>`;
  }

  function bindSitterProfile(ctx) {
    const form = document.getElementById("profile-settings-form");
    if (!form) return;
    const key = `carenest:sitter-profile:${ctx.user ? ctx.user.id : "demo"}`;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form).entries());
      ["showBio", "showPhone", "showAvailability", "updates"].forEach((name) => { values[name] = form.elements[name].checked; });
      try { localStorage.setItem(key, JSON.stringify(values)); } catch (e) { /* the page still reflects this visit */ }
      document.getElementById("profile-preview-name").textContent = values.name || "Your name";
      [["bio", "showBio"], ["phone", "showPhone"], ["availability", "showAvailability"]].forEach(([field, visible]) => {
        const el = document.getElementById(`profile-preview-${field}`);
        el.textContent = values[field] || "";
        el.hidden = !values[visible] || !values[field];
      });
      document.getElementById("profile-save-status").textContent = "Profile saved.";
    });
  }

  function careSection(key, label, items, editable) {
    const rows = items.length
      ? items.map((item) => `<li class="secondary-row"><span><strong>${esc(item.title || item.name)}</strong><small>${esc(item.detail || item.description || item.severity || "")}</small></span>${editable && item.id ? `<button class="photo-source-btn secondary-row-action" type="button" data-edit="care" data-category="${key}" data-id="${esc(item.id)}">Edit</button>` : ""}</li>`).join("")
      : '<li class="secondary-row"><span><small>No information added yet.</small></span></li>';
    return `<section class="panel secondary-panel"><div class="secondary-panel-heading"><h2 class="section-title">${label}</h2>${editable ? `<button class="photo-source-btn secondary-add" type="button" data-add="care" data-category="${key}">Add</button>` : ""}</div><ul class="secondary-list">${rows}</ul></section>`;
  }

  function contactsSection(editable) {
    const contacts = data.contacts || [];
    const rows = contacts.length
      ? contacts.map((contact) => `<li class="secondary-row"><span><strong>${esc(contact.name)}</strong><small>${esc([contact.role, contact.phone].filter(Boolean).join(" · "))}</small></span>${editable && contact.id ? `<button class="photo-source-btn secondary-row-action" type="button" data-edit="contact" data-id="${esc(contact.id)}">Edit</button>` : ""}</li>`).join("")
      : '<li class="secondary-row"><span><small>No contacts added yet.</small></span></li>';
    return `<section class="panel secondary-panel"><div class="secondary-panel-heading"><h2 class="section-title">Care team</h2>${editable ? '<button class="photo-source-btn secondary-add" type="button" data-add="contact">Add</button>' : ""}</div><ul class="secondary-list">${rows}</ul></section>`;
  }

  function render(ctx) {
    // Household members can view this information, but only the parent can change it.
    // Keeping this check tied to the membership role prevents a sitter opened on a
    // parent-looking URL from being offered controls that row-level security rejects.
    const editable = Boolean(ctx && ctx.role === "parent" && !ctx.demo && ctx.client && ctx.household);
    const child = data.child || {};
    const editNote = ctx && ctx.demo ? '<p class="secondary-edit-note">Sign in as a parent to edit this information.</p>' : "";
    const views = {
      schedule: {
        eyebrow: "CURRENT SESSION", title: "Today’s schedule", intro: "A clear plan for the day, with everything in time order.",
        body: `<section class="panel secondary-panel"><div class="secondary-panel-heading"><h2 class="section-title">Current session schedule</h2>${editable ? '<button class="photo-source-btn secondary-add" type="button" data-edit="hours">Edit hours</button>' : ""}</div>${data.child.shiftTime ? `<p class="supporting-copy">Usual shift hours: ${esc(data.child.shiftTime)}</p>` : ""}<ul class="secondary-list">${taskRows(editable)}</ul>${editable ? '<button class="primary-btn secondary-primary-action" type="button" data-add="task">Add a task</button>' : ""}</section>${editNote}`,
      },
      carelog: {
        eyebrow: "CURRENT SESSION", title: "Care log", intro: "Notes, photos, and handoff details from the care session.",
        body: `<section class="secondary-grid"><article class="panel secondary-panel"><h2 class="section-title">Current session log</h2><p class="supporting-copy">Completed activities and care updates appear here during the session.</p><a class="secondary-link" href="parent.html#today">Open today’s activity</a></article><article class="panel secondary-panel"><h2 class="section-title">Photo updates</h2><p class="supporting-copy">Photos and moments shared with the care team.</p><a class="secondary-link" href="gallery.html?as=parent">Open photo updates</a></article><article class="panel secondary-panel"><h2 class="section-title">Past sessions</h2><p class="supporting-copy">Review prior care sessions and their shared updates.</p></article></section>`,
      },
      children: {
        eyebrow: "CHILD PROFILE", title: child.name || "Child profile", intro: "The permanent information that supports every care session.",
        body: `<section class="panel secondary-panel child-profile-card"><div class="secondary-panel-heading"><h2 class="section-title">Child profile</h2>${editable ? '<button class="photo-source-btn secondary-add" type="button" data-edit="child">Edit</button>' : ""}</div><p class="supporting-copy">${esc(child.name || "Child")}${child.age ? ` · ${esc(child.age)}` : ""}</p></section><div class="secondary-grid">${careSection("food", "Food & allergies", data.allergies.items || [], editable)}${careSection("preferences", "Routine & preferences", data.categories.preferences.items || [], editable)}${careSection("where", "Where things are", data.categories.where.items || [], editable)}${careSection("instructions", "Instructions", data.categories.instructions.items || [], editable)}${careSection("emergency", "Emergency steps", data.categories.emergency.steps || [], editable)}${contactsSection(editable)}</div>${editNote}`,
      },
      profile: {
        eyebrow: "PROFILE & SETTINGS", title: ctx && ctx.role === "parent" ? "Your CareNest settings" : "Your sitter profile", intro: ctx && ctx.role === "parent" ? "Manage your details and the family space with confidence." : "Choose what parents can see, and keep your personal preferences in one place.",
        body: ctx && ctx.role === "parent" ? `<section class="secondary-grid"><article class="panel secondary-panel"><h2 class="section-title">My profile</h2><p class="supporting-copy">Your name and sign-in controls are available from the Account menu.</p></article><article class="panel secondary-panel"><h2 class="section-title">Manage household</h2><p class="supporting-copy">Use the Children and Schedule tabs to edit family care information directly where it is shown.</p><a class="secondary-link" href="people.html">People and invites</a></article><article class="panel secondary-panel"><h2 class="section-title">Notification preferences</h2><p class="supporting-copy">Notification controls will appear here as they become available.</p></article></section>` : sitterProfile(ctx || {}),
      },
    }[page];
    if (!views) return;
    document.title = `CareNest — ${views.title}`;
    root.innerHTML = `<header class="secondary-header"><p class="page-eyebrow">${views.eyebrow}</p><h1>${views.title}</h1><p>${views.intro}</p></header>${views.body}`;
    if (editable) bindEditors(ctx);
    if (page === "profile" && (!ctx || ctx.role !== "parent")) bindSitterProfile(ctx || {});
  }

  function bindEditors(ctx) {
    const client = ctx.client;
    const householdId = ctx.household.id;
    let dialog;
    function openDialog(title, fields, values, onSave, remove) {
      if (dialog) dialog.remove();
      dialog = document.createElement("dialog");
      dialog.className = "confirm-dialog manage-dialog";
      dialog.innerHTML = `<form class="confirm-dialog-body" method="dialog"><h2 class="panel-title">${esc(title)}</h2>${fields.map((field) => `<label class="field-label" for="inline-${field.name}">${field.label}</label>${field.type === "textarea" ? `<textarea class="text-input manage-textarea" id="inline-${field.name}" name="${field.name}" rows="3">${esc(values[field.name] || "")}</textarea>` : field.type === "select" ? `<select class="text-input" id="inline-${field.name}" name="${field.name}"><option value="">None</option>${field.options.map((option) => `<option value="${esc(option)}"${values[field.name] === option ? " selected" : ""}>${esc(option)}</option>`).join("")}</select>` : `<input class="text-input" id="inline-${field.name}" name="${field.name}" type="${field.type || "text"}" value="${esc(values[field.name] || "")}" />`}`).join("")}<p class="form-error" hidden></p><div class="moment-dialog-actions"><button class="primary-btn" value="save">Save</button>${remove ? '<button class="danger-btn" value="remove">Remove</button>' : ""}<button class="photo-source-btn" value="cancel">Cancel</button></div></form>`;
      document.body.appendChild(dialog);
      const form = dialog.querySelector("form");
      dialog.addEventListener("close", async () => {
        try {
          if (dialog.returnValue === "save") {
            const saved = Object.fromEntries(fields.map((field) => [field.name, form.elements[field.name].value.trim()]));
            const requiredField = fields.find((field) => field.required);
            if (requiredField && !saved[requiredField.name]) {
              throw new Error(`${requiredField.label} is required.`);
            }
            const result = await onSave(saved);
            if (result && result.error) throw result.error;
            window.location.reload();
          } else if (dialog.returnValue === "remove" && remove) {
            const result = await remove();
            if (result && result.error) throw result.error;
            window.location.reload();
          }
        } catch (error) {
          const errorEl = form.querySelector(".form-error");
          errorEl.textContent = auth.friendlyError(error);
          errorEl.hidden = false;
          dialog.showModal();
        }
      });
      dialog.showModal();
    }
    async function planId() {
      const current = await client.from("plans").select("id").eq("household_id", householdId).order("position").limit(1);
      if (current.error) throw current.error;
      if (current.data[0]) return current.data[0].id;
      const created = await client.from("plans").insert({ household_id: householdId, title: "Daily schedule" }).select("id").single();
      if (created.error) throw created.error;
      return created.data.id;
    }
    root.addEventListener("click", (event) => {
      const button = event.target.closest("[data-edit], [data-add]");
      if (!button) return;
      const kind = button.dataset.edit || button.dataset.add;
      const id = button.dataset.id;
      if (kind === "child") return openDialog("Edit child profile", [{ name: "child_name", label: "Name" }, { name: "child_age_label", label: "Age" }], { child_name: ctx.household.child_name || data.child.name, child_age_label: ctx.household.child_age_label || data.child.age }, (values) => client.from("households").update(values).eq("id", householdId));
      if (kind === "hours") return openDialog("Edit shift hours", [{ name: "schedule", label: "Usual shift hours" }], { schedule: data.child.shiftTime || "" }, async (values) => client.from("plans").update(values).eq("id", await planId()));
      if (kind === "task") {
        const row = data.schedule.find((item) => item.id === id) || {};
        const fields = [{ name: "title", label: "Task" }, { name: "time_of_day", label: "Time (for example 3:00pm)" }, { name: "detail", label: "Details", type: "textarea" }, { name: "location", label: "Location" }];
        return openDialog(row.id ? "Edit task" : "Add task", fields, { title: row.title, time_of_day: row.time || "", detail: row.detail || "", location: row.location || "" }, async (values) => {
          values.time_of_day = toDatabaseTime(values.time_of_day);
          return row.id ? client.from("tasks").update(values).eq("id", row.id) : client.from("tasks").insert(Object.assign(values, { plan_id: await planId(), position: data.schedule.length }));
        }, row.id ? () => client.from("tasks").update({ archived_at: new Date().toISOString() }).eq("id", row.id) : null);
      }
      if (kind === "contact") {
        const row = (data.contacts || []).find((item) => item.id === id) || {};
        const fields = [{ name: "name", label: "Name" }, { name: "role", label: "Role" }, { name: "phone", label: "Phone" }, { name: "address", label: "Address" }];
        return openDialog(row.id ? "Edit contact" : "Add contact", fields, row, (values) => row.id ? client.from("contacts").update(values).eq("id", row.id) : client.from("contacts").insert(Object.assign(values, { household_id: householdId, position: data.contacts.length })), row.id ? () => client.from("contacts").delete().eq("id", row.id) : null);
      }
      if (kind === "care") {
        const category = button.dataset.category;
        const source = category === "food" ? data.allergies.items : data.categories[category].items;
        const row = source.find((item) => item.id === id) || {};
        const fields = [{ name: "title", label: category === "food" ? "Food or allergy" : "Title", required: true }, { name: "detail", label: "Details", type: "textarea", required: false }].concat(category === "food" ? [{ name: "severity", label: "Severity", type: "select", options: ["Mild", "Moderate", "Severe"], required: false }] : []);
        const values = category === "food" ? { title: row.name, detail: row.description, severity: row.severity } : row;
        return openDialog(row.id ? `Edit ${category}` : `Add ${category}`, fields, values, (saved) => {
          if (category === "food" && !saved.severity) saved.severity = null;
          return row.id ? client.from("care_items").update(saved).eq("id", row.id) : client.from("care_items").insert(Object.assign(saved, { household_id: householdId, category, position: source.length }));
        }, row.id ? () => client.from("care_items").delete().eq("id", row.id) : null);
      }
    });
  }

  function toDatabaseTime(value) {
    const match = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(value || "");
    if (!match) return value || null;
    let hour = Number(match[1]);
    const minute = match[2];
    const period = (match[3] || "").toLowerCase();
    if (period === "pm" && hour < 12) hour += 12;
    if (period === "am" && hour === 12) hour = 0;
    return `${String(hour).padStart(2, "0")}:${minute}:00`;
  }
})();
