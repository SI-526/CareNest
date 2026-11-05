// Unit tests for js/active-family.js: which family space the app shows for an account in several
// (SI-45 slice B). No database needed: `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// A fake browser: the module reads window.sessionStorage (this tab) and window.localStorage (this
// device) at call time.
class FakeStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}
const tab = new FakeStorage();
const device = new FakeStorage();
// Object.keys(storage) lists stored keys in a browser; mirror that for forgetAll().
const asBrowserStorage = (store) =>
  new Proxy(store, {
    ownKeys: (t) => [...t.map.keys()],
    getOwnPropertyDescriptor: (t, k) => (t.map.has(k) ? { enumerable: true, configurable: true, value: t.map.get(k) } : undefined),
  });
globalThis.window = { sessionStorage: asBrowserStorage(tab), localStorage: asBrowserStorage(device) };

const require = createRequire(import.meta.url);
const {
  pickFamily,
  splitRoster,
  remembered,
  remember,
  pinTab,
  forgetAll,
  isParentAnywhere,
  deleteConsequence,
} = require("../js/active-family.js");

const ME = "user-me";
const row = (household_id, user_id, role, name = household_id) => ({
  household_id,
  user_id,
  role,
  email: `${user_id}@example.test`,
  display_name: user_id,
  households: { id: household_id, name },
});

// A sitter in two families (joined h-one first), each with its own parent and another sitter.
const sitterRoster = [
  row("h-one", "p1", "parent"),
  row("h-one", ME, "caretaker"),
  row("h-one", "other-sitter", "caretaker"),
  row("h-two", "p2", "parent"),
  row("h-two", ME, "caretaker"),
];

// A parent of h-own who is also a sitter in h-sit (and joined h-sit's roster earlier).
const parentAndSitterRoster = [
  row("h-sit", "p3", "parent"),
  row("h-sit", ME, "caretaker"),
  row("h-own", ME, "parent"),
  row("h-own", "my-sitter", "caretaker"),
];

test("no memberships: no family", () => {
  assert.equal(pickFamily([], ["h-one"]), null);
  const split = splitRoster([], ME, []);
  assert.deepEqual(split, { memberships: [], membership: null, members: [] });
});

test("one family: it is always the one shown", () => {
  const only = [row("h-one", ME, "caretaker")];
  assert.equal(pickFamily(only, []).household_id, "h-one");
  assert.equal(pickFamily(only, ["h-gone", null]).household_id, "h-one");
});

test("a sitter in two families: the first joined, unless one is remembered", () => {
  assert.equal(splitRoster(sitterRoster, ME, [null, null]).membership.household_id, "h-one");
  assert.equal(splitRoster(sitterRoster, ME, [null, "h-two"]).membership.household_id, "h-two");
});

test("this tab's choice wins over the device's", () => {
  assert.equal(splitRoster(sitterRoster, ME, ["h-one", "h-two"]).membership.household_id, "h-one");
  assert.equal(splitRoster(sitterRoster, ME, ["h-two", "h-one"]).membership.household_id, "h-two");
});

test("a remembered family the account has left is skipped", () => {
  assert.equal(splitRoster(sitterRoster, ME, ["h-removed", "h-two"]).membership.household_id, "h-two");
  assert.equal(splitRoster(sitterRoster, ME, ["h-removed", "h-gone"]).membership.household_id, "h-one");
});

test("an id from someone else's membership is never picked", () => {
  // p2's row is in the roster, but "h-x" is not one of mine: falls back to my default.
  const roster = sitterRoster.concat([row("h-x", "p2", "caretaker")]);
  assert.equal(splitRoster(roster, ME, ["h-x", null]).membership.household_id, "h-one");
});

test("a parent who sits for another family sees their own family by default", () => {
  const split = splitRoster(parentAndSitterRoster, ME, [null, null]);
  assert.equal(split.membership.household_id, "h-own");
  assert.equal(split.membership.role, "parent");
  const sitting = splitRoster(parentAndSitterRoster, ME, ["h-sit", null]);
  assert.equal(sitting.membership.role, "caretaker", "the role comes from the family shown");
});

test("members holds only the shown family's roster; memberships holds all of mine", () => {
  const split = splitRoster(sitterRoster, ME, ["h-two"]);
  assert.deepEqual(
    split.memberships.map((m) => m.household_id),
    ["h-one", "h-two"],
  );
  assert.deepEqual(
    split.members.map((m) => m.user_id),
    ["p2", ME],
    "no one from h-one leaks into h-two's roster (names, the 'sitter' shown to parents)",
  );
  const one = splitRoster(sitterRoster, ME, ["h-one"]);
  assert.deepEqual(
    one.members.map((m) => m.user_id),
    ["p1", ME, "other-sitter"],
  );
});

test("a page load pins only its tab; an explicit choice also sets the device's default", () => {
  forgetAll();
  pinTab(ME, "h-two");
  assert.deepEqual(remembered(ME), ["h-two", null], "loading a page never moves new tabs");
  remember(ME, "h-one");
  assert.deepEqual(remembered(ME), ["h-one", "h-one"]);
  // Another tab loading h-two later does not change what a new tab opens on.
  pinTab(ME, "h-two");
  assert.deepEqual(remembered(ME), ["h-two", "h-one"]);
  assert.deepEqual(remembered("someone-else"), [null, null], "keys are per account");
});

test("sign-out forgets every account's remembered family in both storages", () => {
  remember(ME, "h-one");
  remember("other-user", "h-x");
  device.setItem("carenest:v1:unrelated", "kept");
  forgetAll();
  assert.deepEqual(remembered(ME), [null, null]);
  assert.deepEqual(remembered("other-user"), [null, null]);
  assert.equal(device.getItem("carenest:v1:unrelated"), "kept", "only family keys are removed");
});

test("account deletion: photos are removed for a parent anywhere, whichever family is showing", () => {
  const parentAndSitter = splitRoster(parentAndSitterRoster, ME, ["h-sit"]);
  assert.equal(parentAndSitter.membership.role, "caretaker", "showing the family they sit for");
  assert.equal(isParentAnywhere(parentAndSitter.memberships), true);
  assert.equal(isParentAnywhere(splitRoster(sitterRoster, ME, []).memberships), false);
  assert.equal(isParentAnywhere([]), false);
});

test("account deletion: the warning covers every family the account is in", () => {
  const both = deleteConsequence(splitRoster(parentAndSitterRoster, ME, ["h-sit"]).memberships);
  assert.match(both, /only parent/);
  assert.match(both, /You leave the family space where you are a sitter/);
  const twoSits = deleteConsequence(splitRoster(sitterRoster, ME, []).memberships);
  assert.doesNotMatch(twoSits, /only parent/);
  assert.match(twoSits, /every family space where you are a sitter/);
  assert.equal(deleteConsequence([]), "Your account is permanently deleted.");
});
