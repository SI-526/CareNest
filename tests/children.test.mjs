// Unit tests for js/children.js: the helpers the Children pages and the data loaders share
// (SI-45 slice C). No database needed: `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const kids = require("../js/children.js");

// 2026-11-06 is a Friday; 14:00 local.
const NOW = new Date(2026, 10, 6, 14, 0);
const sit = (date, start, end) => ({ date, start_time: start, end_time: end });

test("nextSit: today, tomorrow, later, and none", () => {
  assert.deepEqual(kids.nextSit([sit("2026-11-06", "3:00 PM", "7:00 PM")], NOW), { text: "Today 3:00 PM", soon: true });
  assert.deepEqual(kids.nextSit([sit("2026-11-07", "3:00pm", "7:00pm")], NOW), { text: "Tomorrow 3:00 PM", soon: true });
  assert.deepEqual(kids.nextSit([sit("2026-11-13", "11:00 AM", "5:00 PM")], NOW), { text: "Friday, Nov 13 at 11:00 AM", soon: false });
  assert.equal(kids.nextSit([], NOW), null);
  assert.equal(kids.nextSit(undefined, NOW), null);
});

test("nextSit: a sit under way still counts, a finished one does not, and the earliest wins", () => {
  assert.equal(kids.nextSit([sit("2026-11-06", "1:00 PM", "3:00 PM")], NOW).text, "Today 1:00 PM", "under way");
  assert.equal(kids.nextSit([sit("2026-11-06", "9:00 AM", "11:00 AM")], NOW), null, "already over");
  assert.equal(kids.nextSit([sit("2026-11-05", "3:00 PM", "7:00 PM")], NOW), null, "yesterday");
  const many = [sit("2026-11-20", "3:00 PM", "4:00 PM"), sit("2026-11-07", "6:00 PM", "9:00 PM"), sit("2026-11-07", "8:00 AM", "9:00 AM")];
  assert.equal(kids.nextSit(many, NOW).text, "Tomorrow 8:00 AM");
  // 12-hour edge cases, and a row with no usable time is skipped.
  assert.equal(kids.nextSit([sit("2026-11-07", "12:00 AM", "1:00 AM")], NOW).text, "Tomorrow 12:00 AM");
  assert.equal(kids.nextSit([sit("2026-11-07", "12:30pm", "")], NOW).text, "Tomorrow 12:30 PM");
  assert.equal(kids.nextSit([sit("2026-11-07", "", "")], NOW), null);
});

test("initials and names", () => {
  assert.equal(kids.initials("Jack Thomas"), "JT");
  assert.equal(kids.initials("  kylie  "), "K");
  assert.equal(kids.initials("Ana María de la Cruz"), "AM");
  assert.equal(kids.initials(""), "?");
  assert.equal(kids.displayName({ name: "  " }), "Child");
  assert.equal(kids.firstName({ name: "Jack Thomas" }), "Jack");
  assert.equal(kids.namesList([{ name: "Jack" }]), "Jack");
  assert.equal(kids.namesList([{ name: "Jack T" }, { name: "Kylie T" }]), "Jack and Kylie");
  assert.equal(kids.namesList([{ name: "A" }, { name: "B" }, { name: "C" }]), "A, B, and C");
  assert.equal(kids.namesList([{ name: "A" }, { name: "B" }], "or"), "A or B");
  assert.equal(kids.emergencyText([{ name: "Jack T" }, { name: "Kylie" }]), "If Jack or Kylie is in danger, not breathing, or having a severe allergic reaction, call 911 first.");
  assert.equal(kids.emergencyText([{ name: "Jack" }, { name: "" }]), "If a child is in danger, not breathing, or having a severe allergic reaction, call 911 first.");
  assert.equal(kids.emergencyText([]), "If a child is in danger, not breathing, or having a severe allergic reaction, call 911 first.");
  assert.deepEqual(kids.detailParts({ age: "Age 3", stage: " " }), ["Age 3"]);
  assert.deepEqual(kids.detailParts({ age: "Age 3", stage: "Preschooler" }), ["Age 3", "Preschooler"]);
});

test("sortChildren: position, then oldest, then id, like the database's first child", () => {
  const sorted = kids.sortChildren([
    { id: "b", position: 0, createdAt: "2026-01-02" },
    { id: "c", position: -1, createdAt: "2026-01-03" },
    { id: "a", position: 0, createdAt: "2026-01-02" },
    { id: "d", position: 0, createdAt: "2026-01-01" },
  ]);
  assert.deepEqual(sorted.map((c) => c.id), ["c", "d", "a", "b"]);
});

const rows = {
  children: [
    { id: "k2", name: "Kylie", age_label: "Age 6", stage_label: "1st Grader", pinned_note: "Cold", position: 1, created_at: "2" },
    { id: "k1", name: "Jack", age_label: "Age 3", stage_label: "", pinned_note: "", position: 0, created_at: "1" },
  ],
  care: [
    { id: "f1", category: "food", title: "Nut-free", detail: "No nuts", severity: "Severe", child_id: "k1" },
    { id: "f2", category: "food", title: "Dairy", detail: "", severity: "Mild", child_id: "k1" },
    { id: "p1", category: "preferences", title: "Reading", detail: "Books", severity: null, child_id: "k2" },
    { id: "w1", category: "where", title: "EpiPen", detail: "Cabinet", severity: null, child_id: null },
    { id: "x1", category: "food", title: "Orphan", detail: "", severity: null, child_id: "gone" },
  ],
};

test("fromRows: each child gets only its own per-child items, in the database's order", () => {
  const children = kids.fromRows(rows.children, rows.care);
  assert.deepEqual(children.map((c) => c.id), ["k1", "k2"]);
  const [jack, kylie] = children;
  assert.deepEqual(jack.food.map((f) => [f.name, f.severity, f.severityClass]), [["Nut-free", "Severe", "badge--severe"], ["Dairy", "Mild", "badge--mild"]]);
  assert.deepEqual(kylie.preferences, [{ id: "p1", title: "Reading", detail: "Books" }]);
  assert.deepEqual([kylie.stage, kylie.pinnedNote], ["1st Grader", "Cold"]);
  assert.equal(children.flatMap((c) => c.food).some((f) => f.id === "x1"), false, "an item whose child is gone is dropped");
  assert.equal(children.some((c) => c.where), false, "where things are stays family-wide");
  assert.deepEqual(kids.severeAllergies(jack), ["Nut-free"]);
  assert.equal(kids.hasAnyInfo(kylie), true);
  assert.equal(kids.hasAnyInfo({ food: [], preferences: [], instructions: [] }), false);
});

function emptyData() {
  return {
    child: { name: "x", dateLabel: "Fri, Nov 6", shiftTime: "3:00pm - 7:00pm" },
    allergies: { items: [], careNote: null },
    categories: { preferences: { items: [] }, instructions: { items: [] } },
  };
}

test("flatten: family-wide lists name the child only when there are several, and data.child is the first", () => {
  const data = emptyData();
  data.children = kids.fromRows(rows.children, rows.care);
  kids.flatten(data);
  assert.deepEqual(data.allergies.items.map((i) => [i.name, i.childName]), [["Nut-free", "Jack"], ["Dairy", "Jack"]]);
  assert.deepEqual(data.categories.preferences.items.map((i) => [i.title, i.childId, i.childName]), [["Reading", "k2", "Kylie"]]);
  assert.deepEqual(data.child, { name: "Jack", age: "Age 3", avatar: null, dateLabel: "Fri, Nov 6", shiftTime: "3:00pm - 7:00pm" });
  assert.equal(data.allergies.careNote, null);

  const one = emptyData();
  one.children = kids.fromRows([rows.children[1]], rows.care);
  kids.flatten(one);
  assert.equal(one.allergies.items[0].childName, "", "one child: no label");
  // A child's own list is not changed by tagging the family-wide copy.
  assert.equal("childName" in one.children[0].food[0], false);
});

test("flatten: care notes and a family with no children", () => {
  const data = emptyData();
  data.children = [
    { id: "a", name: "Jack T", position: 0, careNote: "EpiPen in the cabinet", food: [], preferences: [], instructions: [] },
    { id: "b", name: "Kylie T", position: 1, careNote: "", food: [], preferences: [], instructions: [] },
  ];
  kids.flatten(data);
  assert.equal(data.allergies.careNote, "Jack: EpiPen in the cabinet");

  const none = emptyData();
  none.children = [];
  kids.flatten(none);
  assert.equal(none.child.name, "Child");
  assert.deepEqual(none.allergies.items, []);
  assert.equal(kids.findChild(none, "a"), null);
});

test("nextSit: an overnight sit (end before start) counts until it ends the next day (SI-80)", () => {
  const night = sit("2026-11-06", "7:00 PM", "1:00 AM");
  const saturday = sit("2026-11-07", "3:00 PM", "5:00 PM");
  // 21:00 on Friday: the sit is under way although its end time reads earlier.
  assert.equal(kids.nextSit([night], new Date(2026, 10, 6, 21, 0)).text, "Today 7:00 PM");
  // 00:30 on Saturday: Friday's sit is still under way.
  assert.deepEqual(kids.nextSit([night, saturday], new Date(2026, 10, 7, 0, 30)), { text: "Now until 1:00 AM", soon: true });
  // 01:00 on Saturday: it is over, so the next one shows.
  assert.equal(kids.nextSit([night, saturday], new Date(2026, 10, 7, 1, 0)).text, "Today 3:00 PM");
  // Yesterday's same-day sit never carries over.
  assert.equal(kids.nextSit([sit("2026-11-06", "3:00 PM", "7:00 PM")], new Date(2026, 10, 7, 0, 30)), null);
});
