// children.html: the family's children (SI-46), one child's care info (SI-47), and the empty
// states (SI-48, SI-49). One family space at a time, the one the family bar has picked
// (js/active-family.js); a sitter in several families switches with that bar.
//
//   children.html            the family card and its children
//   children.html?child=ID   one child: their food, preferences, and instructions, plus the
//                            family-wide contacts and links to where things are and emergency steps
//
// Everyone in the family space sees the same information. Parents also get Add, Edit, and Delete,
// which write through RLS (or, in the demo, to this tab: js/data.js). Data comes from
// window.CareNestData (js/family-data.js signed in, js/data.js in the demo); helpers from
// js/children.js.
(function () {
  const auth = window.CareNestAuth;
  const ui = window.CareNestUI;
  const kids = window.CareNestChildren;
  const root = document.getElementById("children-content");
  if (!auth || !ui || !kids || !root) return;

  const esc = auth.escapeHtml;
  const demo = window.CareNestDemo;
  const ready = (window.CareNestFamily || auth).ready;
  const NO_INFO = "No information provided";

  const SECTIONS = [
    { key: "food", title: "Food & Allergies", icon: "assets/grocery.svg", noun: "food or allergy" },
    { key: "preferences", title: "Preferences", icon: "assets/favorite.svg", noun: "preference" },
    { key: "instructions", title: "Instructions", icon: "assets/assignment.svg", noun: "instruction" },
  ];
  const SEVERITIES = ["Mild", "Moderate", "Severe"];

  let ctx = null;

  ready.then((context) => {
    ctx = context;
    if (ctx && ctx.role === "parent") ui.renderParentNav("children");
    else ui.renderSitterNav("children");
    render();
    // A parent's edit on another device, or a switch of child in this tab.
    if (window.CareNestFamily && window.CareNestFamily.subscribe) window.CareNestFamily.subscribe(render);
    window.addEventListener("popstate", render);
  });

  const data = () => window.CareNestData;
  const isParent = () => Boolean(ctx && ctx.role === "parent");
  // Parents can edit when there is somewhere to save to: the database, or the demo tab.
  const editable = () => Boolean(isParent() && (ctx.demo ? demo : ctx.client && ctx.household));
  const client = () => (ctx.demo ? demo.client : ctx.client);

  // Links keep the page's other parameters (?as=parent, ?demo=1).
  function hrefFor(childId) {
    const url = new URL(window.location.href);
    if (childId) url.searchParams.set("child", childId);
    else url.searchParams.delete("child");
    return `${url.pathname.split("/").pop()}${url.search}`;
  }

  function infoHref(category) {
    const asParent = new URLSearchParams(window.location.search).get("as") === "parent";
    return `info.html?category=${category}${asParent ? "&as=parent" : ""}`;
  }

  function avatar(name, size) {
    return `<span class="child-avatar child-avatar--${size}" aria-hidden="true">${esc(kids.initials(name))}</span>`;
  }

  function details(child) {
    const parts = kids.detailParts(child);
    return parts.length ? `<p class="child-details">${parts.map(esc).join('<span class="child-dot" aria-hidden="true"></span>')}</p>` : "";
  }

  function render() {
    // A live update arriving mid-switch must not bring the previous family's children back.
    if (switching) return;
    if (!ctx || !ctx.household) {
      root.innerHTML = noFamilyHtml();
      return;
    }
    const id = new URLSearchParams(window.location.search).get("child");
    if (!id) {
      root.innerHTML = listHtml();
      document.title = "CareNest — Children";
      return;
    }
    const child = kids.findChild(data(), id);
    root.innerHTML = child ? detailHtml(child) : goneHtml();
    document.title = `CareNest — ${child ? kids.displayName(child) : "Children"}`;
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- empty states

  // SI-48. A signed-in account with no family space normally lands on onboarding or an invite
  // first; this is what the tab shows if it gets here anyway.
  function noFamilyHtml() {
    return `<header class="children-header"><h1>Children</h1></header>
      <section class="children-empty" aria-live="polite">
        <h2>No families added yet</h2>
        <p>Ask the family you sit for to send you an invitation.</p>
      </section>`;
  }

  function goneHtml() {
    return `<header class="children-header"><h1>Children</h1></header>
      <section class="children-empty">
        <h2>This child isn’t in this family space</h2>
        <p>They may have been removed, or the family bar is showing a different family.</p>
        <a class="primary-btn children-empty-action" href="${esc(hrefFor(null))}" data-route>Back to children</a>
      </section>`;
  }

  // ---------------------------------------------------------------- list (SI-46)

  function listHtml() {
    const family = data();
    const children = family.children || [];
    const name = family.familyName || (ctx.household && ctx.household.name) || "Your family";
    const sit = kids.nextSit(family.appointments || []);
    const sitTag = sit
      ? `<p class="sit-tag${sit.soon ? " sit-tag--soon" : ""}">Next sit: ${esc(sit.text)}</p>`
      : '<p class="sit-tag">No scheduled sits</p>';
    const rows = children.map(childRowHtml).join("");
    const empty = isParent()
      ? `<div class="children-none"><p>No children added yet.</p><p>Add each child so your sitter sees their own food, preferences, and instructions.</p></div>`
      : '<div class="children-none"><p>No children added yet.</p><p>The family hasn’t added their children.</p></div>';
    return `<header class="children-header"><h1>Children</h1></header>
      ${pinHtml(name, sitTag)}
      <section class="family-card" aria-labelledby="family-card-name" data-household="${esc(ctx.household.id)}">
        ${familyDetailsHtml(family)}
        <h3 class="children-count">Children (${children.length})</h3>
        ${children.length ? `<ul class="children-list">${rows}</ul>` : empty}
        ${editable() ? '<button type="button" class="primary-btn children-add" data-add-child>Add a child</button>' : ""}
        ${isParent() && !ctx.demo ? '<a class="secondary-link" href="manage.html">Home address, primary contact, and more in Family info</a>' : ""}
      </section>
      ${editable() ? familyWideHtml(family) : ""}`;
  }

  // ---------------------------------------------------------------- pinned household (SI-68)
  //
  // The household this care session is for stays pinned to the top of the list while the
  // children scroll under it. A sitter in several families can switch household from the pin (or
  // the family bar) without leaving this page: the pin shows the new household straight away and
  // the old family's children are cleared before the page reloads with the new family's data, so
  // a child from the previous family is never shown under the new household's name.

  // The caller's other families, for the pin's switcher. Empty with one family.
  function otherFamilies() {
    const list = (ctx && ctx.memberships) || [];
    return list.length > 1 ? list : [];
  }

  function familyName(membership) {
    return (membership && membership.households && membership.households.name) || "Family space";
  }

  function pinHtml(name, sitTag) {
    const families = otherFamilies();
    const label = isParent() ? "Your household" : "Current household";
    const switcher = families.length
      ? `<label class="household-pin-switch">
          <span class="visually-hidden">Switch household</span>
          <select data-household-switch>
            ${families
              .map((m) => `<option value="${esc(m.household_id)}"${m.household_id === ctx.household.id ? " selected" : ""}>${esc(familyName(m))}</option>`)
              .join("")}
          </select>
        </label>`
      : "";
    return `<section class="household-pin" aria-labelledby="family-card-name" data-household="${esc(ctx.household.id)}">
        <div class="household-pin-text">
          <p class="household-pin-label">${label}</p>
          <h2 id="family-card-name">${esc(name)}</h2>
          ${sitTag}
        </div>
        ${switcher}
      </section>`;
  }

  // While a switch is under way: the new household pinned, and no children until its data loads.
  function switchingHtml(membership) {
    return `<header class="children-header"><h1>Children</h1></header>
      <section class="household-pin" aria-labelledby="family-card-name" data-household="${esc(membership.household_id)}">
        <div class="household-pin-text">
          <p class="household-pin-label">${isParent() ? "Your household" : "Current household"}</p>
          <h2 id="family-card-name">${esc(familyName(membership))}</h2>
          <p class="sit-tag">Loading…</p>
        </div>
      </section>
      <section class="family-card children-switching" aria-busy="true" aria-live="polite">
        <p class="family-details-empty">Loading ${esc(familyName(membership))}’s children…</p>
      </section>`;
  }

  let switching = null;

  // Same choice js/auth.js's switchFamily records, but stays on the Children list.
  function switchHousehold(householdId) {
    if (!ctx || !ctx.household || householdId === ctx.household.id || switching) return;
    const target = (ctx.memberships || []).find((m) => m.household_id === householdId);
    if (!target) return;
    switching = target;
    document.querySelectorAll("#family-bar-select, [data-household-switch]").forEach((select) => {
      select.value = householdId;
      select.disabled = true;
    });
    root.innerHTML = switchingHtml(target);
    if (ctx.demo) {
      if (demo && demo.switchTo) demo.switchTo(householdId);
    } else if (window.CareNestFamilies && ctx.user) {
      window.CareNestFamilies.remember(ctx.user.id, householdId);
    }
    window.location.replace(hrefFor(null));
  }

  // The family bar (js/auth.js) sends every other page to that family's home; on the Children
  // page it switches in place instead, so the sitter keeps their place on this tab. Capture runs
  // before the bar's own listener.
  document.addEventListener(
    "change",
    (event) => {
      const select = event.target;
      if (!(select instanceof HTMLSelectElement)) return;
      if (select.id !== "family-bar-select" && !select.hasAttribute("data-household-switch")) return;
      if (!ctx || !ctx.household) return;
      event.stopImmediatePropagation();
      switchHousehold(select.value);
    },
    true
  );

  // Parents only: the family-wide info, editable where it is listed. Sitters reach it through
  // Good to know on each child's page.
  const FAMILY_WIDE = [
    { key: "where", title: "Where things are", noun: "item" },
    { key: "emergency", title: "Emergency steps", noun: "step" },
    { key: "contacts", title: "Contacts", noun: "contact" },
  ];

  function familyRows(family, key) {
    if (key === "contacts") return (family.contacts || []).map((c) => ({ id: c.id, title: c.name, detail: [c.role, c.phone].filter(Boolean).join(" · ") }));
    const source = key === "emergency" ? family.categories.emergency.steps : family.categories.where.items;
    return (source || []).map((item) => ({ id: item.id, title: item.title, detail: item.detail }));
  }

  function familyWideHtml(family) {
    return `<section class="family-wide" aria-labelledby="family-wide-title">
        <h2 class="child-section-title" id="family-wide-title">Shared by the whole family</h2>
        ${FAMILY_WIDE.map((section) => {
          const rows = familyRows(family, section.key);
          return `<section class="child-card-section" aria-labelledby="family-${section.key}">
            <div class="child-section-head">
              <h3 class="child-section-title" id="family-${section.key}">${section.title}</h3>
              <button type="button" class="photo-source-btn child-add-item" data-add-family="${section.key}">Add</button>
            </div>
            ${rows.length
              ? `<ul class="child-notes">${rows
                  .map((row) => `<li class="child-note"><p class="child-note-title">${esc(row.title)}</p>${row.detail ? `<p class="child-note-detail">${esc(row.detail)}</p>` : ""}<button type="button" class="child-item-edit" data-edit-family="${section.key}" data-id="${esc(row.id)}" aria-label="Edit ${esc(row.title)}">Edit</button></li>`)
                  .join("")}</ul>`
              : `<p class="child-no-info">${NO_INFO}</p>`}
          </section>`;
        }).join("")}
      </section>`;
  }

  // Primary contact on the left; their phone and the home address on the right (Figma 210:155).
  function familyDetailsHtml(family) {
    const primary = family.primaryContact;
    const address = family.homeAddress;
    if (!primary && !address) {
      return isParent() && !ctx.demo
        ? '<p class="family-details-empty">No primary contact or home address yet. Add them in Family info.</p>'
        : "";
    }
    const person = primary
      ? `<div class="family-detail">
          ${ui.avatarHtml(primary.avatar, primary.name, "contact-avatar", 32)}
          <div><p class="family-detail-name">${esc(primary.name)}</p>${primary.role ? `<p class="family-detail-sub">${esc(primary.role)}</p>` : ""}</div>
        </div>`
      : "";
    const phone = primary && primary.phone
      ? `<p class="family-detail-line"><img src="assets/call.svg" alt="" width="15" height="15" />${primary.phoneHref ? `<a href="${esc(primary.phoneHref)}">${esc(primary.phone)}</a>` : esc(primary.phone)}</p>`
      : "";
    const home = address
      ? `<p class="family-detail-line"><img src="assets/location.svg" alt="" width="15" height="15" /><span><span class="visually-hidden">Home address: </span>${esc(address)}</span></p>`
      : "";
    return `<div class="family-details">${person}${phone || home ? `<div class="family-detail family-detail--lines">${phone}${home}</div>` : ""}</div>`;
  }

  function childRowHtml(child) {
    const severe = kids.severeAllergies(child);
    const name = kids.displayName(child);
    return `<li class="child-card">
        <a class="child-row" href="${esc(hrefFor(child.id))}" data-route>
          ${avatar(name, "large")}
          <span class="child-row-text"><span class="child-name">${esc(name)}</span>${details(child)}</span>
          <span class="child-chevron" aria-hidden="true">›</span>
        </a>
        ${severe.length ? `<p class="child-tag child-tag--severe"><strong>Severe allergies:</strong> ${esc(severe.join(", "))}</p>` : ""}
        ${child.pinnedNote ? `<p class="child-tag"><span class="visually-hidden">Note: </span>${esc(child.pinnedNote)}</p>` : ""}
      </li>`;
  }

  // ---------------------------------------------------------------- detail (SI-47, SI-49)

  function detailHtml(child) {
    const family = data();
    const name = kids.displayName(child);
    const can = editable();
    return `<header class="children-header children-header--detail">
        <a class="children-back" href="${esc(hrefFor(null))}" data-route aria-label="Back to all children"><img src="assets/back.svg" alt="" width="28" height="28" /></a>
        <p class="children-header-family">${esc(family.familyName || "Children")}</p>
      </header>
      <section class="child-hero" aria-labelledby="child-name">
        ${avatar(name, "large")}
        <div class="child-hero-text"><h1 id="child-name">${esc(name)}</h1>${details(child)}</div>
        ${can ? `<button type="button" class="photo-source-btn child-edit" data-edit-child="${esc(child.id)}">Edit</button>` : ""}
      </section>
      ${child.pinnedNote ? `<p class="child-tag child-tag--pinned"><span class="visually-hidden">Note: </span>${esc(child.pinnedNote)}</p>` : ""}
      ${SECTIONS.map((section) => sectionHtml(child, section, can)).join("")}
      ${contactsHtml(family)}
      <section class="child-card-section" aria-labelledby="child-know">
        <h2 class="child-section-title" id="child-know">Good to know</h2>
        <p class="child-know-note">Shared by the whole family.</p>
        <div class="child-know-tiles">
          <a class="know-tile" href="${esc(infoHref("where"))}"><img src="assets/orders.svg" alt="" width="24" height="24" /><span>Where things are</span></a>
          <a class="know-tile" href="${esc(infoHref("emergency"))}"><img src="assets/emergency.svg" alt="" width="24" height="24" /><span>Emergency steps</span></a>
        </div>
      </section>
      ${can ? `<button type="button" class="danger-btn child-delete" data-delete-child="${esc(child.id)}">Delete ${esc(kids.firstName(child))}</button>` : ""}`;
  }

  function sectionHtml(child, section, can) {
    const items = child[section.key] || [];
    const body = items.length || (section.key === "food" && child.careNote)
      ? section.key === "food"
        ? foodHtml(child, can)
        : `<ul class="child-notes">${items.map((item) => noteHtml(item, section, can)).join("")}</ul>`
      : `<p class="child-no-info">${NO_INFO}</p>`;
    return `<section class="child-card-section" aria-labelledby="child-${section.key}">
        <div class="child-section-head">
          <h2 class="child-section-title" id="child-${section.key}"><img src="${section.icon}" alt="" width="24" height="24" />${section.title}</h2>
          ${can ? `<button type="button" class="photo-source-btn child-add-item" data-add-item="${section.key}">Add</button>` : ""}
        </div>
        ${body}
      </section>`;
  }

  function foodHtml(child, can) {
    const rows = child.food
      .map(
        (item) => `<article class="restriction-item">
          ${item.image ? `<img class="restriction-thumb" src="${esc(item.image)}" alt="" width="64" height="64" />` : ""}
          <div class="restriction-content">
            <div class="restriction-top">
              <h3 class="restriction-name">${esc(item.name)}</h3>
              ${item.severity ? `<span class="badge ${esc(item.severityClass || "")}">${esc(item.severity)}</span>` : ""}
            </div>
            ${item.description ? `<p class="restriction-desc">${esc(item.description)}</p>` : ""}
            ${can ? editButton("food", item.id, item.name) : ""}
          </div>
        </article>`
      )
      .join("");
    const note = child.careNote ? `<div class="child-care-note"><p class="child-care-note-title">Care note</p><p>${esc(child.careNote)}</p></div>` : "";
    return `<div class="child-food">${rows}${note}</div>`;
  }

  function noteHtml(item, section, can) {
    return `<li class="child-note"><p class="child-note-title">${esc(item.title)}</p>${item.detail ? `<p class="child-note-detail">${esc(item.detail)}</p>` : ""}${can ? editButton(section.key, item.id, item.title) : ""}</li>`;
  }

  function editButton(category, id, name) {
    return `<button type="button" class="child-item-edit" data-edit-item="${esc(category)}" data-id="${esc(id)}" aria-label="Edit ${esc(name)}">Edit</button>`;
  }

  function contactsHtml(family) {
    const contacts = family.contacts || [];
    const rows = contacts.length
      ? contacts
          .map(
            (contact) => `<li class="child-contact">
              ${ui.avatarHtml(contact.avatar, contact.name, "contact-avatar", 32)}
              <div class="child-contact-text"><p><strong>${esc(contact.name)}</strong>${contact.role ? ` (${esc(contact.role)})` : ""}</p>${contact.phone ? `<p>${esc(contact.phone)}</p>` : ""}</div>
              ${contact.phoneHref ? `<a class="call-btn" href="${esc(contact.phoneHref)}" aria-label="Call ${esc(contact.name)}"><img src="assets/call.svg" alt="" width="23" height="22" /></a>` : ""}
            </li>`
          )
          .join("")
      : "";
    return `<section class="child-card-section" aria-labelledby="child-contacts">
        <h2 class="child-section-title" id="child-contacts">Contacts</h2>
        ${contacts.length ? `<ul class="child-contacts">${rows}</ul>` : `<p class="child-no-info">${NO_INFO}</p>`}
      </section>`;
  }

  // ---------------------------------------------------------------- parent editing

  // fields: [{ name, label, type?, options?, required?, value }]. Resolves to the values, null on
  // cancel, or "remove" when `removable` and the parent chose Remove.
  function formDialog(title, fields, removable) {
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      dialog.className = "confirm-dialog manage-dialog";
      dialog.setAttribute("aria-labelledby", "child-dialog-title");
      dialog.innerHTML = `<form class="confirm-dialog-body" method="dialog" novalidate>
          <h2 class="panel-title" id="child-dialog-title">${esc(title)}</h2>
          ${fields
            .map((field) => {
              const id = `child-field-${field.name}`;
              const label = `<label class="field-label" for="${id}">${esc(field.label)}${field.required ? "" : ' <span class="field-optional">(optional)</span>'}</label>`;
              if (field.type === "textarea") return `${label}<textarea class="text-input manage-textarea" id="${id}" name="${field.name}" rows="3" maxlength="${field.max || 2000}">${esc(field.value || "")}</textarea>`;
              if (field.type === "select") return `${label}<select class="text-input" id="${id}" name="${field.name}"><option value="">None</option>${field.options.map((o) => `<option${o === field.value ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
              return `${label}<input class="text-input" id="${id}" name="${field.name}" maxlength="${field.max || 140}" value="${esc(field.value || "")}"${field.placeholder ? ` placeholder="${esc(field.placeholder)}"` : ""} autocomplete="off" />`;
            })
            .join("")}
          <p class="form-error" role="alert" hidden></p>
          <div class="moment-dialog-actions">
            <button class="primary-btn" value="save">Save</button>
            ${removable ? '<button class="danger-btn" type="button" data-remove>Remove</button>' : ""}
            <button class="photo-source-btn" value="cancel" type="button" data-cancel>Cancel</button>
          </div>
        </form>`;
      document.body.appendChild(dialog);
      const form = dialog.querySelector("form");
      const errorEl = dialog.querySelector(".form-error");
      dialog.querySelector("[data-cancel]").addEventListener("click", () => dialog.close("cancel"));
      const remove = dialog.querySelector("[data-remove]");
      if (remove) remove.addEventListener("click", () => dialog.close("remove"));
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const values = Object.fromEntries(fields.map((field) => [field.name, form.elements[field.name].value.trim()]));
        const missing = fields.find((field) => field.required && !values[field.name]);
        if (missing) {
          errorEl.textContent = `Please enter a ${missing.label.toLowerCase()}.`;
          errorEl.hidden = false;
          form.elements[missing.name].focus();
          return;
        }
        dialog.close("save");
        resolve(values);
      });
      dialog.addEventListener("close", () => {
        if (dialog.returnValue === "remove") resolve("remove");
        else if (dialog.returnValue !== "save") resolve(null);
        dialog.remove();
      });
      dialog.showModal();
    });
  }

  // RLS turns a refused write into zero rows, not an error.
  async function written(promise, message) {
    const result = await promise;
    if (result.error) throw result.error;
    if (!result.data || !(Array.isArray(result.data) ? result.data.length : result.data.id)) {
      throw Object.assign(new Error(message || "This couldn't be saved. It may have been changed or removed. Reload the page and try again."), { friendly: true });
    }
    return result.data;
  }

  function showError(error) {
    const text = error && error.friendly ? error.message : auth.friendlyError(error);
    const status = document.createElement("p");
    status.className = "form-error children-error";
    status.setAttribute("role", "alert");
    status.textContent = text;
    root.querySelectorAll(".children-error").forEach((el) => el.remove());
    root.prepend(status);
    window.scrollTo(0, 0);
  }

  // After a save: the demo keeps this tab's copy (js/data.js), so render it; signed in, reload
  // so js/family-data.js reads what the database now holds.
  function done() {
    if (ctx.demo) render();
    else window.location.reload();
  }

  const childFields = (child) => [
    { name: "name", label: "Name", required: true, max: 80, value: child && child.name },
    { name: "age_label", label: "Age", max: 40, value: child && child.age, placeholder: 'For example "Age 3" or "11 months"' },
    { name: "stage_label", label: "Stage", max: 40, value: child && child.stage, placeholder: 'For example "Preschooler" or "1st Grader"' },
    { name: "pinned_note", label: "Pinned note", max: 200, value: child && child.pinnedNote, placeholder: 'For example "Recovering from a cold"' },
  ];

  async function addChild() {
    const values = await formDialog("Add a child", childFields(null));
    if (!values) return;
    const children = data().children || [];
    const position = children.reduce((max, c) => Math.max(max, c.position || 0), -1) + 1;
    try {
      const rows = await written(
        client().from("children").insert(Object.assign(values, { household_id: ctx.household.id, position })).select("id")
      );
      const id = Array.isArray(rows) ? rows[0].id : rows.id;
      if (id) window.history.pushState(null, "", hrefFor(id));
      done();
    } catch (error) {
      showError(error);
    }
  }

  async function editChild(child) {
    const values = await formDialog(`Edit ${kids.displayName(child)}`, childFields(child));
    if (!values) return;
    try {
      await written(client().from("children").update(values).eq("id", child.id).select("id"));
      done();
    } catch (error) {
      showError(error);
    }
  }

  // Deleting a child deletes their own care info with them (the database cascades). The
  // confirmation names what goes (product question for Kelvin, recommended in the PR).
  async function deleteChild(child) {
    const first = kids.firstName(child);
    const counts = [
      [child.food.length, "food or allergy entry", "food and allergy entries"],
      [child.preferences.length, "preference", "preferences"],
      [child.instructions.length, "instruction", "instructions"],
    ]
      .filter(([n]) => n)
      .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
    const list = counts.length > 1 ? `${counts.slice(0, -1).join(", ")} and ${counts[counts.length - 1]}` : counts[0];
    const ok = await auth.confirmDialog({
      title: `Delete ${kids.displayName(child)}?`,
      body: `${counts.length ? `This also deletes ${first}'s ${list}.` : `Nothing else is saved for ${first} yet.`} Your sitter will no longer see any of it. This cannot be undone.`,
      confirmLabel: "Delete child",
      danger: true,
    });
    if (!ok) return;
    try {
      await written(client().from("children").delete().eq("id", child.id).select("id"), "This couldn't be deleted. Reload the page and try again.");
      window.history.pushState(null, "", hrefFor(null));
      done();
    } catch (error) {
      showError(error);
    }
  }

  function itemFields(category, item) {
    const fields = [
      { name: "title", label: category === "food" ? "Food or allergy" : "Title", required: true, max: 140, value: item && (item.title || item.name) },
      { name: "detail", label: "Details", type: "textarea", max: 2000, value: item && (item.detail || item.description) },
    ];
    if (category === "food") fields.push({ name: "severity", label: "Severity", type: "select", options: SEVERITIES, value: item && item.severity });
    return fields;
  }

  async function saveItem(child, category, item) {
    const section = SECTIONS.find((s) => s.key === category);
    const values = await formDialog(`${item ? "Edit" : "Add"} ${section.noun} for ${kids.firstName(child)}`, itemFields(category, item), Boolean(item));
    if (!values) return;
    if (values === "remove") {
      const ok = await auth.confirmDialog({
        title: `Remove ${item.title || item.name}?`,
        body: "Your sitter will no longer see this. This can't be undone.",
        confirmLabel: "Remove",
        danger: true,
      });
      if (!ok) return;
      try {
        await written(client().from("care_items").delete().eq("id", item.id).select("id"), "This couldn't be removed. Reload the page and try again.");
        done();
      } catch (error) {
        showError(error);
      }
      return;
    }
    if (category === "food") values.severity = values.severity || null;
    try {
      if (item) {
        await written(client().from("care_items").update(values).eq("id", item.id).select("id"));
      } else {
        const position = (child[category] || []).length;
        await written(
          client()
            .from("care_items")
            .insert(Object.assign(values, { household_id: ctx.household.id, child_id: child.id, category, position }))
            .select("id")
        );
      }
      done();
    } catch (error) {
      showError(error);
    }
  }

  async function saveFamilyItem(key, id) {
    const family = data();
    const section = FAMILY_WIDE.find((s) => s.key === key);
    const isContact = key === "contacts";
    const existing = id
      ? isContact
        ? (family.contacts || []).find((c) => c.id === id)
        : (key === "emergency" ? family.categories.emergency.steps : family.categories.where.items).find((item) => item.id === id)
      : null;
    if (id && !existing) return;
    const fields = isContact
      ? [
          { name: "name", label: "Name", required: true, max: 80, value: existing && existing.name },
          { name: "role", label: "Role", max: 40, value: existing && existing.role },
          { name: "phone", label: "Phone", max: 40, value: existing && existing.phone },
          { name: "address", label: "Address", max: 200, value: existing && existing.address },
        ]
      : [
          { name: "title", label: "Title", required: true, max: 140, value: existing && existing.title },
          { name: "detail", label: "Details", type: "textarea", max: 2000, value: existing && existing.detail },
        ];
    const values = await formDialog(`${existing ? "Edit" : "Add"} ${section.noun}`, fields, Boolean(existing));
    if (!values) return;
    const table = isContact ? "contacts" : "care_items";
    try {
      if (values === "remove") {
        const ok = await auth.confirmDialog({
          title: `Remove ${existing.name || existing.title}?`,
          body: "Your sitter will no longer see this. This can't be undone.",
          confirmLabel: "Remove",
          danger: true,
        });
        if (!ok) return;
        await written(client().from(table).delete().eq("id", existing.id).select("id"), "This couldn't be removed. Reload the page and try again.");
      } else if (existing) {
        await written(client().from(table).update(values).eq("id", existing.id).select("id"));
      } else {
        const position = familyRows(family, key).length;
        const row = Object.assign(values, { household_id: ctx.household.id, position }, isContact ? {} : { category: key });
        await written(client().from(table).insert(row).select("id"));
      }
      done();
    } catch (error) {
      showError(error);
    }
  }

  root.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-route]");
    if (link && !event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) {
      event.preventDefault();
      window.history.pushState(null, "", link.getAttribute("href"));
      render();
      return;
    }
    if (!editable()) return;
    const button = event.target.closest("button");
    if (!button) return;
    const child = kids.findChild(data(), new URLSearchParams(window.location.search).get("child"));
    if (button.matches("[data-add-child]")) addChild();
    else if (button.dataset.addFamily) saveFamilyItem(button.dataset.addFamily, null);
    else if (button.dataset.editFamily) saveFamilyItem(button.dataset.editFamily, button.dataset.id);
    else if (button.dataset.editChild && child) editChild(child);
    else if (button.dataset.deleteChild && child) deleteChild(child);
    else if (button.dataset.addItem && child) saveItem(child, button.dataset.addItem, null);
    else if (button.dataset.editItem && child) {
      const item = (child[button.dataset.editItem] || []).find((i) => i.id === button.dataset.id);
      if (item) saveItem(child, button.dataset.editItem, item);
    }
  });
})();
