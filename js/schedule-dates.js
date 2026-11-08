// CareNestDates — calendar-day and session-time helpers for the schedule page (js/secondary.js).
//
// Days are stepped on the calendar, never by adding 24 hours: a US fall-back day lasts 25 hours,
// so midnight + 24h is 23:00 of the same date.
//
// Overnight sessions (SI-80): a session's end time earlier than its start time means it ends the
// next day (7:00 PM to 1:00 AM is 6 hours); an end equal to the start is not a session. The
// database applies the same rule (appointments_end_differs_from_start). Lengths and overlaps use
// wall-clock times on calendar days, as a parent reads them, so a session on a daylight saving
// night still counts as its printed hours.
(function (root) {
  const dateKey = (date) => {
    const local = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
  };
  const parseDate = (key) => {
    const [year, month, day] = String(key).split("-").map(Number);
    return new Date(year, month - 1, day);
  };
  const addDays = (key, days) => {
    const date = parseDate(key);
    return dateKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() + days));
  };

  const DAY = 24 * 60;
  // "15:00", "3:00pm", or "3:00 PM" to minutes after midnight, or null.
  const clockMinutes = (value) => {
    const match = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(String(value == null ? "" : value).trim());
    if (!match) return null;
    let hours = Number(match[1]);
    const minutes = Number(match[2]);
    const period = (match[3] || "").toLowerCase();
    if ((period ? hours < 1 || hours > 12 : hours > 23) || minutes > 59) return null;
    if (period === "pm" && hours !== 12) hours += 12;
    if (period === "am" && hours === 12) hours = 0;
    return hours * 60 + minutes;
  };
  // True when the session ends the next day.
  const endsNextDay = (start, end) => {
    const from = clockMinutes(start), to = clockMinutes(end);
    return from !== null && to !== null && to < from;
  };
  // Length in minutes (1 to 1439), or 0 when a time is missing or both are equal (not a session).
  const sessionLength = (start, end) => {
    const from = clockMinutes(start), to = clockMinutes(end);
    if (from === null || to === null || from === to) return 0;
    return to > from ? to - from : to + DAY - from;
  };
  // "6 hours", "1 hour 30 min", "45 min".
  const formatLength = (minutes) => {
    const hours = Math.floor(minutes / 60), rest = minutes % 60;
    const hourText = hours ? `${hours} hour${hours === 1 ? "" : "s"}` : "";
    return [hourText, rest ? `${rest} min` : ""].filter(Boolean).join(" ") || "0 min";
  };
  // A calendar day as a whole number (UTC arithmetic, so daylight saving never shifts it).
  const dayNumber = (key) => {
    const [year, month, day] = String(key).split("-").map(Number);
    return Math.round(Date.UTC(year, month - 1, day) / 86400000);
  };
  // { from, to } in wall-clock minutes on one timeline, or null for a session without valid times.
  // session: { date: "YYYY-MM-DD", start, end }, times in any format clockMinutes reads.
  const sessionSpan = (session) => {
    const length = sessionLength(session && session.start, session && session.end);
    if (!length || !/^\d{4}-\d{2}-\d{2}$/.test(String(session.date || ""))) return null;
    const from = dayNumber(session.date) * DAY + clockMinutes(session.start);
    return { from, to: from + length };
  };
  // Two sessions overlap when one starts before the other ends, across midnight too: Friday's
  // 7:00 PM to 1:00 AM overlaps Saturday's 12:30 AM. Touching ends (1:00 AM and 1:00 AM) do not.
  const sessionsOverlap = (a, b) => {
    const x = sessionSpan(a), y = sessionSpan(b);
    return Boolean(x && y && x.from < y.to && y.from < x.to);
  };
  // True while the session is under way at `now` (a local Date): from its start until its end, so
  // an overnight session is still current after midnight.
  const isUnderWay = (session, now) => {
    const span = sessionSpan(session);
    if (!span) return false;
    const current = dayNumber(dateKey(now)) * DAY + now.getHours() * 60 + now.getMinutes();
    return span.from <= current && current < span.to;
  };

  const api = { dateKey, parseDate, addDays, clockMinutes, endsNextDay, sessionLength, formatLength, sessionSpan, sessionsOverlap, isUnderWay };

  if (root) root.CareNestDates = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : null);
