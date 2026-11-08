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

// ---------------------------------------------------------------- Care Log page (SI-63/64/65)

test("validateEntry needs a child of the family (skipped with one child) and a note", () => {
  const two = ["jack", "kylie"];
  assert.deepEqual(careLog.validateEntry({ childId: "kylie", note: "  Fort  " }, two), {
    entry: { childId: "kylie", note: "Fort", category: "note" },
  });
  assert.equal(careLog.validateEntry({ note: "x" }, two).field, "child");
  assert.equal(careLog.validateEntry({ childId: "sofia", note: "x" }, two).field, "child");
  assert.equal(careLog.validateEntry({ childId: "jack", note: " \n " }, two).error, careLog.MESSAGES.entryNote);
  assert.equal(careLog.validateEntry({ childId: "jack", note: "x".repeat(1001) }, two).error, careLog.MESSAGES.noteTooLong);
  // One child: the picker is skipped, so no child id is needed.
  assert.equal(careLog.validateEntry({ note: "Nap" }, ["jack"]).entry.childId, "jack");
  assert.equal(careLog.validateEntry({ note: "Nap" }, []).error, careLog.MESSAGES.entryNoChildren);
});

test("sessionEntries lists entries and task details oldest first, each with its child or task and time", () => {
  const state = {
    checks: { snack: { checkedAt: 50, snapshot: { title: "Snack" } } },
    logs: [
      { id: "b", taskId: null, childId: "kylie", category: "note", note: "Fort", createdAt: 300, authorName: "Bethany" },
      { id: "a", taskId: "snack", category: "meal", mealAmount: "most", note: "", createdAt: 100 },
      { id: "c", taskId: null, childId: "gone", childName: "Baby Thomas", category: "note", note: "Bottle", createdAt: 200 },
    ],
  };
  const children = [{ id: "jack", name: "Jack Thomas" }, { id: "kylie", name: "Kylie Thomas" }];
  const entries = careLog.sessionEntries(state, children, []);
  assert.deepEqual(entries.map((e) => e.id), ["a", "c", "b"]);
  assert.equal(entries[0].kind, "task");
  assert.equal(entries[0].taskTitle, "Snack");
  assert.deepEqual(entries[0].facts, ["Ate most"]);
  assert.equal(entries[1].childName, "Baby Thomas", "a removed child keeps the stored name");
  assert.equal(entries[2].childFirst, "Kylie");
  const html = careLog.sessionLogHtml(entries);
  assert.match(html, /Kylie/);
  assert.match(html, /<time class="session-log-time" datetime="1970-01-01T00:00:00.300Z">/);
  // The task timeline (Home, parent page) leaves task-less entries out.
  assert.deepEqual(careLog.timeline(state, []).flatMap((r) => r.logs.map((l) => l.id)), ["a"]);
});

test("sessionEntries tells a child with a blank name apart from a removed child", () => {
  const state = {
    logs: [
      { id: "blank", taskId: null, childId: "first", childName: "", category: "note", note: "Nap", createdAt: 1 },
      { id: "gone", taskId: null, childId: null, childName: "", category: "note", note: "Snack", createdAt: 2 },
      { id: "kept", taskId: null, childId: null, childName: "Baby Thomas", category: "note", note: "Bath", createdAt: 3 },
      { id: "renamed", taskId: null, childId: "kid", childName: "Old name", category: "note", note: "Park", createdAt: 4 },
    ],
  };
  const children = [{ id: "first", name: "  " }, { id: "kid", name: "Jack Thomas" }];
  const entries = careLog.sessionEntries(state, children, []);
  assert.deepEqual(entries.map((e) => e.childLabel), ["Child", "A removed child", "Baby", "Jack"]);
  assert.deepEqual(entries.map((e) => e.childRemoved), [false, true, true, false]);
  const html = careLog.sessionLogHtml(entries);
  assert.match(html, /aria-label="Entry about your child"/);
  assert.match(html, /aria-label="Entry about a removed child"/);
  assert.equal((html.match(/A removed child/g) || []).length, 1, "only the entry whose child is gone");
});

test("sessionLogHtml escapes user text", () => {
  const html = careLog.sessionLogHtml(
    careLog.sessionEntries(
      { logs: [{ id: "x", taskId: null, childId: "k", category: "note", note: "<script>x</script>", authorName: "<b>A</b>", createdAt: 1 }] },
      [{ id: "k", name: "<img src=x onerror=1>" }],
      [],
    ),
  );
  assert.doesNotMatch(html, /<script>|<img|<b>/);
});
