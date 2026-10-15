// Unit tests for js/care-log.js: the child-age parser that decides which care-log categories the
// sitter is offered (SI-37), and the client-side validation that mirrors the database's CHECK
// constraints (SI-28 "No information provided"). No database needed: `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const careLog = require("../js/care-log.js");

test("parseAgeMonths reads common age labels", () => {
  const cases = [
    ["Age 3", 36],
    ["3", 36],
    ["8 months", 8],
    ["18 mo", 18],
    ["18mo", 18],
    ["1 year", 12],
    ["1 year 6 months", 18],
    ["2.5 yrs", 30],
    ["2 years old", 24],
    ["3 y/o", 36],
    ["newborn", 0],
    ["Newborn baby", 0],
    ["6 weeks", 1.4],
    ["  11 Months ", 11],
  ];
  for (const [label, months] of cases) {
    assert.equal(careLog.parseAgeMonths(label), months, label);
  }
});

test("parseAgeMonths returns null for empty or unreadable labels", () => {
  for (const label of ["", "   ", null, undefined, "toddler", "abc", "age unknown", "??"]) {
    assert.equal(careLog.parseAgeMonths(label), null, String(label));
  }
});

test("categoriesFor puts Bottle first for babies and hides it from age 2", () => {
  assert.deepEqual(careLog.categoriesFor("8 months"), ["bottle", "meal", "care"]);
  assert.deepEqual(careLog.categoriesFor("newborn"), ["bottle", "meal", "care"]);
  assert.deepEqual(careLog.categoriesFor("23 months"), ["bottle", "meal", "care"]);
  assert.deepEqual(careLog.categoriesFor("24 months"), ["meal", "care"]);
  assert.deepEqual(careLog.categoriesFor("Age 3"), ["meal", "care"]);
  assert.deepEqual(careLog.categoriesFor("2.5 yrs"), ["meal", "care"]);
  // Unknown age: offer everything.
  assert.deepEqual(careLog.categoriesFor(""), ["meal", "bottle", "care"]);
  assert.deepEqual(careLog.categoriesFor("toddler"), ["meal", "bottle", "care"]);
});

test("validate refuses empty entries with the product copy", () => {
  const empty = careLog.MESSAGES.empty;
  assert.equal(empty, "No information provided");
  assert.equal(careLog.validate({ category: "meal", note: "  " }).error, empty);
  assert.equal(careLog.validate({ category: "care", note: "" }).error, empty);
  assert.equal(careLog.validate({ category: "bottle", bottleOz: "" }).error, empty);
  assert.equal(careLog.validate({ category: "nope", note: "x" }).error, empty);
});

test("validate checks bottle ounces and keeps only the category's fields", () => {
  const range = careLog.MESSAGES.bottleRange;
  assert.equal(careLog.validate({ category: "bottle", bottleOz: "0.2" }).error, range);
  assert.equal(careLog.validate({ category: "bottle", bottleOz: "17" }).error, range);
  assert.equal(careLog.validate({ category: "bottle", bottleOz: "abc" }).error, range);
  assert.equal(careLog.validate({ category: "bottle", bottleOz: "", note: "fussy" }).error, range);
  assert.deepEqual(careLog.validate({ category: "bottle", bottleOz: "4.5", mealAmount: "all" }).entry, {
    category: "bottle",
    note: "",
    mealAmount: null,
    bottleOz: 4.5,
  });
  assert.deepEqual(careLog.validate({ category: "meal", mealAmount: "most", bottleOz: 3 }).entry, {
    category: "meal",
    note: "",
    mealAmount: "most",
    bottleOz: null,
  });
  assert.deepEqual(careLog.validate({ category: "care", note: " Nap 1-2pm ", mealAmount: "all" }).entry, {
    category: "care",
    note: "Nap 1-2pm",
    mealAmount: null,
    bottleOz: null,
  });
  assert.equal(careLog.validate({ category: "care", note: "x".repeat(1001) }).error, careLog.MESSAGES.noteTooLong);
});

test("timeline orders completed tasks by check time and nests logs oldest first", () => {
  const state = {
    checks: {
      b: { checkedAt: 200, checkedByName: "Ana", snapshot: { title: "Lunch" } },
      a: { checkedAt: 100, checkedByName: "Ana", snapshot: { title: "Bottle" } },
    },
    logs: [
      { id: "2", taskId: "a", createdAt: 150, category: "bottle", bottleOz: 4 },
      { id: "1", taskId: "a", createdAt: 120, category: "bottle", bottleOz: 3 },
      { id: "3", taskId: "gone", createdAt: 300, category: "care", note: "x" },
    ],
  };
  const rows = careLog.timeline(state, [{ id: "gone", title: "Bath" }]);
  assert.deepEqual(rows.map((r) => r.taskId), ["a", "b", "gone"]);
  assert.deepEqual(rows[0].logs.map((l) => l.id), ["1", "2"]);
  assert.equal(rows[1].logs.length, 0);
  assert.equal(rows[2].title, "Bath");
  assert.equal(rows[2].check, null);
});

test("timelineHtml escapes user text and shows the neutral states", () => {
  assert.match(careLog.timelineHtml({ checks: {}, logs: [] }), /No tasks completed yet\./);
  const html = careLog.timelineHtml({
    checks: { a: { checkedAt: 100, checkedByName: "<b>Ana</b>", snapshot: { title: "<img src=x onerror=1>" } } },
    logs: [{ id: "1", taskId: "a", createdAt: 120, category: "care", note: "<script>x</script>", authorName: "Ana" }],
  });
  assert.doesNotMatch(html, /<script>|<img|<b>/);
  assert.match(html, /&lt;script&gt;/);
  // A completed task with no logs shows only its line: no placeholder, no entry list.
  const quiet = careLog.timelineHtml({
    checks: { a: { checkedAt: 100, checkedByName: "Ana", snapshot: { title: "Snack" } } },
    logs: [],
  });
  assert.doesNotMatch(quiet, /care-log-entries|No information/);
});
