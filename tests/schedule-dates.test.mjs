// Unit tests for js/schedule-dates.js: the schedule's next and previous day arrows step calendar
// days, so they keep working across daylight saving changes. No database needed: `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Set here rather than in the npm script so the test means the same thing on any machine or CI.
process.env.TZ = "America/New_York";

const require = createRequire(import.meta.url);
const { addDays, clockMinutes, endsNextDay, sessionLength, formatLength, sessionSpan, sessionsOverlap, isUnderWay, continuingSessions, isLongSession } = require("../js/schedule-dates.js");

test("the test runs where Nov 1 2026 is a 25-hour day", () => {
  const hours = (new Date(2026, 10, 2) - new Date(2026, 10, 1)) / 3600000;
  assert.equal(hours, 25);
});

test("addDays moves one calendar day across the fall-back day", () => {
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-11-01", 1), "2026-11-02");
  assert.equal(addDays("2026-11-02", -1), "2026-11-01");
  assert.equal(addDays("2026-11-01", -1), "2026-10-31");
});

test("addDays moves one calendar day across the spring-forward day", () => {
  assert.equal(addDays("2026-03-08", 1), "2026-03-09");
  assert.equal(addDays("2026-03-09", -1), "2026-03-08");
});

test("addDays rolls over months and years", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2027-01-01", -1), "2026-12-31");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2026-11-01", 5), "2026-11-06");
});

// Overnight sessions (SI-80): an end before the start ends the next day; equal is not a session.
test("clockMinutes reads 24-hour and 12-hour times and rejects the rest", () => {
  assert.equal(clockMinutes("19:00"), 1140);
  assert.equal(clockMinutes("7:00pm"), 1140);
  assert.equal(clockMinutes("7:00 PM"), 1140);
  assert.equal(clockMinutes("12:00 AM"), 0);
  assert.equal(clockMinutes("12:30pm"), 750);
  assert.equal(clockMinutes("00:05"), 5);
  for (const bad of ["", null, undefined, "24:00", "13:00 PM", "0:30 AM", "7:60", "soon"]) assert.equal(clockMinutes(bad), null, String(bad));
});

test("sessionLength counts across midnight", () => {
  assert.equal(sessionLength("19:00", "01:00"), 360, "7 PM to 1 AM is 6 hours");
  assert.equal(sessionLength("7:00pm", "1:00am"), 360);
  assert.equal(sessionLength("15:00", "19:00"), 240, "same day unchanged");
  assert.equal(sessionLength("23:55", "00:00"), 5);
  assert.equal(sessionLength("00:05", "00:00"), 1435, "just under a day");
  assert.equal(sessionLength("19:00", "19:00"), 0, "equal times are not a session");
  assert.equal(sessionLength("", "19:00"), 0);
  assert.equal(endsNextDay("19:00", "01:00"), true);
  assert.equal(endsNextDay("15:00", "19:00"), false);
  assert.equal(endsNextDay("19:00", "19:00"), false);
  assert.equal(endsNextDay("", "01:00"), false);
});

test("formatLength", () => {
  assert.equal(formatLength(360), "6 hours");
  assert.equal(formatLength(60), "1 hour");
  assert.equal(formatLength(90), "1 hour 30 min");
  assert.equal(formatLength(45), "45 min");
});

test("sessionSpan puts an overnight session's end on the next day, across the fall-back night too", () => {
  const span = sessionSpan({ date: "2026-10-31", start: "19:00", end: "01:00" });
  assert.equal(span.to - span.from, 360, "wall-clock hours on the 25-hour night");
  const next = sessionSpan({ date: "2026-11-01", start: "00:00", end: "01:00" });
  assert.equal(next.from, span.from + 300, "midnight of the next day");
  assert.equal(sessionSpan({ date: "2026-11-01", start: "19:00", end: "19:00" }), null);
  assert.equal(sessionSpan({ date: "nope", start: "19:00", end: "20:00" }), null);
});

test("sessionsOverlap: across midnight, same day, and touching ends", () => {
  const night = { date: "2026-11-13", start: "19:00", end: "01:00" };
  assert.equal(sessionsOverlap(night, { date: "2026-11-14", start: "00:30", end: "02:00" }), true, "early next morning");
  assert.equal(sessionsOverlap(night, { date: "2026-11-14", start: "01:00", end: "03:00" }), false, "starts as it ends");
  assert.equal(sessionsOverlap(night, { date: "2026-11-13", start: "15:00", end: "19:00" }), false, "ends as it starts");
  assert.equal(sessionsOverlap(night, { date: "2026-11-13", start: "18:00", end: "20:00" }), true, "same evening");
  assert.equal(sessionsOverlap(night, { date: "2026-11-13", start: "08:00", end: "09:00" }), false, "that morning");
  assert.equal(sessionsOverlap(night, { date: "2026-11-12", start: "23:00", end: "20:00" }), true, "the previous day's 21-hour session");
  assert.equal(sessionsOverlap({ date: "2026-11-13", start: "3:00 PM", end: "7:00 PM" }, { date: "2026-11-13", start: "18:00", end: "22:00" }), true, "mixed formats");
  assert.equal(sessionsOverlap(night, { date: "2026-11-14", start: "19:00", end: "01:00" }), false, "the next night");
});

test("isUnderWay keeps an overnight session current after midnight until it ends", () => {
  const night = { date: "2026-11-13", start: "19:00", end: "01:00" };
  assert.equal(isUnderWay(night, new Date(2026, 10, 13, 18, 59)), false, "before it starts");
  assert.equal(isUnderWay(night, new Date(2026, 10, 13, 22, 0)), true, "that evening");
  assert.equal(isUnderWay(night, new Date(2026, 10, 14, 0, 30)), true, "after midnight");
  assert.equal(isUnderWay(night, new Date(2026, 10, 14, 1, 0)), false, "at its end");
  assert.equal(isUnderWay({ date: "2026-11-13", start: "15:00", end: "19:00" }, new Date(2026, 10, 13, 16, 0)), true);
});

test("continuingSessions: yesterday's overnight session until it ends, and nothing else", () => {
  const night = { id: "night", date: "2026-11-13", start_time: "7:00pm", end_time: "1:00am" };
  const evening = { id: "evening", date: "2026-11-13", start_time: "3:00pm", end_time: "7:00pm" };
  const tonight = { id: "tonight", date: "2026-11-14", start_time: "7:00pm", end_time: "1:00am" };
  const items = [night, evening, tonight];
  const times = (item) => ({ date: item.date, start: item.start_time, end: item.end_time });
  assert.deepEqual(continuingSessions(items, new Date(2026, 10, 14, 0, 30), times), [night], "12:30 AM: returned as given");
  assert.deepEqual(continuingSessions(items, new Date(2026, 10, 14, 1, 0), times), [], "over at 1:00 AM");
  assert.deepEqual(continuingSessions(items, new Date(2026, 10, 13, 22, 0), times), [], "the same evening is today's session, not a continuation");
  assert.equal(continuingSessions([{ date: "2026-11-13", start: "19:00", end: "01:00" }], new Date(2026, 10, 14, 0, 59)).length, 1, "default reads date/start/end");
  assert.deepEqual(continuingSessions(null, new Date()), []);
});

test("continuingSessions across the fall-back night", () => {
  // Oct 31 7:00 PM to Nov 1 1:00 AM: at 12:30 AM on the 25-hour day it is still under way.
  const night = { date: "2026-10-31", start: "19:00", end: "01:00" };
  assert.equal(continuingSessions([night], new Date(2026, 10, 1, 0, 30)).length, 1);
});

test("isLongSession: longer than 12 hours, overnight or not", () => {
  assert.equal(isLongSession("09:00", "05:00"), true, "9:00 AM to 5:00 AM is 20 hours");
  assert.equal(isLongSession("07:00", "20:00"), true, "13 hours the same day");
  assert.equal(isLongSession("09:00", "21:00"), false, "exactly 12 hours");
  assert.equal(isLongSession("19:00", "01:00"), false, "a 6-hour overnight");
  assert.equal(isLongSession("19:00", "19:00"), false, "not a session");
  assert.equal(isLongSession("9:00 AM", "5:00 AM"), true, "display format");
});
