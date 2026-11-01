// CareNestDates — calendar-day helpers for the schedule page (js/secondary.js).
//
// Days are stepped on the calendar, never by adding 24 hours: a US fall-back day lasts 25 hours,
// so midnight + 24h is 23:00 of the same date.
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

  const api = { dateKey, parseDate, addDays };

  if (root) root.CareNestDates = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : null);
