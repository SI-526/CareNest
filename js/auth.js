// Shared sign-in state, the auth guard, role routing, the account menu, and the data notice.
//
// Every app page loads, in order: the pinned supabase-js UMD build, js/config.js,
// js/supabase.js, then this file, then its own scripts. Pages start hidden (class
// "auth-pending" on <html>); this file checks the session and the family space, redirects when
// the page is wrong for this person, fills in names, and only then reveals the page and resolves
// CareNestAuth.ready, which the page scripts wait on before rendering.
//
// The guard is a convenience, not the security boundary: Row Level Security in the database
// decides what each signed-in person can read and change.
(function () {
  const client = window.CareNestSupabase;
  const page = document.body.dataset.page;

  // Which roles may open which app page. Pages not listed here are not guarded.
  const PAGE_ROLES = {
    home: ["caretaker"],
    parent: ["parent"],
    people: ["parent"],
    manage: ["parent"],
    messages: ["parent", "caretaker"],
    info: ["parent", "caretaker"],
    food: ["parent", "caretaker"],
  };
  const HOME = { parent: "parent.html", caretaker: "index.html" };

  const ERRORS = {
    not_authenticated: "Please sign in again.",
    risk_not_acknowledged:
      "Please read the notice and tick the box before creating your family space.",
    already_member:
      "This account already belongs to a family space. CareNest supports one family space per account for now.",
    not_parent: "Only a parent can do that.",
    invalid_email: "Please enter a valid email address.",
    invite_not_found: "We couldn't find this invite. Check that you opened the whole link.",
    invite_revoked: "This invite was cancelled. Ask the family to send you a new link.",
    invite_used: "This invite has already been used.",
    invite_expired: "This invite has expired. Ask the family to send you a new link.",
    invite_wrong_email:
      "This invite was sent to a different email address. Use a different account, then sign in with the Google account for the invited address.",
  };

  // Turns a Supabase/Postgres error into a sentence a parent or sitter can act on.
  function friendlyError(error) {
    const message = (error && error.message) || "";
    const code = Object.keys(ERRORS).find((key) => message.includes(key));
    if (code) return ERRORS[code];
    if (message.includes("check constraint")) return "One of the fields is too long or empty.";
    if (/fetch|network/i.test(message)) {
      return "We couldn't reach CareNest. Check your connection and try again.";
    }
    return "Something went wrong. Please try again.";
  }

  // ---------- device data (js/store.js) ----------
  //
  // Photos, messages, check-offs and moments still live in this browser's localStorage until T3
  // moves them to the database. Each person gets their own key so demo mode, every account, and
  // signed-out visitors never see each other's data:
  //   carenest:demo:v1          ?demo=1 (starts empty; the sample family comes from js/data.js)
  //   carenest:v1:<user id>     a signed-in account
  // Nothing is readable until the guard picks a key (signed-out visitors get none). Signing out,
  // or the guard finding no family space, removes that account's key. Only one account can be
  // signed in per browser, so with no session at all every carenest:v1:* key is an orphan and
  // is removed (signed out elsewhere, or supabase-js dropped the session after a failed refresh).
  const DEMO_STORE_KEY = "carenest:demo:v1";
  const DEMO_FLAG = "carenest:demo";
  const USER_STORE_PREFIX = "carenest:v1:";
  let storeKey = null;
  // Set while this tab signs out or deletes the account itself, so the auth listener below
  // leaves the redirect to that flow.
  let endingSession = false;

  function userStoreKey(userId) {
    return `${USER_STORE_PREFIX}${userId}`;
  }

  // No session in this browser: every account's device data left behind is an orphan.
  function clearOrphanedUserData() {
    try {
      Object.keys(localStorage)
        .filter((key) => key.startsWith(USER_STORE_PREFIX))
        .forEach((key) => localStorage.removeItem(key));
    } catch (e) {
      /* storage unavailable: nothing to clear */
    }
  }

  function clearUserData(userId) {
    if (!userId) return;
    try {
      localStorage.removeItem(userStoreKey(userId));
    } catch (e) {
      /* storage unavailable: nothing to clear */
    }
  }

  // The pre-accounts key "carenest:v1" was shared by everyone on this device and can't be
  // attributed to one account, so it is discarded rather than migrated.
  try {
    localStorage.removeItem("carenest:v1");
  } catch (e) {
    /* storage unavailable */
  }

  // ?demo=1 (remembered for this tab) shows the sample family, as before accounts existed. It
  // reads only the bundled sample data in js/data.js and its own localStorage key; signed-out
  // requests can read nothing from the database (RLS).
  function demoMode() {
    try {
      if (new URLSearchParams(window.location.search).has("demo")) {
        sessionStorage.setItem(DEMO_FLAG, "1");
      }
      return sessionStorage.getItem(DEMO_FLAG) === "1";
    } catch (e) {
      return false;
    }
  }

  // Ends this tab's demo mode (sign-in, invite, onboarding, and "Exit demo" call this) and
  // removes the demo's device data so it doesn't carry over to the next demo visitor.
  function clearDemo() {
    try {
      sessionStorage.removeItem(DEMO_FLAG);
    } catch (e) {
      /* storage unavailable */
    }
    try {
      localStorage.removeItem(DEMO_STORE_KEY);
    } catch (e) {
      /* storage unavailable */
    }
  }

  function go(path) {
    window.location.replace(path);
    // Keep the page hidden and the guard pending while the browser navigates away.
    return new Promise(() => {});
  }

  function reveal() {
    document.documentElement.classList.remove("auth-pending");
  }

  function firstName(member) {
    if (!member) return "";
    const name = (member.display_name || "").trim();
    if (name) return name.split(/\s+/)[0];
    return (member.email || "").split("@")[0];
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Loads who is signed in and their family space. Returns null when signed out.
  // getUser() asks the auth server (so a deleted or revoked account counts as signed out);
  // the roster query runs alongside it so the check costs one round trip, not two.
  async function loadContext() {
    if (!client) throw new Error("sign-in unavailable");
    const { data: sessionData } = await client.auth.getSession();
    if (!sessionData.session) {
      clearOrphanedUserData();
      return null;
    }

    const [userResult, rosterResult] = await Promise.all([
      client.auth.getUser(),
      // RLS returns only the caller's own family space (one per account).
      client
        .from("household_members")
        .select("household_id, user_id, role, email, display_name, households(id, name, child_name, child_age_label)")
        .order("created_at", { ascending: true }),
    ]);

    if (userResult.error || !userResult.data.user) {
      const status = userResult.error && userResult.error.status;
      if (!userResult.error || status === 401 || status === 403 || status === 404) {
        await client.auth.signOut({ scope: "local" });
        clearOrphanedUserData();
        return null;
      }
      throw userResult.error;
    }
    if (rosterResult.error) throw rosterResult.error;

    const user = userResult.data.user;
    const members = rosterResult.data || [];
    const me = members.find((m) => m.user_id === user.id) || null;
    return {
      client,
      user,
      email: user.email || "",
      membership: me,
      role: me ? me.role : null,
      household: me ? me.households : null,
      members,
    };
  }

  // Where a signed-in person belongs: their role's home, or onboarding with no family space.
  function homeFor(ctx) {
    return ctx.role ? HOME[ctx.role] : "onboarding.html";
  }

  // Replaces the sample names in js/data.js with real ones where that is trivial. Schedule,
  // care info, contacts, and photos stay sample data until T2c/T3 move them to Supabase.
  function fillNames(ctx) {
    const data = window.CareNestData;
    if (!data || !ctx.household) return;
    if (ctx.household.child_name) data.child.name = ctx.household.child_name;
    if (ctx.household.child_age_label) data.child.age = ctx.household.child_age_label;
    const sitter =
      ctx.role === "caretaker" ? ctx.membership : ctx.members.find((m) => m.role === "caretaker");
    if (sitter) data.babysitter.name = firstName(sitter);
    data.viewerFirstName = firstName(ctx.membership);
    const parent = ctx.members.find((m) => m.role === "parent");
    if (parent) data.parentName = (parent.display_name || "").trim() || firstName(parent);
  }

  function showFatal(message) {
    reveal();
    const box = document.createElement("div");
    box.className = "auth-fatal";
    box.setAttribute("role", "alert");
    box.innerHTML = `<p>${escapeHtml(message)}</p>
      <button type="button" class="primary-btn">Try again</button>`;
    box.querySelector("button").addEventListener("click", () => window.location.reload());
    document.body.replaceChildren(box);
  }

  // The auth guard for app pages (index, parent, people, messages, info, food).
  async function guard() {
    if (demoMode()) {
      storeKey = DEMO_STORE_KEY;
      let session = null;
      try {
        if (client) session = (await client.auth.getSession()).data.session;
      } catch (e) {
        /* treat as signed out */
      }
      reveal();
      showDemoBanner(session);
      return { demo: true, role: null };
    }
    let ctx;
    try {
      ctx = await loadContext();
    } catch (e) {
      showFatal("We couldn't reach CareNest. Check your connection and try again.");
      return new Promise(() => {});
    }
    if (!ctx) return go("signin.html");
    if (!ctx.role) {
      clearUserData(ctx.user.id);
      return go("onboarding.html");
    }
    storeKey = userStoreKey(ctx.user.id);
    watchSession(ctx.user.id);

    const allowed = PAGE_ROLES[page] || [];
    if (!allowed.includes(ctx.role)) return go(HOME[ctx.role]);

    // messages.html is shared; ?as=parent selects the parent's side of the thread.
    if (page === "messages") {
      const params = new URLSearchParams(window.location.search);
      const asParent = params.get("as") === "parent";
      if (ctx.role === "parent" && !asParent) return go("messages.html?as=parent");
      if (ctx.role === "caretaker" && asParent) return go("messages.html");
    }

    fillNames(ctx);
    mountChrome(ctx);
    reveal();
    return ctx;
  }

  // storeKey is fixed for the life of the page, so follow sign-in changes (including those from
  // other tabs, which supabase-js relays) and stop writing the moment this account is no longer
  // the one signed in. INITIAL_SESSION and TOKEN_REFRESHED for the same user change nothing.
  function watchSession(loadedUserId) {
    client.auth.onAuthStateChange((event, session) => {
      const userId = session && session.user ? session.user.id : null;
      if (event !== "SIGNED_OUT" && userId === loadedUserId) return;
      storeKey = null; // js/store.js now refuses writes
      if (endingSession) return; // this tab's own sign-out/delete redirects itself
      // Navigate outside the auth callback so supabase-js finishes its own bookkeeping first.
      setTimeout(() => {
        if (event === "SIGNED_OUT" || !userId) window.location.replace("signin.html");
        else window.location.reload();
      }, 0);
    });
  }

  // Signed out: "Demo mode ... Sign in". Signed in: the account stays signed in underneath, so
  // say whose it is and offer "Exit demo" back to the real family space.
  function showDemoBanner(session) {
    const banner = document.createElement("p");
    banner.className = "demo-banner";
    if (session && session.user) {
      const meta = session.user.user_metadata || {};
      const name = (meta.full_name || meta.name || "").trim() || session.user.email || "your account";
      banner.innerHTML = `Demo mode — signed in as ${escapeHtml(name)} · <button type="button" class="text-btn demo-exit">Exit demo</button>`;
      banner.querySelector("button").addEventListener("click", () => {
        clearDemo();
        window.location.replace(window.location.pathname);
      });
    } else {
      banner.innerHTML =
        'Demo mode: sample family, not signed in. <a href="signin.html">Sign in</a>';
    }
    document.body.prepend(banner);
  }

  // ---------- account menu, footer ----------

  const ACCOUNT_ICON =
    '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 4a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Zm0 14a8 8 0 0 1-6.16-2.9C7.1 15.8 9.4 15 12 15s4.9.8 6.16 2.1A8 8 0 0 1 12 20Z" />';

  function mountChrome(ctx) {
    const nav = document.querySelector(".primary-nav");
    if (nav && !nav.querySelector("[data-account-button]")) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "nav-item nav-account";
      button.dataset.accountButton = "";
      button.setAttribute("aria-haspopup", "dialog");
      button.innerHTML = `<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">${ACCOUNT_ICON}</svg><span>Account</span>`;
      nav.appendChild(button);
      button.addEventListener("click", () => openAccountMenu(ctx, button));
    }
    const app = document.querySelector(".app");
    if (app && !document.querySelector(".legal-footer")) {
      app.insertAdjacentHTML("beforeend", legalFooterHtml());
    }
  }

  function legalFooterHtml() {
    return `<footer class="legal-footer">
      <a href="privacy.html">Privacy</a><span aria-hidden="true">·</span><a href="terms.html">Terms</a>
    </footer>`;
  }

  let accountDialog = null;

  function openAccountMenu(ctx, opener) {
    if (!accountDialog) {
      accountDialog = document.createElement("dialog");
      accountDialog.className = "confirm-dialog account-dialog";
      accountDialog.setAttribute("aria-labelledby", "account-title");
      const roleLabel = ctx.role === "parent" ? "Parent" : "Sitter";
      const familyName = ctx.household ? ctx.household.name : "";
      accountDialog.innerHTML = `
        <div class="confirm-dialog-body">
          <h2 class="panel-title" id="account-title">Your account</h2>
          <p class="account-who">Signed in as <strong>${escapeHtml(ctx.email)}</strong></p>
          <p class="account-meta">${escapeHtml(roleLabel)}${familyName ? ` in ${escapeHtml(familyName)}` : ""}</p>
          ${ctx.role === "parent" ? '<a class="photo-source-btn" href="people.html">People and invites</a>' : ""}
          <button type="button" class="photo-source-btn" data-sign-out>Sign out</button>
          <button type="button" class="danger-btn" data-delete-account>Delete my account and data</button>
          <p class="form-error" role="alert" hidden data-account-error></p>
          <p class="account-links"><a href="privacy.html">Privacy</a> · <a href="terms.html">Terms</a></p>
          <form method="dialog"><button class="text-btn" value="close">Close</button></form>
        </div>`;
      document.body.appendChild(accountDialog);
      accountDialog.addEventListener("close", () => opener.focus());
      accountDialog.querySelector("[data-sign-out]").addEventListener("click", async (e) => {
        const button = e.currentTarget;
        const errorEl = accountDialog.querySelector("[data-account-error]");
        button.disabled = true;
        errorEl.hidden = true;
        const { error } = await signOut();
        if (error) {
          errorEl.textContent = friendlyError(error);
          errorEl.hidden = false;
          button.disabled = false;
        }
      });
      accountDialog
        .querySelector("[data-delete-account]")
        .addEventListener("click", () => deleteAccount(ctx));
    }
    accountDialog.showModal();
  }

  // Signs out, then removes this account's device data (photos, messages, check-offs) from this
  // browser. The data is removed only once sign-out succeeded; on error it is kept and the
  // error is returned for the caller to show. Resolves { error }.
  async function endSession() {
    if (!client) return { error: null };
    let userId = null;
    try {
      const { data } = await client.auth.getSession();
      userId = data.session && data.session.user && data.session.user.id;
    } catch (e) {
      /* no session: nothing of ours to clear */
    }
    endingSession = true;
    let error = null;
    try {
      ({ error } = await client.auth.signOut());
    } catch (e) {
      error = e;
    }
    endingSession = false;
    if (error) return { error };
    storeKey = null;
    clearUserData(userId);
    return { error: null };
  }

  // Resolves { error } only on failure; on success the page navigates to sign-in.
  async function signOut() {
    const { error } = await endSession();
    if (error) return { error };
    return go("signin.html");
  }

  async function deleteAccount(ctx) {
    const consequence =
      ctx.role === "parent"
        ? "If you are the only parent, every photo of your family space is deleted from storage, then the family space and everything in it (care info, schedule, shifts, task checks, notes, messages, and invites) is permanently deleted, and your sitters lose access."
        : ctx.role === "caretaker"
          ? "You leave the family space. Task checks, notes, photos, and messages you sent stay in the family's history without your name."
          : "Your account is permanently deleted.";
    const ok = await confirmDialog({
      title: "Delete your account and data?",
      body: `${consequence} Your sign-in account is deleted too. This cannot be undone.`,
      confirmLabel: "Delete everything",
      danger: true,
    });
    if (!ok) return;
    const errorEl = accountDialog && accountDialog.querySelector("[data-account-error]");
    endingSession = true;
    // A sole parent's family space goes with the account, but Storage objects are not removed by
    // database cascades: remove_all_photos() detaches every photo of those households (messages
    // read "Photo removed by ...") and returns every object path, which are deleted through the
    // Storage API before the account. Any failure stops here with the account kept, and a retry
    // repeats both steps. For a caretaker, or a parent with a co-parent, the list is empty.
    let error = null;
    if (ctx.role === "parent") {
      const removed = await client.rpc("remove_all_photos");
      error = removed.error;
      const paths = (!error && removed.data) || [];
      for (let i = 0; !error && i < paths.length; i += 100) {
        ({ error } = await client.storage.from("photos").remove(paths.slice(i, i + 100)));
      }
    }
    if (!error) ({ error } = await client.rpc("delete_my_account"));
    if (error) {
      endingSession = false;
      if (errorEl) {
        errorEl.textContent = friendlyError(error);
        errorEl.hidden = false;
      }
      return;
    }
    storeKey = null;
    // This browser's own copies (every carenest:* key: photos, messages, demo data) go too.
    try {
      Object.keys(localStorage)
        .filter((key) => key.startsWith("carenest:"))
        .forEach((key) => localStorage.removeItem(key));
    } catch (e) {
      /* storage unavailable: nothing to clear */
    }
    // The account no longer exists, so only the local session needs clearing.
    await client.auth.signOut({ scope: "local" });
    window.location.replace("signin.html?deleted=1");
  }

  // A native <dialog> confirmation. Resolves true when confirmed.
  function confirmDialog({ title, body, confirmLabel, danger }) {
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      dialog.className = "confirm-dialog";
      dialog.setAttribute("aria-labelledby", "confirm-title");
      dialog.setAttribute("aria-describedby", "confirm-desc");
      dialog.innerHTML = `
        <form method="dialog" class="confirm-dialog-body">
          <h2 class="panel-title" id="confirm-title">${escapeHtml(title)}</h2>
          <p class="confirm-desc" id="confirm-desc">${escapeHtml(body)}</p>
          <div class="moment-dialog-actions">
            <button class="${danger ? "danger-btn" : "primary-btn"}" value="confirm">${escapeHtml(confirmLabel)}</button>
            <button class="photo-source-btn" value="cancel" autofocus>Cancel</button>
          </div>
        </form>`;
      const returnFocus = document.activeElement;
      dialog.addEventListener("close", () => {
        resolve(dialog.returnValue === "confirm");
        dialog.remove();
        if (returnFocus && returnFocus.focus) returnFocus.focus();
      });
      document.body.appendChild(dialog);
      dialog.showModal();
    });
  }

  // ---------- data notice ----------

  function riskNoticeHtml() {
    return `<section class="card risk-notice" aria-labelledby="risk-notice-title">
      <h2 class="panel-title" id="risk-notice-title">How your information is handled</h2>
      <ul>
        <li>CareNest is a student class project. It is <strong>not HIPAA-compliant</strong> and <strong>not a medical service</strong>.</li>
        <li>Data is stored with Supabase on a free plan with <strong>no backups</strong>. It could be lost.</li>
        <li>It stores what your family enters, including <strong>photos of your child</strong> that sitters take during a shift.</li>
        <li>You enter real information at your own risk.</li>
        <li><strong>Only invite people you trust.</strong> Everyone in your family space can see its care info, schedule, and photos.</li>
        <li>You can delete your account and data at any time from the Account menu.</li>
        <li>The details are in our <a href="privacy.html">privacy policy</a> and <a href="terms.html">terms</a>.</li>
      </ul>
    </section>`;
  }

  // ---------- public API ----------

  const isGuardedPage = Object.prototype.hasOwnProperty.call(PAGE_ROLES, page);
  const ready = isGuardedPage ? guard() : Promise.resolve(null);

  window.CareNestAuth = {
    client,
    ready,
    whenReady(fn) {
      ready.then(fn);
    },
    loadContext,
    homeFor,
    friendlyError,
    confirmDialog,
    riskNoticeHtml,
    legalFooterHtml,
    escapeHtml,
    firstName,
    reveal,
    go,
    signOut,
    endSession,
    clearDemo,
    mountChrome,
    // localStorage key for js/store.js; null until the guard has decided who this is.
    get storeKey() {
      return storeKey;
    },
  };
})();
