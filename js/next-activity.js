// CareNestNext: picks the sitter Home's "What's next" activity (SI-70) from the day's tasks.
//
// Task times are display strings ("3:00pm", "3:00 PM", "15:00", "Any time"). The next activity is
// the earliest timed task that is not checked off and whose time is now or later (to the minute),
// so a 3:00pm task is next until 3:01pm. Tasks without a readable time are left out: they have no
// scheduled time to be "next" by. Ties keep the schedule's order.
(function (root) {
  // Minutes after local midnight for a display time, or null when it isn't a time.
  function minutesOf(value) {
    const match = String(value || "")
      .trim()
      .toLowerCase()
      .match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/);
    if (!match) return null;
    let hour = Number(match[1]);
    const minute = match[2] ? Number(match[2]) : 0;
    const period = match[3] ? match[3].charAt(0) : null;
    if (minute > 59) return null;
    if (period) {
      if (hour < 1 || hour > 12) return null;
      if (hour === 12) hour = 0;
      if (period === "p") hour += 12;
    } else if (hour > 23 || !match[2]) {
      // A bare number ("3") is too ambiguous to schedule by.
      return null;
    }
    return hour * 60 + minute;
  }

  // items: [{ time, completed }]; now: a Date. Returns the item, or null when none is left.
  function nextActivity(items, now) {
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    let best = null;
    let bestMinutes = Infinity;
    (items || []).forEach((item) => {
      if (!item || item.completed) return;
      const minutes = minutesOf(item.time);
      if (minutes === null || minutes < nowMinutes) return;
      if (minutes < bestMinutes) {
        best = item;
        bestMinutes = minutes;
      }
    });
    return best;
  }

  const api = { minutesOf, nextActivity };
  if (root) root.CareNestNext = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : null);
