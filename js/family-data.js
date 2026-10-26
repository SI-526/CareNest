// Loads the signed-in family's care info from Supabase and reshapes it into
// window.CareNestData (the shape js/data.js defines), so the existing renderers in js/app.js,
// js/parent.js, and js/moment.js work unchanged.
//
// Load order: after js/auth.js and js/data.js, before js/app.js. Page scripts wait on
// CareNestFamily.ready instead of CareNestAuth.ready. In ?demo=1 mode nothing is fetched and the
// bundled sample data in js/data.js is used as is.
//
// What reads what (RLS narrows every query to the caller's own household):
//   households (child_name, child_age_label) -> child name and age (already on the auth context)
//   tasks of the household's plan            -> schedule
//   care_items                                -> Good to know categories, food page, emergency steps
//   contacts                                  -> Your Contacts, Who to contact; role "Hospital" -> hospital card
//
// Live (issue #11): after the first load, Realtime changes to those tables refetch everything and
// call subscribe() listeners, so pages re-render a parent's edits without a reload.
(function () {
  const auth = window.CareNestAuth;
  const sample = window.CareNestData;
  if (!auth || !sample) return;

  // Same rule as js/auth.js (which has already run and remembered ?demo=1 for this tab).
  function demoMode() {
    try {
      return (
        new URLSearchParams(window.location.search).has("demo") ||
        sessionStorage.getItem("carenest:demo") === "1"
      );
    } catch (e) {
      return false;
    }
  }

  // Outside demo mode, drop the bundled sample family before anything can render it: a
  // signed-in person must never see sample allergies, steps, contacts or phone numbers, nor
  // their real child's name next to them. Only static labels (tile names, headings, the Call 911
  // callout) are kept; everything else starts empty and is filled from the database.
  if (!demoMode()) {
    window.CareNestData = {
      babysitter: { name: "your sitter", avatar: null, address: "" },
      child: { name: "Child", age: "", avatar: null, dateLabel: "", shiftTime: "" },
      contacts: [],
      schedule: [],
      dayNotes: [],
      knowTiles: sample.knowTiles,
      categories: {
        preferences: { title: sample.categories.preferences.title, items: [] },
        where: { title: sample.categories.where.title, items: [] },
        instructions: { title: sample.categories.instructions.title, items: [] },
        emergency: {
          title: sample.categories.emergency.title,
          summary: sample.categories.emergency.summary,
          callout: {
            text: "If your child is in danger, not breathing, or having a severe allergic reaction, call 911 first.",
            label: "Call 911",
            href: "tel:911",
          },
          steps: [],
          hospital: null,
          contacts: [],
        },
      },
      allergies: {
        title: sample.allergies.title,
        sectionTitle: sample.allergies.sectionTitle,
        careNote: null,
        items: [],
      },
    };
  }
  const data = window.CareNestData;

  // Which pages render the family's data (and so load it). people/manage only need the scrub.
  // Secondary parent tabs render the same household data as the home views. Include them
  // here so an inline save is followed by a reload from Supabase instead of an empty local
  // data object.
  const DATA_PAGES = ["home", "parent", "info", "food", "messages", "gallery", "schedule", "carelog", "children", "profile"];

  const HOSPITAL_ROLE = "hospital";
  const SEVERITY_CLASS = { Severe: "badge--severe", Moderate: "badge--moderate", Mild: "badge--mild" };

  // "13:30:00" -> "1:30pm". Null or malformed -> "".
  function formatTaskTime(value) {
    const match = /^(\d{1,2}):(\d{2})/.exec(value || "");
    if (!match) return "";
    const hours = Number(match[1]);
    const suffix = hours >= 12 ? "pm" : "am";
    const h12 = hours % 12 === 0 ? 12 : hours % 12;
    return `${h12}:${match[2]}${suffix}`;
  }

  // Digits (and a leading +) only, so a stored phone can never become a non-tel link.
  function phoneHref(phone) {
    const cleaned = String(phone || "").replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
    return cleaned.replace(/\D/g, "").length >= 3 ? `tel:${cleaned}` : "";
  }

  function mapHref(address) {
    return address
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`
      : "";
  }

  function isHospital(contact) {
    return (contact.role || "").trim().toLowerCase() === HOSPITAL_ROLE;
  }

  // Tasks in the parent's order: position, then time of day (no time last), then creation.
  function sortTasks(tasks) {
    return tasks.slice().sort((a, b) => {
      if (a.position !== b.position) return a.position - b.position;
      const at = a.time_of_day || "99";
      const bt = b.time_of_day || "99";
      if (at !== bt) return at < bt ? -1 : 1;
      return String(a.created_at).localeCompare(String(b.created_at));
    });
  }

  function todayLabel() {
    return new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }

  function toContact(row) {
    return {
      id: row.id,
      name: row.name,
      firstName: row.name.trim().split(/\s+/)[0],
      role: row.role || "",
      phone: row.phone || "",
      phoneHref: phoneHref(row.phone),
      address: row.address || "",
      avatar: null,
    };
  }

  // Overwrites every sample field in window.CareNestData so no sample content survives in a
  // signed-in session. Fields with no data source are emptied (see the PR's Decisions).
  function apply(ctx, rows) {
    const household = ctx.household || {};
    const members = ctx.members || [];
    const sitter =
      ctx.role === "caretaker" ? ctx.membership : members.find((m) => m.role === "caretaker");
    const plan = rows.plan;

    data.child = {
      name: (household.child_name || "").trim() || "Child",
      age: (household.child_age_label || "").trim(),
      avatar: null,
      dateLabel: todayLabel(),
      shiftTime: plan ? plan.schedule || "" : "",
    };
    data.babysitter = {
      name: sitter ? auth.firstName(sitter) : "your sitter",
      avatar: null,
      address: "",
    };
    data.planId = plan ? plan.id : null;
    data.appointments = (rows.appointments || []).map((appointment) => ({
      id: appointment.id,
      date: appointment.appointment_date,
      start_time: formatTaskTime(appointment.start_time),
      end_time: formatTaskTime(appointment.end_time),
      note: appointment.note || "",
      activities: Array.isArray(appointment.activities) ? appointment.activities : [],
    }));
    // Set here too, not only by js/auth.js fillNames(): that may have run against the sample
    // object this file discarded.
    data.viewerFirstName = auth.firstName(ctx.membership);
    const parent = members.find((m) => m.role === "parent");
    if (parent) data.parentName = (parent.display_name || "").trim() || auth.firstName(parent);

    const contacts = rows.contacts.map(toContact);
    const hospitalRow = contacts.find(isHospital);
    const people = contacts.filter((c) => !isHospital(c));
    data.contacts = people;

    // Only active tasks; archived ones live on in past shifts' check snapshots.
    data.schedule = sortTasks(plan ? (plan.tasks || []).filter((t) => !t.archived_at) : []).map((t) => ({
      id: t.id,
      time: formatTaskTime(t.time_of_day),
      title: t.title,
      detail: t.detail || null,
      location: t.location || null,
      map: null,
      careNote: t.care_note || null,
      completed: false,
    }));

    const byCategory = { preferences: [], where: [], instructions: [], emergency: [], food: [] };
    rows.careItems.forEach((item) => {
      if (byCategory[item.category]) byCategory[item.category].push(item);
    });
    const toItem = (item) => ({ id: item.id, title: item.title, detail: item.detail || "" });

    data.categories.preferences.items = byCategory.preferences.map(toItem);
    data.categories.where.items = byCategory.where.map(toItem);
    data.categories.instructions.items = byCategory.instructions.map(toItem);

    const emergency = data.categories.emergency;
    emergency.steps = byCategory.emergency.map(toItem);
    emergency.hospital = hospitalRow
      ? {
          name: hospitalRow.name,
          system: "",
          address: hospitalRow.address,
          mapHref: mapHref(hospitalRow.address),
          phone: hospitalRow.phone,
          phoneHref: hospitalRow.phoneHref,
        }
      : null;
    emergency.contacts = people;
    // The "Call 911" callout stays (static); name the child in it.
    emergency.callout = Object.assign({}, emergency.callout, {
      text: `If ${household.child_name ? data.child.name.split(/\s+/)[0] : "your child"} is in danger, not breathing, or having a severe allergic reaction, call 911 first.`,
    });

    data.viewerRole = ctx.role;
    data.isEmpty =
      !data.schedule.length && !rows.careItems.length && !rows.contacts.length;

    data.allergies.careNote = null; // no data source; shown only in demo mode
    data.allergies.items = byCategory.food.map((item) => ({
      id: item.id,
      name: item.title,
      severity: item.severity || "",
      severityClass: SEVERITY_CLASS[item.severity] || "",
      image: null,
      description: item.detail || "",
    }));
  }

  async function fetchRows(ctx) {
    const client = ctx.client;
    const householdId = ctx.household.id;
    const [household, contacts, careItems, plans, appointments] = await Promise.all([
      // Re-read so a renamed child shows live (the auth context's copy is from sign-in).
      client.from("households").select("id, name, child_name, child_age_label").eq("id", householdId).maybeSingle(),
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
      // One plan per household (the app creates it on first edit); take the first if more exist.
      client
        .from("plans")
        .select("id, title, schedule, tasks(id, title, time_of_day, detail, location, care_note, position, created_at, archived_at)")
        .eq("household_id", householdId)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true })
        .limit(1),
      client
        .from("appointments")
        .select("id, appointment_date, start_time, end_time, note, activities")
        .eq("household_id", householdId)
        .order("appointment_date", { ascending: true })
        .order("start_time", { ascending: true }),
    ]);
    const error = household.error || contacts.error || careItems.error || plans.error || appointments.error;
    if (error) throw error;
    return {
      household: household.data,
      contacts: contacts.data || [],
      careItems: careItems.data || [],
      plan: (plans.data && plans.data[0]) || null,
      appointments: appointments.data || [],
    };
  }

  // Ids of every row the current data came from: a Realtime DELETE carries only the id, so a
  // delete matters only when its id is here.
  let shownIds = new Set();
  // Refreshes can overlap (a change, a tab return, a reconnect): each takes a number, and a
  // result older than the one already applied is dropped. Rows equal to what is on screen are not
  // re-applied, so a tab return or reconnect with no change does not re-render (or drop focus).
  let lastStarted = 0;
  let lastApplied = 0;
  let lastSnapshot = null;

  // Returns true when new rows were applied.
  async function refresh(ctx) {
    const generation = ++lastStarted;
    const rows = await fetchRows(ctx);
    if (generation < lastApplied) return false;
    lastApplied = generation;
    const snapshot = JSON.stringify(rows);
    if (snapshot === lastSnapshot) return false;
    lastSnapshot = snapshot;
    if (rows.household) Object.assign(ctx.household, rows.household);
    apply(ctx, rows);
    const plan = rows.plan ? [rows.plan].concat(rows.plan.tasks || []) : [];
    shownIds = new Set(rows.contacts.concat(rows.careItems, plan).map((r) => r.id));
    return true;
  }

  // A full-screen loading / error layer while the family's data loads. Resolves once loaded;
  // on failure shows the error with "Try again" and keeps waiting.
  function loadWithStatus(ctx) {
    const layer = document.createElement("div");
    layer.className = "data-status";
    layer.setAttribute("role", "status");
    layer.innerHTML = '<p class="data-status-text">Loading your family’s information…</p>';
    document.body.appendChild(layer);

    return new Promise((resolve) => {
      async function attempt() {
        layer.innerHTML = '<p class="data-status-text">Loading your family’s information…</p>';
        try {
          await refresh(ctx);
          layer.remove();
          resolve(ctx);
        } catch (error) {
          layer.innerHTML = `<div class="auth-fatal" role="alert">
              <p>${auth.escapeHtml(auth.friendlyError(error))}</p>
              <button type="button" class="primary-btn" data-retry>Try again</button>
            </div>`;
          layer.querySelector("[data-retry]").addEventListener("click", attempt);
        }
      }
      attempt();
    });
  }

  const listeners = new Set();
  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // RLS limits the stream to this household. Realtime cannot filter DELETE events by column, so
  // deletes arrive unfiltered: refetch only when a row on screen was deleted (as day notes do).
  // Tasks get no DELETE listener: clients cannot delete a task, and a task goes only by cascade
  // from a plan or family-space delete, which the plans DELETE or households event already shows.
  function watch(ctx) {
    const client = ctx.client;
    const householdId = ctx.household.id;
    let channel = null;
    let channelPlanId;
    let timer = null;

    async function reload() {
      let changed;
      try {
        changed = await refresh(ctx);
      } catch (error) {
        // Keep what is on screen; the next change, focus or reconnect tries again.
        console.warn("CareNest: family data refresh failed", error);
        return;
      }
      if (!changed) return;
      // Re-listens only when the plan changed, so the SUBSCRIBED reload below cannot loop.
      if (data.planId !== channelPlanId) listen();
      listeners.forEach((fn) => {
        try {
          fn(data);
        } catch (error) {
          console.warn("CareNest: family data listener failed", error);
        }
      });
    }

    function scheduleReload() {
      clearTimeout(timer);
      timer = setTimeout(reload, 250);
    }

    const onDelete = (payload) => {
      if (payload.old && shownIds.has(payload.old.id)) scheduleReload();
    };
    const changes = (table, filter) => ({ event: "*", schema: "public", table, filter });

    // tasks are filtered by plan, so a new (first) plan needs a new channel. The topic names the
    // plan because supabase-js hands back a still-closing channel of the same topic.
    async function listen() {
      channelPlanId = data.planId;
      if (channel) await client.removeChannel(channel);
      channel = client.channel(`carenest-family-${householdId}-${channelPlanId || "none"}`);
      ["contacts", "care_items", "plans"].forEach((table) => {
        channel
          .on("postgres_changes", changes(table, `household_id=eq.${householdId}`), scheduleReload)
          .on("postgres_changes", { event: "DELETE", schema: "public", table }, onDelete);
      });
      channel.on("postgres_changes", changes("households", `id=eq.${householdId}`), scheduleReload);
      if (channelPlanId) {
        channel.on("postgres_changes", changes("tasks", `plan_id=eq.${channelPlanId}`), scheduleReload);
      }
      // SUBSCRIBED comes on the first join and on every rejoin; refetch then, since changes made
      // before the join (or while the socket was down) arrive with no event. This also catches the
      // first plan's tasks, inserted before the plan-filtered channel joined.
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") scheduleReload();
      });
    }

    listen();
    // Changes made while the tab slept or was offline arrive with no event.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") scheduleReload();
    });
    window.addEventListener("online", scheduleReload);
  }

  const ready = auth.ready.then(async (ctx) => {
    if (!ctx || ctx.demo || !ctx.household) return ctx;
    if (!DATA_PAGES.includes(document.body.dataset.page)) return ctx;
    await loadWithStatus(ctx);
    watch(ctx);
    return ctx;
  });

  window.CareNestFamily = { ready, subscribe, formatTaskTime, phoneHref, isHospital, HOSPITAL_ROLE };
})();
