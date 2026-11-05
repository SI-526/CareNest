// CareNestFamilies: which family space a signed-in person is looking at (SI-45).
//
// An account is a parent in at most one family and can be a sitter in any number of others, but
// the app shows one family at a time. The auth guard (js/auth.js) reads every membership row the
// caller can see, then this file picks the active family:
//
//   1. this tab's choice (sessionStorage), so a tab never changes family under someone mid-task
//      because they switched in another tab,
//   2. the family last chosen on this device (localStorage), for a new tab. Only an explicit
//      choice writes it (switching, accepting an invite, creating a family), not every page
//      load, so a new tab never follows whichever other tab happened to load last,
//   3. otherwise the family where the account is a parent, else the one it joined first.
//
// A remembered id that is no longer one of the caller's families (removed, or the family was
// deleted) is skipped. The ids stored are household ids the caller was a member of; they grant
// nothing, since Row Level Security checks every query against the database's own membership rows.
(function (root) {
  const KEY_PREFIX = "carenest:family:";

  const keyFor = (userId) => `${KEY_PREFIX}${userId}`;

  // memberships: the caller's own household_members rows, oldest first. remembered: household
  // ids in priority order (tab first, then device). Returns one of memberships, or null.
  function pickFamily(memberships, remembered) {
    if (!memberships || !memberships.length) return null;
    for (const id of remembered || []) {
      const hit = id ? memberships.find((m) => m.household_id === id) : null;
      if (hit) return hit;
    }
    return memberships.find((m) => m.role === "parent") || memberships[0];
  }

  // rows: every household_members row RLS returns (all members of all the caller's families).
  // Returns the caller's own rows, the active one, and the roster of the active family only.
  function splitRoster(rows, userId, remembered) {
    const all = rows || [];
    const memberships = all.filter((r) => r.user_id === userId);
    const membership = pickFamily(memberships, remembered);
    const members = membership ? all.filter((r) => r.household_id === membership.household_id) : [];
    return { memberships, membership, members };
  }

  function read(storage, userId) {
    try {
      return storage ? storage.getItem(keyFor(userId)) : null;
    } catch (e) {
      return null; // storage unavailable: fall back to the default family
    }
  }

  function write(storage, userId, householdId) {
    try {
      if (storage) storage.setItem(keyFor(userId), householdId);
    } catch (e) {
      /* storage unavailable: this page still shows the chosen family */
    }
  }

  function storages() {
    const out = { tab: null, device: null };
    try {
      out.tab = root.sessionStorage;
    } catch (e) {
      /* unavailable */
    }
    try {
      out.device = root.localStorage;
    } catch (e) {
      /* unavailable */
    }
    return out;
  }

  // Browser helpers. Each is a no-op where storage is unavailable.
  function remembered(userId) {
    const { tab, device } = storages();
    return [read(tab, userId), read(device, userId)];
  }

  // An explicit choice: this tab and new tabs on this device.
  function remember(userId, householdId) {
    const { tab, device } = storages();
    write(tab, userId, householdId);
    write(device, userId, householdId);
  }

  // The family a page load showed: pins this tab only.
  function pinTab(userId, householdId) {
    write(storages().tab, userId, householdId);
  }

  // A parent anywhere owns a family's photos, whichever family is showing (js/auth.js runs
  // remove_all_photos before delete_my_account when this is true).
  function isParentAnywhere(memberships) {
    return (memberships || []).some((m) => m.role === "parent");
  }

  // What deleting the account does, across every family it is in, not just the one showing.
  function deleteConsequence(memberships) {
    const list = memberships || [];
    const sitterCount = list.filter((m) => m.role === "caretaker").length;
    const parts = [];
    if (isParentAnywhere(list)) {
      parts.push(
        "If you are the only parent, every photo of your family space is deleted from storage, then the family space and everything in it (care info, schedule, shifts, task checks, notes, messages, and invites) is permanently deleted, and your sitters lose access."
      );
    }
    if (sitterCount) {
      const where = sitterCount > 1 ? "every family space where you are a sitter" : "the family space where you are a sitter";
      parts.push(
        `You leave ${where}. Task checks, notes, photos, and messages you sent stay in the family's history without your name.`
      );
    }
    if (!parts.length) parts.push("Your account is permanently deleted.");
    return parts.join(" ");
  }

  // Removes every account's remembered family from this browser (sign-out, account deletion).
  function forgetAll() {
    const { tab, device } = storages();
    [tab, device].forEach((storage) => {
      try {
        Object.keys(storage)
          .filter((key) => key.startsWith(KEY_PREFIX))
          .forEach((key) => storage.removeItem(key));
      } catch (e) {
        /* storage unavailable: nothing to clear */
      }
    });
  }

  const api = {
    KEY_PREFIX,
    pickFamily,
    splitRoster,
    remembered,
    remember,
    pinTab,
    forgetAll,
    isParentAnywhere,
    deleteConsequence,
  };

  if (root) root.CareNestFamilies = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : null);
