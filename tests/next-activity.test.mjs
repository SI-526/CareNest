// Unit tests for js/next-activity.js: the sitter Home's "What's next" (SI-70) shows the earliest
// remaining timed activity and moves on once its time has passed. No database: `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { minutesOf, nextActivity } = require("../js/next-activity.js");

const at = (hour, minute) => new Date(2026, 10, 8, hour, minute);
const day = [
  { id: "snack", time: "1:30pm" },
  { id: "playground", time: "3:00 PM" },
  { id: "free", time: "Any time" },
  { id: "dinner", time: "5:00pm" },
  { id: "wind-down", time: "7:00pm" },
];

test("minutesOf reads the app's time formats", () => {
  assert.equal(minutesOf("1:30pm"), 13 * 60 + 30);
  assert.equal(minutesOf("3:00 PM"), 15 * 60);
  assert.equal(minutesOf("12:00 AM"), 0);
  assert.equal(minutesOf("12:15pm"), 12 * 60 + 15);
  assert.equal(minutesOf("7 pm"), 19 * 60);
  assert.equal(minutesOf("15:45"), 15 * 60 + 45);
});

test("minutesOf rejects things that are not times", () => {
  for (const value of ["Any time", "", null, undefined, "13:00pm", "3", "9:75am"]) {
    assert.equal(minutesOf(value), null, String(value));
  }
});

test("the earliest activity still ahead is next", () => {
  assert.equal(nextActivity(day, at(9, 0)).id, "snack");
  assert.equal(nextActivity(day, at(14, 0)).id, "playground");
});

test("an activity stays next through its minute, then the following one is shown", () => {
  assert.equal(nextActivity(day, at(15, 0)).id, "playground");
  assert.equal(nextActivity(day, at(15, 1)).id, "dinner");
});

test("checked-off activities are skipped", () => {
  const done = day.map((item) => Object.assign({}, item, { completed: item.id === "snack" }));
  assert.equal(nextActivity(done, at(9, 0)).id, "playground");
});

test("nothing is next after the last activity, or with no timed activities", () => {
  assert.equal(nextActivity(day, at(19, 1)), null);
  assert.equal(nextActivity([{ id: "x", time: "Any time" }], at(9, 0)), null);
  assert.equal(nextActivity([], at(9, 0)), null);
});

test("order in the list does not matter, ties keep the list's order", () => {
  const shuffled = [{ id: "late", time: "6:00pm" }, { id: "a", time: "4:00pm" }, { id: "b", time: "4:00 PM" }];
  assert.equal(nextActivity(shuffled, at(12, 0)).id, "a");
});
