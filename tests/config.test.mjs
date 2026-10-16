// Unit tests for js/config.js: the localhost-only ?supabasePort override that points the site at a
// worktree's own local stack (issue #16). No database needed: `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync(new URL("../js/config.js", import.meta.url), "utf8");

function load(hostname, search, store) {
  const localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const window = { location: { hostname, search } };
  vm.runInNewContext(src, { window, localStorage, URLSearchParams });
  return window.CareNestConfig.supabaseUrl;
}

test("localhost uses 55321 until a port is given, then remembers it", () => {
  const store = new Map();
  assert.equal(load("localhost", "", store), "http://127.0.0.1:55321");
  assert.equal(load("localhost", "?supabasePort=57521", store), "http://127.0.0.1:57521");
  assert.equal(load("127.0.0.1", "", store), "http://127.0.0.1:57521");
  assert.equal(load("localhost", "?supabasePort=", store), "http://127.0.0.1:55321");
  assert.equal(store.size, 0);
});

test("invalid ports are ignored", () => {
  const store = new Map();
  for (const bad of ["80", "70000", "evil.com", "5532a", "@evil.com"]) {
    assert.equal(load("localhost", `?supabasePort=${bad}`, store), "http://127.0.0.1:55321");
  }
});

test("hosted pages ignore the override", () => {
  const store = new Map([["carenest.localSupabasePort", "57521"]]);
  assert.equal(
    load("carenest.vercel.app", "?supabasePort=57521", store),
    "https://ibwshlbhszznfhmeckda.supabase.co",
  );
});
