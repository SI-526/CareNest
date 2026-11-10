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

  const { dateKey, parseDate, addDays, clockMinutes, endsNextDay, sessionLength, formatLength, sessionsOverlap, continuingSessions, isLongSession } = window.CareNestDates;
  // A saved session ({ date, start_time, end_time }) in the shape CareNestDates reads.
  const sessionTimes = (item) => ({ date: item.date, start: item.start_time, end: item.end_time });
  // Activities in session order: an overnight session's 12:30am (up to its end) comes after its
  // 9:00pm. Otherwise activities sort by time of day, as before.
  const sessionOrder = (time, start, end) => {
    const at = clockMinutes(time);
    if (at === null) return Number.MAX_SAFE_INTEGER;
    return endsNextDay(start, end) && at < clockMinutes(start) && at <= clockMinutes(end) ? at + 24 * 60 : at;
  };
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
  // Display only: "3:00pm" (the stored format) reads as "3:00 PM", as in the Figma designs.
  // Stored strings are never rewritten.
  const displayTime = (value) => String(value || "").replace(/^(\d{1,2}:\d{2})\s*(am|pm)$/i, (_, hm, period) => `${hm} ${period.toUpperCase()}`);
  // "7:00 PM - 1:00 AM (next day)" for an overnight session (SI-80).
  const sessionHours = (item) => `${displayTime(item.start_time)}${item.end_time ? ` - ${displayTime(item.end_time)}${endsNextDay(item.start_time, item.end_time) ? " (next day)" : ""}` : ""}`;
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
  // Schedule Details time picker (SI-76): hour, minutes in 5-minute steps, and AM/PM as native
  // selects, which phones show as scroll wheels, so only valid times can be picked. Values go in
  // and come out as "HH:MM" (24-hour). The selects have no name, so FormData never sees them.
  const pad2 = (value) => String(value).padStart(2, "0");
  function timeWheelHtml(name, value, label) {
    const [hours, minute] = (/^\d{2}:\d{2}$/.test(value || "") ? value : "15:00").split(":").map(Number);
    const hour12 = hours % 12 || 12;
    const period = hours < 12 ? "AM" : "PM";
    const minutes = Array.from({ length: 12 }, (_, index) => index * 5);
    // A time saved before the picker (3:07, say) stays as it was until the parent changes it.
    if (!minutes.includes(minute)) minutes.push(minute), minutes.sort((a, b) => a - b);
    const option = (value, text, isSelected) => `<option value="${value}"${isSelected ? " selected" : ""}>${text}</option>`;
    return `<span class="time-wheel" role="group" aria-label="${esc(label)}" data-time-wheel="${esc(name)}"><select class="text-input" data-part="hour" aria-label="${esc(label)}: hour">${Array.from({ length: 12 }, (_, index) => index + 1).map((value) => option(value, value, value === hour12)).join("")}</select><span aria-hidden="true">:</span><select class="text-input" data-part="minute" aria-label="${esc(label)}: minutes">${minutes.map((value) => option(value, pad2(value), value === minute)).join("")}</select><select class="text-input" data-part="period" aria-label="${esc(label)}: AM or PM">${["AM", "PM"].map((value) => option(value, value, value === period)).join("")}</select></span>`;
  }
  function readTimeWheel(scope, name) {
    const wheel = scope.querySelector(`[data-time-wheel="${name}"]`);
    if (!wheel) return "";
    const part = (key) => wheel.querySelector(`[data-part="${key}"]`).value;
    const hours = (Number(part("hour")) % 12) + (part("period") === "PM" ? 12 : 0);
    return `${pad2(hours)}:${pad2(Number(part("minute")))}`;
  }
  // "15:00" to "3:00pm", the format the rest of the app shows (js/family-data.js formatTaskTime).
  const formatTime = (value) => {
    const [hours, minute] = String(value || "").split(":").map(Number);
    if (Number.isNaN(hours) || Number.isNaN(minute)) return "";
    return `${hours % 12 || 12}:${pad2(minute)}${hours < 12 ? "am" : "pm"}`;
  };
  let activityCounter = 0;
  const newActivityId = () => `activity-${Date.now().toString(36)}-${(activityCounter += 1)}-${Math.random().toString(36).slice(2, 6)}`;
  // Figma hi-fi icons (Material Symbols), drawn in currentColor.
  const svgIcon = (size, box, path, cls) => `<svg${cls ? ` class="${cls}"` : ""} viewBox="0 0 ${box} ${box}" width="${size}" height="${size}" aria-hidden="true" focusable="false"><path fill="currentColor" d="${path}"/></svg>`;
  const EDIT_PATH = "M5 19H6.425L16.2 9.225L14.775 7.8L5 17.575V19ZM3 21V16.75L16.2 3.575C16.4 3.39167 16.6208 3.25 16.8625 3.15C17.1042 3.05 17.3583 3 17.625 3C17.8917 3 18.15 3.05 18.4 3.15C18.65 3.25 18.8667 3.4 19.05 3.6L20.425 5C20.625 5.18333 20.7708 5.4 20.8625 5.65C20.9542 5.9 21 6.15 21 6.4C21 6.66667 20.9542 6.92083 20.8625 7.1625C20.7708 7.40417 20.625 7.625 20.425 7.825L7.25 21H3ZM15.475 8.525L14.775 7.8L16.2 9.225L15.475 8.525Z";
  const CALENDAR_PATH = "M10 44.0002C8.9 44.0002 7.95833 43.6085 7.175 42.8252C6.39167 42.0419 6 41.1002 6 40.0002V12.0002C6 10.9002 6.39167 9.95853 7.175 9.1752C7.95833 8.39186 8.9 8.0002 10 8.0002H12V4.0002H16V8.0002H32V4.0002H36V8.0002H38C39.1 8.0002 40.0417 8.39186 40.825 9.1752C41.6083 9.95853 42 10.9002 42 12.0002V40.0002C42 41.1002 41.6083 42.0419 40.825 42.8252C40.0417 43.6085 39.1 44.0002 38 44.0002H10ZM10 40.0002H38V20.0002H10V40.0002Z";
  const ICONS = {
    edit: svgIcon(24, 24, EDIT_PATH),
    cardEdit: svgIcon(18, 18, "M2 16H3.425L13.2 6.225L11.775 4.8L2 14.575V16ZM0 18V13.75L13.2 0.575C13.4 0.391667 13.6208 0.25 13.8625 0.15C14.1042 0.05 14.3583 0 14.625 0C14.8917 0 15.15 0.05 15.4 0.15C15.65 0.25 15.8667 0.4 16.05 0.6L17.425 2C17.625 2.18333 17.7708 2.4 17.8625 2.65C17.9542 2.9 18 3.15 18 3.4C18 3.66667 17.9542 3.92083 17.8625 4.1625C17.7708 4.40417 17.625 4.625 17.425 4.825L4.25 18H0ZM12.475 5.525L11.775 4.8L13.2 6.225L12.475 5.525Z"),
    chevronLeft: svgIcon(24, 24, "M14 18L8 12L14 6L15.4 7.4L10.8 12L15.4 16.6L14 18Z"),
    chevronRight: svgIcon(24, 24, "M10 18L16 12L10 6L8.6 7.4L13.2 12L8.6 16.6L10 18Z"),
    chevronDown: svgIcon(24, 24, "M12 15.4 6 9.4 7.4 8l4.6 4.6L16.6 8 18 9.4l-6 6Z"),
    pin: svgIcon(16, 16, "M7.61033 13.893C7.48033 13.8482 7.36278 13.7787 7.25767 13.6847C6.65944 13.1334 6.09961 12.5656 5.57817 11.9814C5.05683 11.3973 4.60367 10.8133 4.21867 10.2295C3.83356 9.64577 3.52883 9.06716 3.3045 8.49371C3.08017 7.92016 2.968 7.36627 2.968 6.83205C2.968 5.2936 3.46561 4.0481 4.46083 3.09555C5.45617 2.14299 6.63589 1.66671 8 1.66671C9.36411 1.66671 10.5438 2.14299 11.5392 3.09555C12.5344 4.0481 13.032 5.2936 13.032 6.83205C13.032 7.36627 12.9198 7.91905 12.6955 8.49038C12.4712 9.06182 12.1676 9.64049 11.7847 10.2264C11.4017 10.8123 10.9495 11.3962 10.4282 11.9782C9.90683 12.5603 9.347 13.127 8.74867 13.6782C8.64356 13.7722 8.525 13.8427 8.393 13.8897C8.26089 13.9367 8.12989 13.9602 8 13.9602C7.87011 13.9602 7.74022 13.9378 7.61033 13.893ZM8.85183 7.55705C9.08739 7.3216 9.20517 7.03766 9.20517 6.70521C9.20517 6.37277 9.08739 6.08877 8.85183 5.85321C8.61639 5.61777 8.33244 5.50005 8 5.50005C7.66756 5.50005 7.38361 5.61777 7.14817 5.85321C6.91261 6.08877 6.79483 6.37277 6.79483 6.70521C6.79483 7.03766 6.91261 7.3216 7.14817 7.55705C7.38361 7.79249 7.66756 7.91021 8 7.91021C8.33244 7.91021 8.61639 7.79249 8.85183 7.55705Z"),
    notes: svgIcon(20, 20, "M13.3333 10L15 11.6667V13.3333H10.8333V18.3333L10 19.1667L9.16667 18.3333V13.3333H5V11.6667L6.66667 10V4.16667H5.83333V2.5H14.1667V4.16667H13.3333V10Z", "schedule-notes-icon"),
    emptyCalendar: svgIcon(48, 48, CALENDAR_PATH),
    smallCalendar: svgIcon(24, 48, CALENDAR_PATH),
    cancel: svgIcon(28, 28, "M8.96 21L14 15.96L19.04 21L21 19.04L15.96 14L21 8.96L19.04 7L14 12.04L8.96 7L7 8.96L12.04 14L7 19.04L8.96 21ZM14 28C12.0633 28 10.2433 27.6325 8.54 26.8975C6.83667 26.1625 5.355 25.165 4.095 23.905C2.835 22.645 1.8375 21.1633 1.1025 19.46C0.3675 17.7567 0 15.9367 0 14C0 12.0633 0.3675 10.2433 1.1025 8.54C1.8375 6.83667 2.835 5.355 4.095 4.095C5.355 2.835 6.83667 1.8375 8.54 1.1025C10.2433 0.3675 12.0633 0 14 0C15.9367 0 17.7567 0.3675 19.46 1.1025C21.1633 1.8375 22.645 2.835 23.905 4.095C25.165 5.355 26.1625 6.83667 26.8975 8.54C27.6325 10.2433 28 12.0633 28 14C28 15.9367 27.6325 17.7567 26.8975 19.46C26.1625 21.1633 25.165 22.645 23.905 23.905C22.645 25.165 21.1633 26.1625 19.46 26.8975C17.7567 27.6325 15.9367 28 14 28Z"),
  };
  // "Nov. 8" for the list's date selector (Figma: month abbreviation, period, day; no weekday).
  const shortDate = (key) => { const date = parseDate(key); return `${date.toLocaleDateString("en-US", { month: "short" })}. ${date.getDate()}`; };
  // "Tue, Nov. 10" for the Schedule Details date field.
  const pickerDate = (key) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(key || "")) return "Select a date"; const date = parseDate(key); return `${date.toLocaleDateString("en-US", { weekday: "short" })}, ${shortDate(key)}`; };
  // The family's children (SI-75), and the ones a session is for. A session saved before
  // sessions recorded children was for the whole family.
  const familyChildren = () => (Array.isArray(data.children) ? data.children : []).filter((child) => child && child.id);
  const firstName = (child) => String(child && child.name || "").trim().split(/\s+/)[0] || "Child";
  function sessionChildren(appointment) {
    const all = familyChildren();
    const ids = appointment && Array.isArray(appointment.childIds) ? appointment.childIds : [];
    const picked = all.filter((child) => ids.includes(child.id));
    return picked.length ? picked : all;
  }
  // An activity's notes, then its address (only when it already has one) behind a location pin.
  const activityDetails = (item, tag) => `${item.detail ? `<${tag}>${esc(item.detail)}</${tag}>` : ""}${item.location ? `<${tag} class="schedule-activity-location">${ICONS.pin}<span>${esc(item.location)}</span></${tag}>` : ""}`;
  // "Jack" when an activity is for only some of the session's children; "" when it's for all of them.
  function activityFor(activity, sessionKids) {
    const ids = Array.isArray(activity.childIds) ? activity.childIds : [];
    const picked = sessionKids.filter((child) => ids.includes(child.id));
    return picked.length && picked.length < sessionKids.length ? picked.map(firstName).join(", ") : "";
  }
  // Figma: a 32px initials avatar with the first name underneath (photos are out of scope).
  const personHtml = (name, extraClass) => `<span class="schedule-person"><span class="schedule-avatar${extraClass ? ` ${extraClass}` : ""}" aria-hidden="true">${esc(initials(name))}</span><small>${esc(String(name || "").trim().split(/\s+/)[0] || "Child")}</small></span>`;
  const childAvatars = (children) => (children.length ? children : [{ name: "Child" }]).map((child) => personHtml(child.name || "Child")).join("");
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
    // An empty list is a real answer (every session deleted), so the sample sessions are only for
    // a demo family that never had a list at all.
    const appointments = (Array.isArray(data.appointments) ? data.appointments : (ctx && ctx.demo ? demoAppointments() : [])).slice();
    const today = dateKey(new Date());
    // Filled by bindSchedule's render(): the children of today's sessions.
    // The children only: the caregiver has its own cell on the parent's card, and the sitter is the viewer.
    const people = '<div class="schedule-people" data-current-children></div>';
    const caregiver = sharedSitter && sharedSitter.display_name || data.babysitter && data.babysitter.name || "Caregiver";
    const current = editable
      ? `<section class="current-shift-card current-session-card"><div class="current-session-title"><div><p class="schedule-card-title">Current Session</p><p class="schedule-card-meta"><strong data-current-date>${esc(displayDate(today))}</strong><span data-current-session-time></span></p></div><button type="button" class="schedule-icon-button" data-edit-schedule aria-label="Edit current session">${ICONS.cardEdit}</button></div><div class="current-session-people"><div><strong>Children</strong>${people}</div><span class="current-session-divider" aria-hidden="true"></span><div><strong>Caregiver</strong><div class="schedule-people">${personHtml(caregiver, "schedule-avatar--sitter")}</div></div></div>${caregiverDetails()}</section>`
      : `<section class="current-shift-card"><div><p class="schedule-card-title">Current Shift</p><p class="schedule-card-meta"><strong data-current-date>${esc(displayDate(today))}</strong><span data-current-session-time></span></p></div>${people}</section>`;
    return `<section class="schedule-page${editable ? " schedule-page--parent" : ""}" data-schedule-page data-parent="${editable}" data-today="${today}" data-appointments="${esc(JSON.stringify(appointments))}">
      <header class="schedule-topnav"><h1>Schedule</h1></header>
      ${editable ? '<div class="schedule-request-notices" data-request-notices aria-live="polite"></div>' : ""}
      ${current}
      ${editable ? "" : "<div data-checklist-slot></div>"}
      <div class="schedule-heading"><h2>Schedule</h2></div>
      <div class="schedule-tabs" role="tablist" aria-label="Schedule view"><button type="button" role="tab" aria-selected="true" data-view="list">List</button><button type="button" role="tab" aria-selected="false" data-view="calendar">Calendar</button></div>
      <div class="schedule-date-controls"><button type="button" class="schedule-chevron" data-date="previous" aria-label="Previous date">${ICONS.chevronLeft}</button><p data-date-label></p><button type="button" class="schedule-chevron" data-date="next" aria-label="Next date">${ICONS.chevronRight}</button></div>
      <div class="schedule-body-grid"><div class="schedule-primary-content" data-schedule-content></div><section class="upcoming-shifts"><h2>${editable ? "Upcoming Sessions" : "Upcoming Shifts"}</h2><div data-upcoming-shifts></div></section></div>
      ${editable ? '<button type="button" class="schedule-new-session" data-book-appointment><span aria-hidden="true">+&nbsp;</span> New Session</button>' : ""}<p class="schedule-request-status" data-request-status role="status"></p>
    </section>`;
  }

  // Shared availability and phone under the caregiver's name (parent schedule page).
  function caregiverDetails() {
    if (!sharedSitter || (!sharedSitter.availability && !sharedSitter.phone)) return "";
    const href = sharedSitter.phone && window.CareNestFamily ? window.CareNestFamily.phoneHref(sharedSitter.phone) : "";
    const phone = sharedSitter.phone ? (href ? `<a href="${esc(href)}">${esc(sharedSitter.phone)}</a>` : esc(sharedSitter.phone)) : "";
    return `<p class="supporting-copy caregiver-details">${[sharedSitter.availability ? esc(sharedSitter.availability) : "", phone].filter(Boolean).join(" · ")}</p>`;
  }

  // Profile tab (Figma 316:2252 / 316:2360): who is signed in, their contact details, and the
  // account settings list. Read-only; the sitter edits name and phone in the public-profile form
  // below. Parents have no personal profile row, so they get their family-roster name and email.
  function profileSummary(ctx) {
    const isParent = Boolean(ctx && ctx.role === "parent");
    const profile = isParent ? null : (sitterProfileState && sitterProfileState.profile) || profileDefaults();
    const memberName = ctx && ctx.membership ? ctx.membership.display_name : ctx && ctx.demo ? data.parentName : "";
    const name = String((isParent ? memberName : profile.name) || "").trim();
    const phone = isParent ? "" : String(profile.phone || "").trim();
    const email = String((ctx && ctx.email) || "").trim();
    const empty = !name && !phone;
    const avatar = empty
      ? '<span class="profile-id-avatar profile-id-avatar--empty" aria-hidden="true"><img src="assets/icon-account-circle.svg" alt=""></span>'
      : `<span class="profile-id-avatar" aria-hidden="true">${esc(initials(name || "?"))}</span>`;
    const identity = `<header class="profile-identity">${avatar}<div><h1>${empty ? "Your profile" : esc(name)}</h1><p>${empty ? "Signed in" : `${isParent ? "Parent" : "Sitter"} · Signed in`}</p></div></header>`;
    const row = (label, value) => `<div class="profile-info-row"><p class="profile-info-label">${label}</p><p class="profile-info-value">${value}</p></div>`;
    const rows = [];
    if (email) rows.push(row("Email address", esc(email)));
    if (!isParent && !empty) rows.push(row("Phone number", phone ? esc(phone) : '<span class="profile-info-missing">Not provided</span>'));
    const emptyBlock = '<div class="profile-info-empty"><p class="profile-info-empty-title">No information provided.</p><p>Add your name and contact details using Profile management.</p><p class="profile-info-empty-note">You&#39;re still signed in to your account.</p></div>';
    const info = empty ? emptyBlock + rows.join("") : rows.length ? rows.join("") : '<p class="profile-info-missing">No contact details provided.</p>';
    const settingsRow = (href, icon, title, sub) => `<li><a class="profile-settings-row" href="${href}"><span class="profile-settings-icon" aria-hidden="true"><img src="assets/${icon}" alt=""></span><span class="profile-settings-text"><span class="profile-settings-title">${title}</span><span class="profile-settings-sub">${sub}</span></span><img class="profile-settings-chevron" src="assets/icon-chevron-right.svg" alt="" aria-hidden="true"></a></li>`;
    const settings = [
      settingsRow(isParent ? "#account" : "#profile-management", "icon-person.svg", "Profile management", "Personal details"),
      isParent ? settingsRow("people.html", "icon-home.svg", "Manage household", "People &amp; invites") : "",
      isParent ? "" : settingsRow("#profile-updates", "icon-notifications.svg", "Notifications", "Care reminders &amp; family updates"),
    ].join("");
    const household = isParent ? '<p class="profile-household-links">Edit each child on the <a href="children.html">Children</a> tab, sessions on the <a href="schedule.html">Schedule</a> tab, and everything else in <a href="manage.html">Family info</a>.</p>' : "";
    return `${identity}<section class="profile-section" aria-labelledby="profile-info-title"><h2 class="profile-section-title" id="profile-info-title">Personal information</h2><div class="profile-block profile-info">${info}</div></section><section class="profile-section" aria-labelledby="profile-settings-title"><h2 class="profile-section-title" id="profile-settings-title">Account settings</h2><ul class="profile-block profile-settings-list">${settings}</ul>${household}</section>`;
  }

  function sitterProfile() {
    const profile = (sitterProfileState && sitterProfileState.profile) || profileDefaults();
    return `<section class="profile-settings-layout" id="profile-management" aria-label="Profile management"><article class="panel secondary-panel public-profile-card"><p class="page-eyebrow">VISIBLE TO PARENTS</p><h2 class="section-title">Your public profile</h2><p class="supporting-copy">Parents only see the fields you choose to share below.</p><form class="profile-settings-form" id="profile-settings-form"><label class="field-label" for="profile-name">Display name</label><input class="text-input" id="profile-name" name="name" maxlength="80" value="${esc(profile.name)}"><label class="field-label" for="profile-bio">About you</label><textarea class="text-input profile-textarea" id="profile-bio" name="bio" maxlength="500" rows="4" placeholder="Friendly, dependable care for busy families.">${esc(profile.bio)}</textarea><label class="field-label" for="profile-phone">Phone number</label><input class="text-input" id="profile-phone" name="phone" type="tel" maxlength="40" value="${esc(profile.phone)}"><label class="field-label" for="profile-availability">Availability</label><input class="text-input" id="profile-availability" name="availability" maxlength="160" placeholder="Weekday afternoons and weekends" value="${esc(profile.availability)}"><fieldset class="profile-visibility"><legend class="field-label">What parents can see</legend><label><input type="checkbox" name="showBio"${profile.showBio ? " checked" : ""}> About you</label><label><input type="checkbox" name="showPhone"${profile.showPhone ? " checked" : ""}> Phone number</label><label><input type="checkbox" name="showAvailability"${profile.showAvailability ? " checked" : ""}> Availability</label></fieldset><fieldset class="profile-visibility" id="profile-updates"><legend class="field-label">Your preferences</legend><label><input type="checkbox" name="updates"${profile.updates ? " checked" : ""}> Receive session update reminders</label></fieldset><div class="profile-save-row"><button class="primary-btn" type="submit">Save profile</button><p class="profile-save-status" id="profile-save-status" role="status" aria-live="polite"></p></div></form></article><aside class="panel secondary-panel profile-preview"><p class="page-eyebrow">PARENT PREVIEW</p><h2 class="section-title" id="profile-preview-name">${esc(profile.name) || "Your name"}</h2><p class="supporting-copy" id="profile-preview-bio"${profile.showBio && profile.bio ? "" : " hidden"}>${esc(profile.bio)}</p><p class="supporting-copy" id="profile-preview-phone"${profile.showPhone && profile.phone ? "" : " hidden"}>${esc(profile.phone)}</p><p class="supporting-copy" id="profile-preview-availability"${profile.showAvailability && profile.availability ? "" : " hidden"}>${esc(profile.availability)}</p><p class="profile-private-note">Private fields stay visible only to you.</p></aside></section>`;
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
      // The name and phone at the top of the page follow what was just saved.
      const summary = document.querySelector("[data-profile-summary]");
      if ((canSave || demoSave) && summary) {
        sitterProfileState = { profile: { ...((sitterProfileState && sitterProfileState.profile) || profileDefaults()), ...values } };
        summary.innerHTML = profileSummary(ctx);
      }
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
        eyebrow: "", title: "Care Log", intro: "",
        // Filled by bindCareLog() once the shift has loaded (js/care-log.js mountPage).
        body: `<p class="supporting-copy care-log-loading">Loading the care log…</p>`,
      },
      profile: {
        eyebrow: "", title: "Profile", intro: "",
        // Identity, personal information and account settings, then Log out / Delete (the
        // account panel, js/auth.js), then the sitter's public-profile form.
        body: `<div class="profile-page"><div class="profile-summary" data-profile-summary>${profileSummary(ctx)}</div><div class="account-slot" id="account" data-account-panel></div>${ctx && ctx.role === "parent" ? "" : sitterProfile()}</div>`,
      },
    }[page];
    if (!views) return;
    document.title = `CareNest — ${views.title}`;
    root.innerHTML = page === "schedule" || page === "carelog" || page === "profile" ? views.body : `<header class="secondary-header"><p class="page-eyebrow">${views.eyebrow}</p><h1>${views.title}</h1><p>${views.intro}</p></header>${views.body}`;
    if (page === "schedule") {
      // SI-71: the sitter's checklist (schedule.html, filled by js/app.js) sits under Current Shift.
      const slot = root.querySelector("[data-checklist-slot]");
      const checklist = document.getElementById("checklist");
      if (slot && checklist) slot.replaceWith(checklist);
      bindSchedule(ctx, Boolean(ctx && ctx.role === "parent"));
    }
    if (page === "carelog") bindCareLog(isParent);
    if (editable) bindEditors(ctx);
    if (page === "profile" && (!ctx || ctx.role !== "parent")) bindSitterProfile(ctx || {});
    if (page === "profile") auth.mountAccountPanel(root.querySelector("[data-account-panel]"), ctx);
  }

  // The Care Log tab: this shift's timeline, read from js/shift-data.js like parent.html's panel.
  function bindCareLog(isParent) {
    const careLog = window.CareNestCareLog;
    const fail = () => {
      root.innerHTML = `<header class="schedule-topnav"><h1>Care Log</h1></header><p class="locked-note">We couldn’t load this shift’s care log. Reload the page to try again.</p>`;
    };
    if (!careLog || !window.CareNestShift) return fail();
    window.CareNestShift.ready.then((shift) => {
      if (!shift) return fail();
      careLog.mountPage(root, {
        shift,
        data: window.CareNestData,
        isParent,
        logHref: "index.html#checklist",
        galleryHref: isParent ? "gallery.html?as=parent" : "gallery.html",
      });
    }, fail);
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
    // Today from the clock: the page can stay open past midnight, and the minute check below moves
    // it on (SI-80), so a parent at 12:30 AM sees last night's session as the current one.
    let today = dateKey(new Date());
    // A day can hold more than one session (the table is unique on plan, date, and start time).
    const dayAppointments = (date) => appointments.filter((item) => item.date === date).sort((a, b) => timeValue(a.start_time) - timeValue(b.start_time));
    const sortedActivities = (appointment) => (Array.isArray(appointment.activities) ? appointment.activities : []).slice().sort((a, b) => sessionOrder(a.time, appointment.start_time, appointment.end_time) - sessionOrder(b.time, appointment.start_time, appointment.end_time));
    // Today's sessions, after any overnight session from yesterday still under way (SI-80): a
    // 7:00pm – 1:00am session is the current one until 1:00am, then it is over.
    const continuing = () => continuingSessions(appointments, new Date(), sessionTimes)
      .filter((item) => item.date === addDays(today, -1))
      .sort((a, b) => timeValue(a.start_time) - timeValue(b.start_time));
    const currentSessions = () => continuing().concat(dayAppointments(today));
    const currentHours = (item) => (item.date === today ? sessionHours(item) : `${displayTime(item.start_time)} yesterday - ${displayTime(item.end_time)}`);
    const eventDates = () => new Set(appointments.map((item) => item.date));
    const openRequest = (date) => requests.find((item) => item.date === date);
    const parentFirst = () => String(data.parentName || "").trim().split(/\s+/)[0] || "";
    const notices = pageEl.querySelector("[data-request-notices]");
    function setStatus(text, isError) {
      status.textContent = text;
      status.classList.toggle("is-error", Boolean(isError));
    }

    function appointmentHtml(item) {
      const children = sessionChildren(item);
      return `<article class="upcoming-shift"><p><strong>${esc(displayDate(item.date))}</strong><span>${esc(sessionHours(item))}</span></p><div class="schedule-people">${childAvatars(children)}</div></article>`;
    }
    function sessionHtml(appointment, several) {
      const activities = sortedActivities(appointment);
      const id = esc(appointment.id);
      const notes = appointment.note ? `<aside class="schedule-notes">${ICONS.notes}<div><strong>Today’s Notes</strong><p>${esc(appointment.note)}</p></div></aside>` : "";
      const heading = several ? `<h3 class="schedule-session-heading">Session ${esc(sessionHours(appointment))}</h3>` : "";
      const forWhom = (item) => activityFor(item, sessionChildren(appointment));
      // A booked session with no activities yet is still a schedule: show its hours, not "Request".
      if (!activities.length && !several) return `<div class="schedule-empty"><p>Session ${esc(sessionHours(appointment))}</p><small>No activities added yet.</small>${editable ? `<button class="schedule-empty-button" type="button" data-edit-schedule="${id}">Edit Schedule</button>` : ""}</div>${notes}`;
      const list = activities.length
        ? `<ol class="schedule-activity-list">${activities.map((item) => `<li><time>${esc(displayTime(item.time) || "Any time")}</time><div><strong>${esc(item.title)}</strong>${activityDetails(item, "p")}${forWhom(item) ? `<p class="schedule-activity-for">For ${esc(forWhom(item))}</p>` : ""}</div></li>`).join("")}</ol>`
        : '<p class="schedule-session-empty">No activities added yet.</p>';
      return `${heading}${list}${notes}${editable ? `<button type="button" class="schedule-edit-button" data-edit-schedule="${id}">Edit Schedule</button>` : ""}`;
    }
    // Today's list after midnight (SI-80): last night's session still under way, as one line that
    // opens yesterday's list, where its activities are.
    function continuesHtml(item) {
      return `<button type="button" class="schedule-continues" data-show-date="${esc(item.date)}"><strong>Continues from yesterday until ${esc(displayTime(item.end_time))}</strong><small>Session ${esc(sessionHours(item))} · View</small></button>`;
    }
    function listHtml() {
      const sessions = dayAppointments(selected);
      const carried = selected === today ? continuing() : [];
      const lead = carried.map(continuesHtml).join("");
      if (!sessions.length) return lead + emptyHtml(carried.length > 0);
      if (sessions.length === 1) return lead + sessionHtml(sessions[0], false);
      return lead + sessions.map((appointment) => `<section class="schedule-session">${sessionHtml(appointment, true)}</section>`).join("");
    }
    // carried: last night's session is still under way, so today is not without a schedule and
    // there is nothing to request yet.
    function emptyHtml(carried) {
      const parent = parentFirst();
      let action;
      if (carried) return `<div class="schedule-empty schedule-empty--after"><p>Nothing else scheduled today.</p>${editable ? '<button class="schedule-empty-button" type="button" data-book-appointment>Add Schedule</button>' : ""}</div>`;
      if (editable) action = '<button class="schedule-empty-button" type="button" data-book-appointment>Add Schedule</button>';
      // Past days cannot get a schedule (booking starts today), so there is nothing to request.
      else if (selected < today) action = "";
      else if (openRequest(selected)) action = `<button class="schedule-empty-button" type="button" disabled>Reminder sent to ${esc(parent || "the parent")}</button><small>${esc(parent || "The parent")} will see it on their schedule.</small>`;
      else action = '<button class="schedule-empty-button" type="button" data-request-schedule>Request Schedule</button><small>Send a reminder to the parent to add a schedule for this day.</small>';
      return `<div class="schedule-empty">${ICONS.emptyCalendar}<p>No schedule has been added${editable ? "." : " for this shift."}</p>${action}</div>`;
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
      const booked = currentSessions();
      pageEl.querySelector("[data-current-date]").textContent = displayDate(today);
      pageEl.querySelector("[data-current-session-time]").textContent = booked.length ? booked.map(currentHours).join(", ") : "No session today";
      const todayIds = new Set(booked.flatMap((item) => sessionChildren(item).map((child) => child.id)));
      const todayKids = familyChildren().filter((child) => !booked.length || todayIds.has(child.id));
      const currentChildren = pageEl.querySelector("[data-current-children]");
      if (currentChildren) currentChildren.innerHTML = childAvatars(todayKids);
      label.textContent = view === "calendar" ? displayMonth(selected) : `${shortDate(selected)}${isToday ? " (Today)" : ""}`;
      content.innerHTML = view === "list" ? listHtml() : calendarHtml();
      upcomingEl.innerHTML = appointments.filter((item) => item.date > today).sort((a, b) => a.date.localeCompare(b.date) || timeValue(a.start_time) - timeValue(b.start_time)).slice(0, 4).map(appointmentHtml).join("") || `<p class="schedule-no-upcoming">No upcoming ${editable ? "sessions" : "shifts"} scheduled.</p>`;
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
    // Schedule Details (SI-74): nothing here reaches the database until the header's Save. Adding,
    // editing, or deleting an activity changes `activityList` and redraws the list at once, so the
    // parent sees every change while editing (SI-77, SI-78); Delete Schedule (SI-79) is the one
    // action that saves on its own, after a confirmation.
    function openBooking(appointmentId, date) {
      const existing = appointmentId ? appointments.find((item) => item.id === appointmentId) : null;
      const kids = familyChildren();
      const kidIds = kids.map((child) => child.id);
      // Who the session is for (SI-75). A session saved before children were recorded was for
      // the whole family, so it opens with every child picked, as does a new one.
      let sessionIds = sessionChildren(existing).map((child) => child.id);
      const activityList = existing && Array.isArray(existing.activities)
        ? existing.activities.map((item) => ({ ...item, childIds: Array.isArray(item.childIds) ? item.childIds.filter((id) => kidIds.includes(id)) : [] }))
        : [];
      // Booking starts today, but a session already under way from yesterday (an overnight one at
      // 12:30 AM) keeps its own date, or the browser would refuse to save it.
      const minDate = existing && existing.date < today ? existing.date : today;
      const startValue = inputTime(existing && existing.start_time, "15:00");
      const endValue = inputTime(existing && existing.end_time, "19:00");
      const childChip = (child, attr, pressed) => `<button type="button" class="schedule-choice${pressed ? " selected" : ""}" ${attr}="${esc(child.id)}" aria-pressed="${pressed}"><span class="schedule-avatar" aria-hidden="true">${esc(initials(child.name))}</span>${esc(firstName(child))}</button>`;
      const childrenGroup = kids.length
        ? `<div class="schedule-child-choices" role="group" aria-label="Children for this session">${kids.map((child) => childChip(child, "data-session-child", sessionIds.includes(child.id))).join("")}</div>`
        : '<p class="schedule-session-empty">No children added yet. Add them on the Children tab.</p>';
      const dialog = document.createElement("dialog");
      dialog.className = "confirm-dialog manage-dialog schedule-sheet";
      dialog.setAttribute("aria-labelledby", "schedule-details-title");
      dialog.innerHTML = `<form class="confirm-dialog-body schedule-details-form" method="dialog"><div class="schedule-details-header"><button class="schedule-close" type="button" aria-label="Close without saving">${ICONS.cancel}</button><h2 class="panel-title" id="schedule-details-title">Schedule Details</h2><button class="schedule-save" value="save">Save</button></div><label class="field-label" for="appointment-date">Date</label><span class="schedule-picker">${ICONS.smallCalendar}<span class="schedule-picker-value" data-date-display aria-hidden="true">${esc(pickerDate(existing ? existing.date : date || selected))}</span>${ICONS.chevronDown}<input class="schedule-picker-input" id="appointment-date" name="date" type="date" required min="${minDate}" value="${esc(existing ? existing.date : date || selected)}"></span><div class="schedule-time-fields"><div class="field-label"><span>Start time</span>${timeWheelHtml("start", startValue, "Start time")}</div><div class="field-label"><span>End time</span>${timeWheelHtml("end", endValue, "End time")}</div></div><p class="schedule-session-length" data-session-length aria-live="polite"></p><div class="schedule-detail-group"><div class="schedule-detail-label"><strong>Children</strong>${kids.length > 1 ? "<small>Select all that apply</small>" : ""}</div>${childrenGroup}</div><div class="schedule-detail-group"><strong id="schedule-activities-title">Activities</strong><div class="schedule-editor-activities" data-activity-list aria-labelledby="schedule-activities-title"></div><button class="schedule-add-activity" type="button" data-add-activity>Add Activity</button></div><div class="schedule-detail-group"><div class="schedule-detail-label"><strong>Today’s Notes</strong><small class="is-optional">Optional</small></div><textarea class="text-input manage-textarea" name="note" rows="3" placeholder="Anything else the caregiver should know?">${esc(existing && existing.note || "")}</textarea></div><p class="form-error" hidden data-form-error></p>${existing ? '<button type="button" class="schedule-delete" data-delete-schedule>Delete Schedule</button>' : ""}<p class="visually-hidden" role="status" data-dialog-status></p></form>`;
      document.body.appendChild(dialog);
      const form = dialog.querySelector("form");
      const errorEl = dialog.querySelector("[data-form-error]");
      const addButton = dialog.querySelector("[data-add-activity]");
      // The date field shows "Tue, Nov. 10" over the native picker, which still holds the value.
      const dateInput = dialog.querySelector("#appointment-date");
      dateInput.addEventListener("input", () => { dialog.querySelector("[data-date-display]").textContent = pickerDate(dateInput.value); });
      dateInput.addEventListener("click", () => { try { dateInput.showPicker(); } catch (e) { /* the browser opens it itself */ } });
      const announce = (text) => { dialog.querySelector("[data-dialog-status]").textContent = text; };
      const showError = (text) => { errorEl.textContent = text; errorEl.hidden = false; if (!dialog.open) dialog.showModal(); errorEl.scrollIntoView({ block: "nearest" }); };

      function renderActivities() {
        const list = dialog.querySelector("[data-activity-list]");
        const start = readTimeWheel(dialog, "start"), end = readTimeWheel(dialog, "end");
        const rows = activityList.slice().sort((a, b) => sessionOrder(a.time, start, end) - sessionOrder(b.time, start, end));
        list.innerHTML = rows.length
          ? rows.map((item) => {
            const forWhom = activityFor(item, activityChoices());
            return `<div data-activity-row="${esc(item.id)}"><time>${esc(displayTime(item.time) || "Any time")}</time><span><b>${esc(item.title)}</b>${activityDetails(item, "small")}${forWhom ? `<small class="schedule-activity-for">For ${esc(forWhom)}</small>` : ""}</span><span class="schedule-activity-actions"><button type="button" data-edit-activity="${esc(item.id)}" aria-label="Edit ${esc(item.title)}">${ICONS.edit}</button></span></div>`;
          }).join("")
          : '<p class="schedule-session-empty">No activities added yet.</p>';
      }
      const activityEditor = () => dialog.querySelector("[data-activity-editor]");
      function closeActivityEditor() {
        const editor = activityEditor();
        if (editor) editor.remove();
        addButton.hidden = false;
      }
      // The children an activity can be for: the session's picks, or every child before any pick.
      const activityChoices = () => { const picked = kids.filter((child) => sessionIds.includes(child.id)); return picked.length ? picked : kids; };
      function openActivityEditor(id) {
        closeActivityEditor();
        const row = id ? activityList.find((item) => item.id === id) : null;
        // New activities start at the session's start time (SI-76), as currently set above.
        const sessionStart = readTimeWheel(dialog, "start") || startValue;
        const time = row ? inputTime(row.time, sessionStart) : sessionStart;
        const choices = activityChoices();
        const picked = row && row.childIds && row.childIds.length ? row.childIds : choices.map((child) => child.id);
        const editor = document.createElement("div");
        editor.className = "schedule-inline-activity";
        editor.dataset.activityEditor = row ? row.id : "";
        editor.innerHTML = `<div class="field-label"><span>Time</span>${timeWheelHtml("activity", time, "Activity time")}</div><label>Activity<input class="text-input" data-field="title" value="${esc(row ? row.title : "")}" placeholder="Activity name" maxlength="120" autocomplete="off"></label><label>Notes<textarea class="text-input" data-field="detail" rows="2" placeholder="Notes" maxlength="500">${esc(row ? row.detail || "" : "")}</textarea></label>${kids.length > 1 ? `<div class="schedule-activity-children"><span id="activity-children-label">Children</span><div class="schedule-child-choices" role="group" aria-labelledby="activity-children-label">${choices.map((child) => childChip(child, "data-activity-child", picked.includes(child.id))).join("")}</div></div>` : ""}<p class="form-error" hidden data-activity-error></p><div class="schedule-activity-editor-actions">${row ? `<button class="schedule-delete-activity" type="button" data-delete-activity="${esc(row.id)}">Delete activity</button>` : ""}<button class="photo-source-btn" type="button" data-cancel-activity>Cancel</button><button class="schedule-save" type="button" data-save-activity>${row ? "Save activity" : "Add activity"}</button></div>`;
        addButton.after(editor);
        addButton.hidden = true;
        editor.querySelector("[data-field=title]").focus();
      }
      // Moves the open editor into the list. False (and a message) when it can't be saved yet.
      function commitActivity() {
        const editor = activityEditor();
        if (!editor) return true;
        const titleEl = editor.querySelector("[data-field=title]");
        const title = titleEl.value.trim();
        const activityError = (text, focusEl) => { const el = editor.querySelector("[data-activity-error]"); el.textContent = text; el.hidden = false; if (focusEl) focusEl.focus(); return false; };
        if (!title) return activityError("Give the activity a name.", titleEl);
        let childIds = activityChoices().map((child) => child.id);
        if (kids.length > 1) {
          childIds = [...editor.querySelectorAll("[data-activity-child]")].filter((chip) => chip.getAttribute("aria-pressed") === "true").map((chip) => chip.dataset.activityChild);
          if (!childIds.length) return activityError("Pick at least one child for this activity.", editor.querySelector("[data-activity-child]"));
        }
        const values = { title, time: formatTime(readTimeWheel(editor, "activity")), detail: editor.querySelector("[data-field=detail]").value.trim(), childIds };
        const row = activityList.find((item) => item.id === editor.dataset.activityEditor);
        // Keep the activity's other fields (a location from the day's plan, for one) as they were.
        if (row) Object.assign(row, values); else activityList.push({ id: newActivityId(), location: null, ...values });
        closeActivityEditor();
        renderActivities();
        announce(row ? `${title} updated.` : `${title} added.`);
        addButton.focus();
        return true;
      }
      const editorIsBlank = (editor) => !editor.querySelector("[data-field=title]").value.trim() && !editor.querySelector("[data-field=detail]").value.trim();

      async function deleteSchedule(button) {
        const confirmed = await auth.confirmDialog({
          title: "Delete this session?",
          body: `The ${displayDate(existing.date)} session (${sessionHours(existing)}) and its activities will be removed for everyone in the family, including your sitter. This can't be undone.`,
          confirmLabel: "Delete session",
          danger: true,
        });
        if (!confirmed) return;
        button.disabled = true;
        errorEl.hidden = true;
        try {
          if (live) {
            const result = await ctx.client.from("appointments").delete().eq("id", existing.id).select("id");
            if (result.error) throw result.error;
            // RLS turns a refused delete, or one already deleted elsewhere, into zero rows.
            if (!(result.data && result.data.length)) {
              button.disabled = false;
              return showError("This session couldn't be deleted. It may have already been removed. Reload the page to check.");
            }
          }
          const remaining = appointments.filter((item) => item.id !== existing.id);
          if (ctx && ctx.demo && demo) {
            data.appointments = remaining.slice();
            const saveError = demo.save();
            if (saveError) throw saveError;
          }
          appointments = remaining;
          dialog.close();
          setStatus("Session deleted.");
          render();
          pageEl.querySelector("[data-book-appointment]")?.focus();
        } catch (error) {
          button.disabled = false;
          showError(auth.friendlyError(error));
        }
      }

      dialog.querySelector(".schedule-close").addEventListener("click", () => dialog.close("cancel"));
      // The header's Save submits the form, and so does Enter in a field. An activity still being
      // typed is added first so it isn't lost; one that can't be added yet stops the save.
      form.addEventListener("submit", (event) => {
        const editor = activityEditor();
        if (!editor) return;
        if (editorIsBlank(editor)) return closeActivityEditor();
        if (!commitActivity()) event.preventDefault();
      });
      dialog.addEventListener("keydown", (event) => {
        // Enter in the activity's name adds the activity rather than saving the whole schedule.
        if (event.key !== "Enter" || !event.target.closest("[data-activity-editor]") || event.target.matches("textarea, button")) return;
        event.preventDefault();
        commitActivity();
      });
      dialog.addEventListener("close", async () => {
        // Clear it now: Esc and cancel don't set returnValue, so a stale "save" from a failed
        // attempt would make the next Esc save again instead of cancelling.
        const action = dialog.returnValue;
        dialog.returnValue = "";
        if (action !== "save") return dialog.remove();
        errorEl.hidden = true;
        const values = Object.fromEntries(new FormData(form).entries());
        values.start = readTimeWheel(dialog, "start");
        values.end = readTimeWheel(dialog, "end");
        const chosen = sessionIds.filter((id) => kidIds.includes(id));
        // An end before the start ends the next day (SI-80); the same time is not a session.
        const missing = !values.date ? "Enter a date." : kids.length && !chosen.length ? "Select at least one child." : !sessionLength(values.start, values.end) ? "End time must be different from the start time." : "";
        if (missing) return showError(missing);
        // Across midnight too: an overnight session clashes with an early session the next day.
        const draft = { date: values.date, start: values.start, end: values.end };
        const clash = appointments.find((other) => !(existing && other.id === existing.id) && sessionsOverlap(draft, sessionTimes(other)));
        if (clash) return showError(`This overlaps the ${sessionHours(clash)} session ${clash.date === values.date ? "that day" : `on ${displayDate(clash.date)}`}.`);
        // AM/PM slip guard: over 12 hours is more likely 9:00 AM to 5:00 AM picked for 5:00 PM.
        // Asked again only when the times change, not on every save of a long session.
        const sameTimes = existing && clockMinutes(existing.start_time) === clockMinutes(values.start) && clockMinutes(existing.end_time) === clockMinutes(values.end);
        if (isLongSession(values.start, values.end) && !sameTimes) {
          const confirmed = await auth.confirmDialog({
            title: "Is this session right?",
            body: `This session is ${formatLength(sessionLength(values.start, values.end))} long, ending ${displayTime(formatTime(values.end))}${endsNextDay(values.start, values.end) ? " the next day" : ""}. Save it?`,
            confirmLabel: "Save session",
          });
          if (!confirmed) return dialog.showModal(); // back to Schedule Details, nothing saved
        }
        // An activity keeps only children still on the session; one left with none is for all of them.
        const activities = activityList.map((activity) => {
          const ids = (activity.childIds || []).filter((id) => chosen.includes(id));
          return { ...activity, childIds: ids.length ? ids : chosen.slice() };
        });
        const item = { id: existing ? existing.id : `appointment-${Date.now()}`, date: values.date, start_time: formatTime(values.start), end_time: formatTime(values.end), note: values.note.trim(), activities, childIds: chosen };
        try {
          if (live) {
            const fields = { appointment_date: item.date, start_time: values.start, end_time: values.end, note: item.note, activities: item.activities, child_ids: chosen };
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
      dialog.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        if (!button || !dialog.contains(button)) return;
        if (button.dataset.sessionChild) {
          const on = button.getAttribute("aria-pressed") !== "true";
          button.setAttribute("aria-pressed", String(on));
          button.classList.toggle("selected", on);
          sessionIds = on ? sessionIds.concat(button.dataset.sessionChild) : sessionIds.filter((id) => id !== button.dataset.sessionChild);
          return;
        }
        if (button.dataset.activityChild) {
          const on = button.getAttribute("aria-pressed") !== "true";
          button.setAttribute("aria-pressed", String(on));
          button.classList.toggle("selected", on);
          return;
        }
        if (button.hasAttribute("data-add-activity")) return openActivityEditor(null);
        if (button.dataset.editActivity) return openActivityEditor(button.dataset.editActivity);
        if (button.hasAttribute("data-save-activity")) return commitActivity();
        if (button.hasAttribute("data-cancel-activity")) { closeActivityEditor(); addButton.focus(); return; }
        if (button.dataset.deleteActivity) {
          // Removed from this edit only; Save keeps the change, closing without saving undoes it.
          const index = activityList.findIndex((item) => item.id === button.dataset.deleteActivity);
          if (index < 0) return;
          const [removed] = activityList.splice(index, 1);
          if (activityEditor() && activityEditor().dataset.activityEditor === removed.id) closeActivityEditor();
          renderActivities();
          announce(`${removed.title} deleted. Save to keep this change.`);
          addButton.focus();
          return;
        }
        if (button.hasAttribute("data-delete-schedule")) deleteSchedule(button);
      });
      // The session's length under the time pickers, and "ends the next day" for an end before the
      // start (SI-80). Activities re-sort too, since their order follows the session's start.
      function renderLength() {
        const start = readTimeWheel(dialog, "start"), end = readTimeWheel(dialog, "end");
        const length = sessionLength(start, end);
        dialog.querySelector("[data-session-length]").textContent = !length
          ? "Pick an end time different from the start time."
          : `${formatLength(length)}${endsNextDay(start, end) ? `, ends ${displayTime(formatTime(end))} the next day` : ""}`;
      }
      dialog.addEventListener("change", (event) => {
        if (!event.target.closest('[data-time-wheel="start"], [data-time-wheel="end"]')) return;
        renderLength();
        renderActivities();
      });
      renderLength();
      renderActivities();
      dialog.showModal();
    }
    pageEl.addEventListener("click", (event) => {
      const target = event.target.closest("button"); if (!target) return;
      if (target.dataset.view) { view = target.dataset.view; render(); }
      if (target.dataset.date) { selected = addDays(selected, target.dataset.date === "next" ? 1 : -1); render(); }
      if (target.dataset.calendarDate) { selected = target.dataset.calendarDate; render(); }
      if (target.dataset.showDate) { selected = target.dataset.showDate; render(); }
      if (target.matches("[data-request-schedule]")) requestSchedule(target);
      if (target.dataset.requestAdd) { selected = target.dataset.requestAdd; view = "list"; render(); openBooking(null, selected); }
      if (target.dataset.requestDismiss && live) dismissRequest(target);
      if (target.matches("[data-book-appointment]")) openBooking(null, selected);
      if (target.matches("[data-edit-schedule]")) {
        // The Current Session pencil has no id: it means the session the card shows (last night's
        // overnight one while it is under way, else today's first), or a new one today.
        const id = target.dataset.editSchedule || (currentSessions()[0] || {}).id;
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
    // Each minute, and on return to the tab: redraw only when today or the current sessions
    // changed (midnight, or an overnight session ending at 1:00 AM), as js/app.js's What's next
    // does. A list showing today follows to the new day; another selected day stays put.
    const clockKey = () => JSON.stringify([today, currentSessions().map((item) => item.id)]);
    let lastClockKey = clockKey();
    const recheck = () => {
      const now = dateKey(new Date());
      if (now !== today) {
        if (selected === today) selected = now;
        today = now;
      }
      const key = clockKey();
      if (key === lastClockKey) return;
      lastClockKey = key;
      render();
    };
    const untilNextMinute = () => 60000 - (Date.now() % 60000) + 50;
    const tick = () => { recheck(); setTimeout(tick, untilNextMinute()); };
    setTimeout(tick, untilNextMinute());
    document.addEventListener("visibilitychange", () => { if (!document.hidden) recheck(); });
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
