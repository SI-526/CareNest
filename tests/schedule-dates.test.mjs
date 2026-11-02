// Unit tests for js/schedule-dates.js: the schedule's next and previous day arrows step calendar
// days, so they keep working across daylight saving changes. No database needed: `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Set here rather than in the npm script so the test means the same thing on any machine or CI.
process.env.TZ = "America/New_York";

const require = createRequire(import.meta.url);
const { addDays } = require("../js/schedule-dates.js");

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
