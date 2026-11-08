// Several children per family (SI-45, slice C): the helpers every page shares.
//
// window.CareNestData.children is the source of truth for what belongs to one child: each child
// has its own food, preferences, and instructions. Where things are, emergency steps, contacts,
// the schedule, and shifts stay family-wide (README, "Children"). flatten() rebuilds the
// family-wide lists the older pages read (food page, care info pages, home tiles) from the
// children, tagging each item with its child, so those pages can say whose item it is.
//
// No DOM and no network: js/family-data.js (signed in) and js/data.js (demo) call these, and
// tests/children.test.mjs runs them under Node.
(function (root) {
  const PER_CHILD = ["food", "preferences", "instructions"];
  const SEVERITY_CLASS = { Severe: "badge--severe", Moderate: "badge--moderate", Mild: "badge--mild" };

  // The order the database uses for "first child": position, then oldest, then id.
  function sortChildren(children) {
    return (children || []).slice().sort((a, b) => {
      if ((a.position || 0) !== (b.position || 0)) return (a.position || 0) - (b.position || 0);
      const at = String(a.createdAt || "");
      const bt = String(b.createdAt || "");
      if (at !== bt) return at < bt ? -1 : 1;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  // Two letters for the avatar circle; the app shows initials, never a child's photo.
  function initials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    return parts.map((part) => part[0]).slice(0, 2).join("").toUpperCase();
  }

  function displayName(child) {
    return String((child && child.name) || "").trim() || "Child";
  }

  function firstName(child) {
    return displayName(child).split(/\s+/)[0];
  }

  // "Age 3 · Preschooler", whichever parts the parent filled in.
  function detailParts(child) {
    return [child && child.age, child && child.stage].map((part) => String(part || "").trim()).filter(Boolean);
  }

  // The age as the Children tab shows it (Figma 210:155): "3 years old", "1 year old", "11 months
  // old". Display only; the stored label is unchanged. Uses the care log's parser when that page
  // loaded it, else the same rule locally ("Age 3" is years). Unreadable labels come back as typed.
  const AGE_PART = /(\d+(?:\.\d+)?)\s*(years?|yrs?|y\.?o\.?|y|months?|mos?|mths?|m|weeks?|wks?|w|days?|d)?(?![a-z])/g;
  const UNIT_MONTHS = { y: 12, m: 1, w: 12 / 52, d: 12 / 365 };
  function localAgeMonths(label) {
    const text = String(label == null ? "" : label).trim().toLowerCase();
    if (!text) return null;
    let total = 0;
    let found = false;
    let match;
    AGE_PART.lastIndex = 0;
    while ((match = AGE_PART.exec(text))) {
      total += Number(match[1]) * UNIT_MONTHS[match[2] ? match[2].charAt(0) : "y"];
      found = true;
    }
    return found ? total : null;
  }

  function ageText(label) {
    const raw = String(label || "").trim();
    if (!raw) return "";
    const careLog = root.CareNestCareLog;
    const months = careLog && careLog.parseAgeMonths ? careLog.parseAgeMonths(raw) : localAgeMonths(raw);
    if (months === null || !Number.isFinite(months)) return raw;
    if (months >= 24 || months === 12) {
      const years = Math.floor(months / 12);
      return `${years} ${years === 1 ? "year" : "years"} old`;
    }
    const whole = Math.floor(months);
    if (whole < 1) return raw;
    return `${whole} ${whole === 1 ? "month" : "months"} old`;
  }

  // detailParts with the age written out, for the Children tab.
  function displayParts(child) {
    return [ageText(child && child.age), String((child && child.stage) || "").trim()].filter(Boolean);
  }

  // "Thomas family" / "The Thomas Family" / "Thomas" -> "Thomas", so the page can say "The Thomas
  // Family" or "Thomas Family" whichever way the name was stored. Display only.
  function familyBase(name) {
    const text = String(name || "").trim();
    const base = text.replace(/^the\s+/i, "").replace(/\s+family$/i, "").trim();
    return base || text;
  }

  // Names of this child's food items marked Severe, for the red tag on the list.
  function severeAllergies(child) {
    return ((child && child.food) || []).filter((item) => item.severity === "Severe").map((item) => item.name);
  }

  function hasAnyInfo(child) {
    return PER_CHILD.some((key) => ((child && child[key]) || []).length) || Boolean(child && child.careNote);
  }

  // "3:00pm", "3:00 PM", "15:00" -> minutes after midnight, or null.
  function minutesOf(value) {
    const match = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(String(value || "").trim());
    if (!match) return null;
    let hours = Number(match[1]);
    const period = (match[3] || "").toLowerCase();
    if (period === "pm" && hours !== 12) hours += 12;
    if (period === "am" && hours === 12) hours = 0;
    return hours * 60 + Number(match[2]);
  }

  function clock(minutes) {
    const hours = Math.floor(minutes / 60);
    return `${hours % 12 === 0 ? 12 : hours % 12}:${String(minutes % 60).padStart(2, "0")} ${hours >= 12 ? "PM" : "AM"}`;
  }

  function localKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function fromKey(key) {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  // The family's next sit, for the tag on the family card. A sit still under way today counts.
  // Returns { text, soon } (soon: today or tomorrow, shown highlighted), or null for none.
  function nextSit(appointments, now) {
    const current = now || new Date();
    const today = localKey(current);
    const nowMinutes = current.getHours() * 60 + current.getMinutes();
    const yesterday = localKey(new Date(current.getFullYear(), current.getMonth(), current.getDate() - 1));
    // An end before the start ends the next day (SI-80): yesterday's 7:00 PM - 1:00 AM sit is
    // still under way at 12:30 AM, and today's is until 1:00 AM tomorrow.
    const overnight = (item) => item.end !== null && item.end < item.start;
    const upcoming = (appointments || [])
      .map((item) => ({ date: item.date, start: minutesOf(item.start_time), end: minutesOf(item.end_time) }))
      .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.date || "") && item.start !== null)
      .filter((item) => item.date > today
        || (item.date === today && (overnight(item) || (item.end === null ? item.start : item.end) > nowMinutes))
        || (item.date === yesterday && overnight(item) && item.end > nowMinutes))
      .sort((a, b) => (a.date === b.date ? a.start - b.start : a.date < b.date ? -1 : 1));
    const next = upcoming[0];
    if (!next) return null;
    if (next.date === yesterday) return { text: `Now until ${clock(next.end)}`, soon: true };
    const tomorrow = localKey(new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1));
    const time = clock(next.start);
    if (next.date === today) return { text: `Today ${time}`, soon: true };
    if (next.date === tomorrow) return { text: `Tomorrow ${time}`, soon: true };
    const day = fromKey(next.date).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    return { text: `${day} at ${time}`, soon: false };
  }

  function foodItem(row) {
    return {
      id: row.id,
      name: row.title,
      severity: row.severity || "",
      severityClass: SEVERITY_CLASS[row.severity] || "",
      image: null,
      description: row.detail || "",
    };
  }

  // Database rows (children, care_items) -> data.children. Items whose child is gone are dropped;
  // there are none while the foreign key cascades.
  function fromRows(childRows, careRows) {
    const children = sortChildren(
      (childRows || []).map((row) => ({
        id: row.id,
        name: row.name || "",
        age: row.age_label || "",
        stage: row.stage_label || "",
        pinnedNote: row.pinned_note || "",
        position: row.position || 0,
        createdAt: row.created_at || "",
        avatar: null,
        careNote: "",
        food: [],
        preferences: [],
        instructions: [],
      })),
    );
    const byId = new Map(children.map((child) => [child.id, child]));
    (careRows || []).forEach((row) => {
      if (!PER_CHILD.includes(row.category)) return;
      const child = byId.get(row.child_id);
      if (!child) return;
      child[row.category].push(row.category === "food" ? foodItem(row) : { id: row.id, title: row.title, detail: row.detail || "" });
    });
    return children;
  }

  // Rebuilds the family-wide views of per-child items from data.children, and data.child (the
  // first child, which the home and schedule pages still name).
  function flatten(data) {
    const children = sortChildren(data.children || []);
    data.children = children;
    const several = children.length > 1;
    const tag = (child) => (item) => Object.assign({}, item, { childId: child.id, childName: several ? displayName(child) : "" });
    const all = (key) => children.flatMap((child) => (child[key] || []).map(tag(child)));
    data.allergies.items = all("food");
    data.categories.preferences.items = all("preferences");
    data.categories.instructions.items = all("instructions");
    // Demo care notes are per child; the food page shows them under one heading.
    const notes = children.filter((child) => child.careNote).map((child) => (several ? `${firstName(child)}: ${child.careNote}` : child.careNote));
    data.allergies.careNote = notes.length ? notes.join("\n") : null;
    const first = children[0];
    const previous = data.child || {};
    data.child = {
      name: first ? displayName(first) : "Child",
      age: first ? first.age : "",
      avatar: null,
      dateLabel: previous.dateLabel || "",
      shiftTime: previous.shiftTime || "",
    };
    return data;
  }

  function findChild(data, id) {
    return (data.children || []).find((child) => child.id === id) || null;
  }

  // "Jack" / "Jack and Kylie" / "Jack, Kylie, and Sam" (or "or"), for lines that name the children.
  function namesList(children, word) {
    const joiner = word || "and";
    const names = (children || []).map(firstName);
    if (names.length <= 1) return names[0] || "";
    if (names.length === 2) return `${names[0]} ${joiner} ${names[1]}`;
    return `${names.slice(0, -1).join(", ")}, ${joiner} ${names[names.length - 1]}`;
  }

  // The Call 911 callout, naming every child when they all have names ("If Jack or Kylie is...").
  function emergencyText(children) {
    const named = (children || []).filter((child) => String(child.name || "").trim());
    const who = named.length && named.length === children.length ? namesList(named, "or") : "a child";
    return `If ${who} is in danger, not breathing, or having a severe allergic reaction, call 911 first.`;
  }

  const api = {
    PER_CHILD,
    SEVERITY_CLASS,
    sortChildren,
    initials,
    displayName,
    firstName,
    detailParts,
    ageText,
    displayParts,
    familyBase,
    severeAllergies,
    hasAnyInfo,
    nextSit,
    fromRows,
    flatten,
    findChild,
    namesList,
    emergencyText,
  };
  root.CareNestChildren = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
