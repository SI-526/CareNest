// Schedule, care log, and profile/settings pages (children.html is js/children-page.js). Parents see the same
// information as sitters and can edit family-owned information in place.
(function () {
  const data = window.CareNestData;
  const page = document.body.dataset.page;
  const ui = window.CareNestUI;
  const auth = window.CareNestAuth;
  const root = document.getElementById("secondary-content");
  if (!data || !ui || !root || !auth) return;

  const esc = auth.escapeHtml;
  // Demo mode only (js/data.js): edits are kept in this browser tab until it is closed.
  const demo = window.CareNestDemo;
  const ready = (window.CareNestFamily || auth).ready;
  // Loaded once before the page renders: the signed-in sitter's own profile (profile page) or
  // the fields this family's sitters chose to share (parent schedule page).
  let sitterProfileState = null;
  let sharedSitter = null;
  // The schedule page's re-sync with window.CareNestData (set by bindSchedule).
  let syncSchedule = null;

  ready.then(async (ctx) => {
    const isParent = ctx && ctx.role === "parent";
    if (isParent) ui.renderParentNav(page === "carelog" ? "care-log" : page);
    else ui.renderSitterNav(page === "carelog" ? "care-log" : page);
    if (page === "profile" && !isParent) sitterProfileState = await loadSitterProfile(ctx);
    if (page === "schedule" && isParent) sharedSitter = await loadSharedSitter(ctx);
    render(ctx);
    // Live (SI-50): a parent's new session reaches the sitter, and a sitter's schedule request
    // (or its dismissal or auto-clear) reaches every member, without a reload. Only the schedule
    // view re-renders, keeping its selected date and view; the editors' listeners bind once.
    if (page === "schedule" && window.CareNestFamily && window.CareNestFamily.subscribe) {
      window.CareNestFamily.subscribe(() => { if (syncSchedule) syncSchedule(); });
    }
  });

  // The sitter profile lives in public.sitter_profiles. Parents never read that table; they get
  // only the shared fields through household_sitter_profiles(), filtered in the database.
  const PROFILE_COLUMNS = "display_name, bio, phone, availability, show_bio, show_phone, show_availability, wants_updates";
  const legacyProfileKey = (userId) => `carenest:sitter-profile:${userId}`;
  const dropLegacyProfile = (userId) => { try { localStorage.removeItem(legacyProfileKey(userId)); } catch (e) { /* nothing stored */ } };
  const profileDefaults = () => ({
    name: data.babysitter && data.babysitter.name || "",
    bio: "",
    phone: "",
    availability: "",
    showBio: true,
    showPhone: false,
    showAvailability: true,
    updates: true,
  });
  const profileFromRow = (row) => ({
    name: row.display_name, bio: row.bio, phone: row.phone, availability: row.availability,
    showBio: row.show_bio, showPhone: row.show_phone, showAvailability: row.show_availability, updates: row.wants_updates,
  });
  const profileToRow = (profile) => ({
    display_name: String(profile.name || "").slice(0, 80),
    bio: String(profile.bio || "").slice(0, 500),
    phone: String(profile.phone || "").slice(0, 40),
    availability: String(profile.availability || "").slice(0, 160),
    show_bio: Boolean(profile.showBio),
    show_phone: Boolean(profile.showPhone),
    show_availability: Boolean(profile.showAvailability),
    wants_updates: Boolean(profile.updates),
  });
  const saveProfile = (ctx, profile) => ctx.client.from("sitter_profiles").upsert(profileToRow(profile), { onConflict: "user_id" });

  async function loadSitterProfile(ctx) {
    const defaults = profileDefaults();
    // Demo: Bethany's sample profile, with this tab's edits (js/data.js).
    if (ctx && ctx.demo && demo) return { profile: demo.loadSitterProfile() };
    if (!ctx || ctx.demo || !ctx.client || !ctx.user) return { profile: defaults };
    const { data: row, error } = await ctx.client.from("sitter_profiles").select(PROFILE_COLUMNS).eq("user_id", ctx.user.id).maybeSingle();
    if (error) return { profile: defaults, error };
    if (row) {
      dropLegacyProfile(ctx.user.id);
      return { profile: profileFromRow(row) };
    }
    // One-time move of a profile saved on this device before profiles reached the database.
    let legacy = null;
    try { legacy = JSON.parse(localStorage.getItem(legacyProfileKey(ctx.user.id)) || "null"); } catch (e) { /* unreadable: start fresh */ }
    if (!legacy || typeof legacy !== "object") return { profile: defaults };
    const profile = { ...defaults };
    Object.keys(defaults).forEach((name) => { if (name in legacy) profile[name] = legacy[name]; });
    // Insert only: if another device saved a profile meanwhile, that newer row wins over this copy.
    const moved = await ctx.client.from("sitter_profiles").upsert(profileToRow(profile), { onConflict: "user_id", ignoreDuplicates: true });
    if (moved.error) return { profile, error: moved.error };
    dropLegacyProfile(ctx.user.id);
    const { data: stored, error: reread } = await ctx.client.from("sitter_profiles").select(PROFILE_COLUMNS).eq("user_id", ctx.user.id).maybeSingle();
    if (reread || !stored) return { profile, error: reread || undefined };
    return { profile: profileFromRow(stored) };
  }

  async function loadSharedSitter(ctx) {
    if (!ctx || ctx.demo || !ctx.client || !ctx.household) return null;
    const { data: rows, error } = await ctx.client.rpc("household_sitter_profiles", { target_household_id: ctx.household.id });
    if (error || !rows || !rows.length) return null;
    const userId = data.babysitter && data.babysitter.userId;
    return rows.find((row) => row.user_id === userId) || rows[0];
  }

  function taskRows(editable) {
    if (!data.schedule.length) return '<li class="secondary-row"><span><strong>No tasks yet</strong><small>Add the first task for this session.</small></span></li>';
    return data.schedule.map((item) => `<li class="secondary-row"><span class="secondary-time">${esc(item.time || "Any time")}</span><span><strong>${esc(item.title)}</strong><small>${esc(item.detail || item.location || "Details available in the session")}</small></span>${editable ? `<button class="photo-source-btn secondary-row-action" type="button" data-edit="task" data-id="${esc(item.id)}">Edit</button>` : ""}</li>`).join("");
  }

  const { dateKey, parseDate, addDays } = window.CareNestDates;
  const timeValue = (value) => {
    const match = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(value || "");
    if (!match) return Number.MAX_SAFE_INTEGER;
    let hours = Number(match[1]);
    if (match[3] && match[3].toLowerCase() === "pm" && hours !== 12) hours += 12;
    if (match[3] && match[3].toLowerCase() === "am" && hours === 12) hours = 0;
    return hours * 60 + Number(match[2]);
  };
  const displayDate = (key, includeYear) => parseDate(key).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", ...(includeYear ? { year: "numeric" } : {}) });
  const displayMonth = (key) => parseDate(key).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const sessionHours = (item) => `${item.start_time || ""}${item.end_time ? ` – ${item.end_time}` : ""}`;
  const initials = (name) => String(name || "CareNest").split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase();
  // "3:00 PM" or "3:00pm" to "15:00" for an <input type="time">; anything else gives the fallback.
  const inputTime = (value, fallback) => {
    const found = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(value || "");
    if (!found) return fallback;
    let hour = Number(found[1]);
    if (found[3].toLowerCase() === "pm" && hour < 12) hour += 12;
    if (found[3].toLowerCase() === "am" && hour === 12) hour = 0;
    return `${String(hour).padStart(2, "0")}:${found[2]}`;
  };
  // Appointments and tasks hang off a plan, but onboarding doesn't create one. A family's first
  // booking or task makes it here, so a save never depends on a plan that isn't there yet.
  async function ensurePlanId(ctx) {
    if (ctx.demo) return "demo-plan";
    if (data.planId) return data.planId;
    const client = ctx.client;
    const householdId = ctx.household.id;
    const current = await client.from("plans").select("id").eq("household_id", householdId).order("position").limit(1);
    if (current.error) throw current.error;
    if (current.data[0]) return (data.planId = current.data[0].id);
    const created = await client.from("plans").insert({ household_id: householdId, title: "Daily schedule" }).select("id").single();
    if (created.error) throw created.error;
    return (data.planId = created.data.id);
  }

  function demoAppointments() {
    const today = new Date();
    const start = dateKey(today);
    return [
      { id: "today", date: start, start_time: "3:00 PM", end_time: "7:00 PM", note: "", activities: data.schedule.slice() },
      { id: "upcoming-one", date: addDays(start, 3), start_time: "6:00 PM", end_time: "10:00 PM", note: "", activities: [] },
      { id: "upcoming-two", date: addDays(start, 5), start_time: "11:00 AM", end_time: "5:00 PM", note: "", activities: [] },
    ];
  }

  function schedulePage(ctx, editable) {
    const appointments = (data.appointments && data.appointments.length ? data.appointments : (ctx && ctx.demo ? demoAppointments() : [])).slice();
    const today = dateKey(new Date());
    const people = `<div class="schedule-people"><span class="schedule-avatar">${esc(initials(data.child && data.child.name))}</span><span class="schedule-avatar schedule-avatar--sitter">${esc(initials(data.babysitter && data.babysitter.name))}</span></div>`;
    const current = editable
      ? `<section class="current-shift-card current-session-card"><div class="current-session-title"><div><p class="schedule-card-title">Current Session</p><p class="schedule-card-meta"><strong>${esc(displayDate(today))}</strong><span data-current-session-time></span></p></div><button type="button" class="schedule-icon-button" data-edit-schedule aria-label="Edit current session">✎</button></div><div class="current-session-people"><div><strong>Children</strong>${people}</div><div><strong>Caregiver</strong><span class="caregiver-name">${esc(sharedSitter && sharedSitter.display_name || data.babysitter && data.babysitter.name || "Caregiver")}</span>${caregiverDetails()}</div></div></section>`
      : `<section class="current-shift-card"><div><p class="schedule-card-title">Current Shift</p><p class="schedule-card-meta"><strong>${esc(displayDate(today))}</strong><span data-current-session-time></span></p></div>${people}</section>`;
    return `<section class="schedule-page${editable ? " schedule-page--parent" : ""}" data-schedule-page data-parent="${editable}" data-today="${today}" data-appointments="${esc(JSON.stringify(appointments))}">
      ${editable ? '<div class="schedule-request-notices" data-request-notices aria-live="polite"></div>' : ""}
      ${current}
      <div class="schedule-heading"><h1>Schedule</h1></div>
      <div class="schedule-tabs" role="tablist" aria-label="Schedule view"><button type="button" role="tab" aria-selected="true" data-view="list">List</button><button type="button" role="tab" aria-selected="false" data-view="calendar">Calendar</button></div>
      <div class="schedule-date-controls"><button type="button" class="schedule-chevron" data-date="previous" aria-label="Previous date">‹</button><p data-date-label></p><button type="button" class="schedule-chevron" data-date="next" aria-label="Next date">›</button></div>
      <div class="schedule-body-grid"><div class="schedule-primary-content" data-schedule-content></div><section class="upcoming-shifts"><h2>Upcoming Shifts</h2><div data-upcoming-shifts></div></section></div>
      ${editable ? '<button type="button" class="schedule-new-session" data-book-appointment>＋ New Session</button>' : ""}<p class="schedule-request-status" data-request-status role="status"></p>
    </section>`;
  }

  // Shared availability and phone under the caregiver's name (parent schedule page).
  function caregiverDetails() {
    if (!sharedSitter || (!sharedSitter.availability && !sharedSitter.phone)) return "";
    const href = sharedSitter.phone && window.CareNestFamily ? window.CareNestFamily.phoneHref(sharedSitter.phone) : "";
    const phone = sharedSitter.phone ? (href ? `<a href="${esc(href)}">${esc(sharedSitter.phone)}</a>` : esc(sharedSitter.phone)) : "";
    return `<p class="supporting-copy caregiver-details">${[sharedSitter.availability ? esc(sharedSitter.availability) : "", phone].filter(Boolean).join(" · ")}</p>`;
  }

  function sitterProfile() {
    const profile = (sitterProfileState && sitterProfileState.profile) || profileDefaults();
    return `<section class="profile-settings-layout"><article class="panel secondary-panel public-profile-card"><p class="page-eyebrow">VISIBLE TO PARENTS</p><h2 class="section-title">Your public profile</h2><p class="supporting-copy">Parents only see the fields you choose to share below.</p><form class="profile-settings-form" id="profile-settings-form"><label class="field-label" for="profile-name">Display name</label><input class="text-input" id="profile-name" name="name" maxlength="80" value="${esc(profile.name)}"><label class="field-label" for="profile-bio">About you</label><textarea class="text-input profile-textarea" id="profile-bio" name="bio" maxlength="500" rows="4" placeholder="Friendly, dependable care for busy families.">${esc(profile.bio)}</textarea><label class="field-label" for="profile-phone">Phone number</label><input class="text-input" id="profile-phone" name="phone" type="tel" maxlength="40" value="${esc(profile.phone)}"><label class="field-label" for="profile-availability">Availability</label><input class="text-input" id="profile-availability" name="availability" maxlength="160" placeholder="Weekday afternoons and weekends" value="${esc(profile.availability)}"><fieldset class="profile-visibility"><legend class="field-label">What parents can see</legend><label><input type="checkbox" name="showBio"${profile.showBio ? " checked" : ""}> About you</label><label><input type="checkbox" name="showPhone"${profile.showPhone ? " checked" : ""}> Phone number</label><label><input type="checkbox" name="showAvailability"${profile.showAvailability ? " checked" : ""}> Availability</label></fieldset><fieldset class="profile-visibility"><legend class="field-label">Your preferences</legend><label><input type="checkbox" name="updates"${profile.updates ? " checked" : ""}> Receive session update reminders</label></fieldset><div class="profile-save-row"><button class="primary-btn" type="submit">Save profile</button><p class="profile-save-status" id="profile-save-status" role="status" aria-live="polite"></p></div></form></article><aside class="panel secondary-panel profile-preview"><p class="page-eyebrow">PARENT PREVIEW</p><h2 class="section-title" id="profile-preview-name">${esc(profile.name) || "Your name"}</h2><p class="supporting-copy" id="profile-preview-bio"${profile.showBio && profile.bio ? "" : " hidden"}>${esc(profile.bio)}</p><p class="supporting-copy" id="profile-preview-phone"${profile.showPhone && profile.phone ? "" : " hidden"}>${esc(profile.phone)}</p><p class="supporting-copy" id="profile-preview-availability"${profile.showAvailability && profile.availability ? "" : " hidden"}>${esc(profile.availability)}</p><p class="profile-private-note">Private fields stay visible only to you.</p></aside></section>`;
  }

  function bindSitterProfile(ctx) {
    const form = document.getElementById("profile-settings-form");
    if (!form) return;
    const status = document.getElementById("profile-save-status");
    const demoSave = Boolean(ctx.demo && demo);
    const canSave = Boolean(!ctx.demo && ctx.client && ctx.user);
    // A failed load shows defaults; saving them would overwrite the saved profile, so Save stays
    // off until the page is reloaded and the profile loads.
    const loadFailed = Boolean(canSave && sitterProfileState && sitterProfileState.error);
    if (loadFailed) {
      form.querySelector('[type="submit"]').disabled = true;
      status.textContent = `Your saved profile could not be loaded (${auth.friendlyError(sitterProfileState.error)}), so saving is turned off to keep it safe. Reload the page to try again.`;
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (loadFailed) return;
      const values = Object.fromEntries(new FormData(form).entries());
      ["showBio", "showPhone", "showAvailability", "updates"].forEach((name) => { values[name] = form.elements[name].checked; });
      if (demoSave) {
        const error = demo.saveSitterProfile(values);
        if (error) { status.textContent = error.message; return; }
      } else if (canSave) {
        const button = form.querySelector('[type="submit"]');
        button.disabled = true;
        status.textContent = "Saving…";
        const { error } = await saveProfile(ctx, values);
        button.disabled = false;
        if (error) { status.textContent = auth.friendlyError(error); return; }
        dropLegacyProfile(ctx.user.id);
      }
      document.getElementById("profile-preview-name").textContent = values.name || "Your name";
      [["bio", "showBio"], ["phone", "showPhone"], ["availability", "showAvailability"]].forEach(([field, visible]) => {
        const el = document.getElementById(`profile-preview-${field}`);
        el.textContent = values[field] || "";
        el.hidden = !values[visible] || !values[field];
      });
      status.textContent = canSave || demoSave ? "Profile saved." : "Preview updated. Demo profiles are not saved.";
    });
  }

  function render(ctx) {
    // Household members can view this information, but only the parent can change it.
    // Keeping this check tied to the membership role prevents a sitter opened on a
    // parent-looking URL from being offered controls that row-level security rejects.
    const isParent = Boolean(ctx && ctx.role === "parent");
    // Demo parents edit too; their changes stay in this browser tab (js/data.js).
    const editable = Boolean(isParent && (ctx.demo ? demo : ctx.client && ctx.household));
    const views = {
      schedule: {
        eyebrow: "", title: "Schedule", intro: "",
        body: schedulePage(ctx, Boolean(ctx && ctx.role === "parent")),
      },
      carelog: {
        eyebrow: "CURRENT SESSION", title: "Care log", intro: "Notes, photos, and handoff details from the care session.",
        // Both roles land here, so each link goes to that role's side of the page.
        body: `<section class="secondary-grid"><article class="panel secondary-panel"><h2 class="section-title">Current session log</h2><p class="supporting-copy">Completed activities and care updates appear here during the session.</p><a class="secondary-link" href="${isParent ? "parent.html#today" : "index.html#log"}">Open today’s activity</a></article><article class="panel secondary-panel"><h2 class="section-title">Messages</h2><p class="supporting-copy">${isParent ? "Your conversation with your sitter, including photo messages." : "Your conversation with the family, including photo messages."}</p><a class="secondary-link" href="${isParent ? "messages.html?as=parent" : "messages.html"}">Open messages</a></article><article class="panel secondary-panel"><h2 class="section-title">Photo updates</h2><p class="supporting-copy">Photos and moments shared with the care team.</p><a class="secondary-link" href="${isParent ? "gallery.html?as=parent" : "gallery.html"}">Open photo updates</a></article><article class="panel secondary-panel"><h2 class="section-title">Past sessions</h2><p class="supporting-copy">Review prior care sessions and their shared updates.</p></article></section>`,
      },
      profile: {
        eyebrow: "PROFILE & SETTINGS", title: ctx && ctx.role === "parent" ? "Your CareNest settings" : "Your sitter profile", intro: ctx && ctx.role === "parent" ? "Manage your details and the family space with confidence." : "Choose what parents can see, and keep your personal preferences in one place.",
        body: ctx && ctx.role === "parent" ? `<section class="secondary-grid"><div class="account-slot" data-account-panel></div><article class="panel secondary-panel"><h2 class="section-title">Manage household</h2><p class="supporting-copy">Edit each child on the Children tab, sessions on the Schedule tab, and everything else in <a href="manage.html">Family info</a>.</p></article><article class="panel secondary-panel"><h2 class="section-title">Notification preferences</h2><p class="supporting-copy">Notification controls will appear here as they become available.</p></article></section>` : `${sitterProfile()}<div class="account-slot account-slot-wide" data-account-panel></div>`,
      },
    }[page];
    if (!views) return;
    document.title = `CareNest — ${views.title}`;
    root.innerHTML = page === "schedule" ? views.body : `<header class="secondary-header"><p class="page-eyebrow">${views.eyebrow}</p><h1>${views.title}</h1><p>${views.intro}</p></header>${views.body}`;
    if (page === "schedule") bindSchedule(ctx, Boolean(ctx && ctx.role === "parent"));
    if (editable) bindEditors(ctx);
    if (page === "profile" && (!ctx || ctx.role !== "parent")) bindSitterProfile(ctx || {});
    if (page === "profile") auth.mountAccountPanel(root.querySelector("[data-account-panel]"), ctx);
  }

  function bindSchedule(ctx, editable) {
    const pageEl = root.querySelector("[data-schedule-page]");
    if (!pageEl) return;
    let appointments = [];
    try { appointments = JSON.parse(pageEl.dataset.appointments || "[]"); } catch (e) { /* an empty schedule is valid */ }
    // Open "Request Schedule" reminders (SI-50): from the database, or this tab only in demo mode.
    const live = Boolean(ctx && !ctx.demo && ctx.client && ctx.household);
    let requests = live ? (data.scheduleRequests || []).slice() : [];
    let selected = pageEl.dataset.today;
    // parent.html links here with ?date=YYYY-MM-DD to open a requested day.
    const linkedDate = new URLSearchParams(window.location.search).get("date");
    if (linkedDate && /^\d{4}-\d{2}-\d{2}$/.test(linkedDate) && !Number.isNaN(parseDate(linkedDate).getTime())) selected = linkedDate;
    let view = "list";
    const content = pageEl.querySelector("[data-schedule-content]");
    const upcomingEl = pageEl.querySelector("[data-upcoming-shifts]");
    const label = pageEl.querySelector("[data-date-label]");
    const status = pageEl.querySelector("[data-request-status]");
    const today = pageEl.dataset.today;
    // A day can hold more than one session (the table is unique on plan, date, and start time).
    const dayAppointments = (date) => appointments.filter((item) => item.date === date).sort((a, b) => timeValue(a.start_time) - timeValue(b.start_time));
    const sortedActivities = (appointment) => (Array.isArray(appointment.activities) ? appointment.activities : []).slice().sort((a, b) => timeValue(a.time) - timeValue(b.time));
    const eventDates = () => new Set(appointments.map((item) => item.date));
    const openRequest = (date) => requests.find((item) => item.date === date);
    const parentFirst = () => String(data.parentName || "").trim().split(/\s+/)[0] || "";
    const notices = pageEl.querySelector("[data-request-notices]");
    function setStatus(text, isError) {
      status.textContent = text;
      status.classList.toggle("is-error", Boolean(isError));
    }

    function appointmentHtml(item) {
      return `<article class="upcoming-shift"><div><p><strong>${esc(displayDate(item.date))}</strong><span>${esc(sessionHours(item))}</span></p><small>Children: ${esc(data.child && data.child.name || "Child")} · Caregiver: ${esc(data.babysitter && data.babysitter.name || "Caregiver")}</small></div><div class="schedule-people"><span class="schedule-avatar">${esc(initials(data.child && data.child.name))}</span><span class="schedule-avatar schedule-avatar--sitter">${esc(initials(data.babysitter && data.babysitter.name))}</span></div></article>`;
    }
    function sessionHtml(appointment, several) {
      const activities = sortedActivities(appointment);
      const id = esc(appointment.id);
      const notes = appointment.note ? `<aside class="schedule-notes"><strong>Today’s Notes</strong><p>${esc(appointment.note)}</p></aside>` : "";
      const heading = several ? `<h3 class="schedule-session-heading">Session ${esc(sessionHours(appointment))}</h3>` : "";
      // A booked session with no activities yet is still a schedule: show its hours, not "Request".
      if (!activities.length && !several) return `<div class="schedule-empty"><p>Session ${esc(sessionHours(appointment))}</p><small>No activities added yet.</small>${editable ? `<button class="schedule-empty-button" type="button" data-edit-schedule="${id}">Edit Schedule</button>` : ""}</div>${notes}`;
      const list = activities.length
        ? `<ol class="schedule-activity-list">${activities.map((item) => `<li><time>${esc(item.time || "Any time")}</time><div><strong>${esc(item.title)}</strong>${item.detail || item.location ? `<p>${esc(item.detail || item.location)}</p>` : ""}</div></li>`).join("")}</ol>`
        : '<p class="schedule-session-empty">No activities added yet.</p>';
      return `${heading}${list}${notes}${editable ? `<button type="button" class="schedule-edit-button" data-edit-schedule="${id}">Edit Schedule</button>` : ""}`;
    }
    function listHtml() {
      const sessions = dayAppointments(selected);
      if (!sessions.length) return emptyHtml();
      if (sessions.length === 1) return sessionHtml(sessions[0], false);
      return sessions.map((appointment) => `<section class="schedule-session">${sessionHtml(appointment, true)}</section>`).join("");
    }
    function emptyHtml() {
      const parent = parentFirst();
      let action;
      if (editable) action = '<button class="schedule-empty-button" type="button" data-book-appointment>Add Schedule</button>';
      // Past days cannot get a schedule (booking starts today), so there is nothing to request.
      else if (selected < today) action = "";
      else if (openRequest(selected)) action = `<button class="schedule-empty-button" type="button" disabled>Reminder sent to ${esc(parent || "the parent")}</button><small>${esc(parent || "The parent")} will see it on their schedule.</small>`;
      else action = '<button class="schedule-empty-button" type="button" data-request-schedule>Request Schedule</button><small>Send a reminder to the parent to add a schedule for this day.</small>';
      return `<div class="schedule-empty"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3v3m10-3v3M4 9h16M6 5h12a2 2 0 0 1 2-2Z"/></svg><p>No schedule has been added${editable ? "." : " for this shift."}</p>${action}</div>`;
    }
    function calendarHtml() {
      const selectedDate = parseDate(selected);
      const year = selectedDate.getFullYear(), month = selectedDate.getMonth();
      const first = new Date(year, month, 1), last = new Date(year, month + 1, 0);
      const start = (first.getDay() + 6) % 7;
      const days = Array.from({ length: start + last.getDate() }, (_, index) => index < start ? "" : index - start + 1);
      return `<div class="schedule-calendar"><div class="calendar-weekdays">${["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((day) => `<span>${day}</span>`).join("")}</div><div class="calendar-days">${days.map((day) => { if (!day) return "<span></span>"; const key = dateKey(new Date(year, month, day)); return `<button type="button" data-calendar-date="${key}" class="${key === selected ? "is-selected" : ""}${eventDates().has(key) ? " has-shift" : ""}" aria-label="${esc(displayDate(key, true))}">${day}</button>`; }).join("")}</div></div>${listHtml()}`;
    }
    function render() {
      const isToday = selected === today;
      // The current card follows today's real booking, whichever day the list has selected.
      const booked = dayAppointments(today);
      pageEl.querySelector("[data-current-session-time]").textContent = booked.length ? booked.map(sessionHours).join(", ") : "No session today";
      label.textContent = view === "calendar" ? displayMonth(selected) : `${displayDate(selected)}${isToday ? " (Today)" : ""}`;
      content.innerHTML = view === "list" ? listHtml() : calendarHtml();
      upcomingEl.innerHTML = appointments.filter((item) => item.date > today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 4).map(appointmentHtml).join("") || '<p class="schedule-no-upcoming">No upcoming shifts scheduled.</p>';
      pageEl.querySelectorAll("[data-view]").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.view === view)));
      if (notices) notices.innerHTML = requests.map(noticeHtml).join("");
    }
    // Parent schedule page: one notice per open request.
    function noticeHtml(request) {
      const name = request.requesterName || "Your sitter";
      const canAdd = request.date >= today; // booking starts today
      return `<div class="auth-status schedule-request-notice"><p>${esc(name)} asked for a schedule for ${esc(displayDate(request.date))}.</p><div class="schedule-request-actions">${canAdd ? `<button type="button" class="primary-btn" data-request-add="${esc(request.date)}">Add schedule</button>` : ""}<button type="button" class="photo-source-btn" data-request-dismiss="${esc(request.id)}">Dismiss</button></div></div>`;
    }
    async function requestSchedule(button) {
      const date = selected;
      const parent = parentFirst();
      if (!live) {
        setStatus("Demo only: no reminder was sent. Sign in as a sitter to send a real one.");
        return;
      }
      button.disabled = true;
      setStatus("Sending…");
      const { error } = await ctx.client.from("schedule_requests").insert({ household_id: ctx.household.id, request_date: date });
      // 23505: an open request for this day already exists, so the parent already has it.
      if (error && error.code !== "23505") {
        button.disabled = false;
        setStatus(auth.friendlyError(error), true);
        return;
      }
      if (!openRequest(date)) requests = requests.concat({ id: `sent-${date}`, date });
      setStatus(`Reminder sent. ${parent || "The parent"} will see it on their schedule.`);
      render();
    }
    async function dismissRequest(button) {
      button.disabled = true;
      const { error } = await ctx.client.from("schedule_requests").update({ resolved_at: new Date().toISOString() }).eq("id", button.dataset.requestDismiss);
      if (error) {
        button.disabled = false;
        setStatus(auth.friendlyError(error), true);
        return;
      }
      requests = requests.filter((item) => item.id !== button.dataset.requestDismiss);
      setStatus("Request dismissed.");
      render();
    }
    // appointmentId: the session to edit; none books a new session on `date`.
    function openBooking(appointmentId, date) {
      const existing = appointmentId ? appointments.find((item) => item.id === appointmentId) : null;
      const activityList = existing && Array.isArray(existing.activities) ? existing.activities.map((item) => ({ ...item })) : [];
      const dialog = document.createElement("dialog");
      dialog.className = "confirm-dialog manage-dialog";
      dialog.innerHTML = `<form class="confirm-dialog-body schedule-details-form" method="dialog"><div class="schedule-details-header"><button class="schedule-close" type="button" aria-label="Close">×</button><h2 class="panel-title">Schedule Details</h2><button class="schedule-save" value="save">Save</button></div><label class="field-label" for="appointment-date">Date</label><input class="text-input" id="appointment-date" name="date" type="date" required min="${today}" value="${esc(existing ? existing.date : date || selected)}"><div class="schedule-time-fields"><label class="field-label" for="appointment-start">Start time<input class="text-input" id="appointment-start" name="start" type="time" required value="${inputTime(existing && existing.start_time, "15:00")}"></label><label class="field-label" for="appointment-end">End time<input class="text-input" id="appointment-end" name="end" type="time" required value="${inputTime(existing && existing.end_time, "19:00")}"></label></div><div class="schedule-detail-group"><div class="schedule-detail-label"><strong>Children</strong><small>Select all that apply</small></div><button type="button" class="schedule-choice selected" data-child-choice><span class="schedule-avatar">${esc(initials(data.child && data.child.name))}</span>${esc(data.child && data.child.name || "Child")}</button><input type="hidden" name="children" value="${esc(data.child && data.child.name || "Child")}"></div><div class="schedule-detail-group"><strong>Caregiver</strong><div class="schedule-caregiver-choice"><span class="schedule-avatar schedule-avatar--sitter">${esc(initials(data.babysitter && data.babysitter.name))}</span>${esc(data.babysitter && data.babysitter.name || "Caregiver")} <span>›</span></div></div><div class="schedule-detail-group"><strong>Activities</strong><div class="schedule-editor-activities">${activityList.map((item) => `<div><time>${esc(item.time || "Any time")}</time><span><b>${esc(item.title)}</b>${item.detail || item.location ? `<small>${esc(item.detail || item.location)}</small>` : ""}</span><button type="button" data-edit-activity="${esc(item.id)}" aria-label="Edit ${esc(item.title)}">✎</button></div>`).join("")}</div><button class="schedule-add-activity" type="button" data-add-activity>＋ Add Activity</button></div><div class="schedule-detail-group"><div class="schedule-detail-label"><strong>Today’s Notes</strong><small>Optional</small></div><textarea class="text-input manage-textarea" name="note" rows="3" placeholder="Anything else the caregiver should know?">${esc(existing && existing.note || "")}</textarea></div><p class="form-error" hidden></p></form>`;
      document.body.appendChild(dialog);
      dialog.querySelector(".schedule-close").addEventListener("click", () => dialog.close("cancel"));
      dialog.querySelector("[data-child-choice]").addEventListener("click", (event) => {
        const choice = event.currentTarget;
        const input = dialog.querySelector("[name=children]");
        choice.classList.toggle("selected");
        input.value = choice.classList.contains("selected") ? (data.child && data.child.name || "Child") : "";
      });
      dialog.addEventListener("close", async () => {
        // Clear it now: Esc and cancel don't set returnValue, so a stale "save" from a failed
        // attempt would make the next Esc save again instead of cancelling.
        const action = dialog.returnValue;
        dialog.returnValue = "";
        if (action !== "save") return dialog.remove();
        const form = dialog.querySelector("form"), values = Object.fromEntries(new FormData(form).entries());
        const errorEl = dialog.querySelector(".form-error");
        const showError = (text) => { errorEl.textContent = text; errorEl.hidden = false; dialog.showModal(); };
        const missing = !values.date ? "Enter a date." : !values.start ? "Enter a start time." : !values.end ? "Enter an end time." : !values.children ? "Select at least one child." : values.end <= values.start ? "End time must be after the start time." : "";
        if (missing) return showError(missing);
        const clash = appointments.find((other) => other.date === values.date && !(existing && other.id === existing.id) && inputTime(other.start_time, "") < values.end && values.start < inputTime(other.end_time, ""));
        if (clash) return showError(`This overlaps the ${sessionHours(clash)} session that day.`);
        const format = (value) => new Date(`2000-01-01T${value}`).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        const item = { id: existing ? existing.id : `appointment-${Date.now()}`, date: values.date, start_time: format(values.start), end_time: format(values.end), note: values.note.trim(), activities: activityList };
        try {
          if (live) {
            const fields = { appointment_date: item.date, start_time: values.start, end_time: values.end, note: item.note, activities: item.activities };
            // An appointment never moves to another family space or plan, so updates leave those alone.
            const result = existing
              ? await ctx.client.from("appointments").update(fields).eq("id", existing.id).select("id")
              : await ctx.client.from("appointments").insert({ household_id: ctx.household.id, plan_id: await ensurePlanId(ctx), ...fields }).select("id").single();
            if (result.error && result.error.code === "23505") return showError("There's already a session starting at that time on this day.");
            if (result.error) throw result.error;
            // RLS turns a refused or vanished update into zero rows, not an error.
            if (existing && !(result.data && result.data.length)) return showError("This session couldn't be saved. It may have been changed or removed. Reload the page and try again.");
            if (!existing && result.data && result.data.id) item.id = result.data.id; // so an edit before Realtime catches up targets the real row
          }
          const existingIndex = existing ? appointments.findIndex((appointment) => appointment.id === existing.id) : -1;
          if (existingIndex >= 0) appointments.splice(existingIndex, 1, item); else appointments.push(item);
          if (ctx && ctx.demo && demo) {
            // Demo: keep the session in this tab so it is still there after moving between pages.
            data.appointments = appointments.slice();
            const saveError = demo.save();
            if (saveError) throw saveError;
          }
          requests = requests.filter((request) => request.date !== item.date); // the database resolves it too
          selected = item.date; setStatus(existing ? "Schedule saved." : "Schedule added."); render(); dialog.remove();
        } catch (error) { showError(auth.friendlyError(error)); }
      });
      dialog.addEventListener("click", async (event) => {
        const button = event.target.closest("[data-add-activity], [data-edit-activity], [data-save-activity]");
        if (!button) return;
        event.preventDefault();
        if (button.hasAttribute("data-add-activity") || button.dataset.editActivity) {
          const row = activityList.find((item) => item.id === button.dataset.editActivity) || {};
          dialog.querySelector(".schedule-inline-activity")?.remove();
          const editor = document.createElement("div");
          editor.className = "schedule-inline-activity";
          editor.innerHTML = `<label>Time<input class="text-input" name="activity-time" type="time" value="${inputTime(row.time, row.id ? "" : "15:00")}"></label><label>Activity<input class="text-input" name="activity-title" value="${esc(row.title || "")}" placeholder="Activity name"></label><label>Notes<textarea class="text-input" name="activity-detail" rows="2" placeholder="Notes">${esc(row.detail || "")}</textarea></label><button class="schedule-save" type="button" data-save-activity="${esc(row.id || "")}">Save activity</button>`;
          dialog.querySelector(".schedule-add-activity")?.parentElement.appendChild(editor);
          editor.querySelector("input[name=activity-title]").focus();
          return;
        }
        const editor = button.closest(".schedule-inline-activity");
        const title = editor.querySelector("[name=activity-title]").value.trim();
        if (!title) return editor.querySelector("[name=activity-title]").focus();
        const rawTime = editor.querySelector("[name=activity-time]").value;
        // A cleared time means "Any time", not new Date("2000-01-01T"), which is Invalid Date.
        const displayTime = rawTime ? new Date(`2000-01-01T${rawTime}`).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(" ", "").toLowerCase() : "";
        const values = { title, time: displayTime, detail: editor.querySelector("[name=activity-detail]").value.trim(), location: null };
        const existingTask = activityList.find((item) => item.id === button.dataset.saveActivity);
        try {
          if (existingTask) Object.assign(existingTask, values); else activityList.push(Object.assign(values, { id: `activity-${Date.now()}` }));
          editor.remove();
        } catch (error) { const errorEl = dialog.querySelector(".form-error"); errorEl.textContent = auth.friendlyError(error); errorEl.hidden = false; }
      });
      dialog.showModal();
    }
    pageEl.addEventListener("click", (event) => {
      const target = event.target.closest("button"); if (!target) return;
      if (target.dataset.view) { view = target.dataset.view; render(); }
      if (target.dataset.date) { selected = addDays(selected, target.dataset.date === "next" ? 1 : -1); render(); }
      if (target.dataset.calendarDate) { selected = target.dataset.calendarDate; render(); }
      if (target.matches("[data-request-schedule]")) requestSchedule(target);
      if (target.dataset.requestAdd) { selected = target.dataset.requestAdd; view = "list"; render(); openBooking(null, selected); }
      if (target.dataset.requestDismiss && live) dismissRequest(target);
      if (target.matches("[data-book-appointment]")) openBooking(null, selected);
      if (target.matches("[data-edit-schedule]")) {
        // The Current Session pencil has no id: it means today's first session, or a new one today.
        const id = target.dataset.editSchedule || (dayAppointments(today)[0] || {}).id;
        if (id) openBooking(id); else openBooking(null, today);
      }
    });
    // Re-read what js/family-data.js loaded (live changes); keeps the selected date and view.
    syncSchedule = () => {
      if (!live) return;
      appointments = (data.appointments || []).slice();
      requests = (data.scheduleRequests || []).slice();
      // The sitter's "Reminder sent" line goes once the parent adds that day or dismisses it.
      if (!editable && !openRequest(selected) && !status.classList.contains("is-error")) setStatus("");
      render();
    };
    render();
  }

  function bindEditors(ctx) {
    const client = ctx.demo ? demo.client : ctx.client;
    const householdId = ctx.household.id;
    let dialog;
    // remove: optional { run, name }. `name` titles the confirmation shown before anything is deleted.
    function openDialog(title, fields, values, onSave, remove) {
      if (dialog) dialog.remove();
      dialog = document.createElement("dialog");
      dialog.className = "confirm-dialog manage-dialog";
      dialog.innerHTML = `<form class="confirm-dialog-body" method="dialog"><h2 class="panel-title">${esc(title)}</h2>${fields.map((field) => `<label class="field-label" for="inline-${field.name}">${field.label}</label>${field.type === "textarea" ? `<textarea class="text-input manage-textarea" id="inline-${field.name}" name="${field.name}" rows="3">${esc(values[field.name] || "")}</textarea>` : field.type === "select" ? `<select class="text-input" id="inline-${field.name}" name="${field.name}"><option value="">None</option>${field.options.map((option) => `<option value="${esc(option)}"${values[field.name] === option ? " selected" : ""}>${esc(option)}</option>`).join("")}</select>` : `<input class="text-input" id="inline-${field.name}" name="${field.name}" type="${field.type || "text"}" value="${esc(values[field.name] || "")}" />`}`).join("")}<p class="form-error" hidden></p><div class="moment-dialog-actions"><button class="primary-btn" value="save">Save</button>${remove ? '<button class="danger-btn" value="remove">Remove</button>' : ""}<button class="photo-source-btn" value="cancel">Cancel</button></div></form>`;
      document.body.appendChild(dialog);
      const form = dialog.querySelector("form");
      dialog.addEventListener("close", async () => {
        // Clear it now: Esc doesn't set returnValue, so a stale "save" or "remove" from a failed
        // attempt would make the next Esc repeat that action instead of cancelling.
        const action = dialog.returnValue;
        dialog.returnValue = "";
        try {
          if (action === "save") {
            const saved = Object.fromEntries(fields.map((field) => [field.name, form.elements[field.name].value.trim()]));
            const requiredField = fields.find((field) => field.required);
            if (requiredField && !saved[requiredField.name]) {
              throw new Error(`${requiredField.label} is required.`);
            }
            const result = await onSave(saved);
            if (result && result.error) throw result.error;
            window.location.reload();
          } else if (action === "remove" && remove) {
            const confirmed = await auth.confirmDialog({
              title: `Remove ${remove.name || "this item"}?`,
              body: "Your sitter will no longer see this. This can't be undone.",
              confirmLabel: "Remove",
              danger: true,
            });
            if (!confirmed) return dialog.showModal(); // back to the editor, nothing removed
            const result = await remove.run();
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
    const planId = () => ensurePlanId(ctx);
    root.addEventListener("click", (event) => {
      const button = event.target.closest("[data-edit], [data-add]");
      if (!button) return;
      const kind = button.dataset.edit || button.dataset.add;
      const id = button.dataset.id;
      if (kind === "hours") return openDialog("Edit shift hours", [{ name: "schedule", label: "Usual shift hours" }], { schedule: data.child.shiftTime || "" }, async (values) => client.from("plans").update(values).eq("id", await planId()));
      if (kind === "task") {
        const row = data.schedule.find((item) => item.id === id) || {};
        const fields = [{ name: "title", label: "Task" }, { name: "time_of_day", label: "Time (for example 3:00pm)" }, { name: "detail", label: "Details", type: "textarea" }, { name: "location", label: "Location" }];
        return openDialog(row.id ? "Edit task" : "Add task", fields, { title: row.title, time_of_day: row.time || "", detail: row.detail || "", location: row.location || "" }, async (values) => {
          values.time_of_day = toDatabaseTime(values.time_of_day);
          return row.id ? client.from("tasks").update(values).eq("id", row.id) : client.from("tasks").insert(Object.assign(values, { plan_id: await planId(), position: data.schedule.length }));
        }, row.id ? { name: row.title, run: () => client.from("tasks").update({ archived_at: new Date().toISOString() }).eq("id", row.id) } : null);
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
