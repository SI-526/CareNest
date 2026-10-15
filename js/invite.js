// invite.html#<token>: the token lives in the URL fragment, so it is never sent to a server or
// in a Referer header. Signed out -> sign in with the invited Google account -> accept.
//
// On load the token is read once into this closure and the address bar is rewritten to plain
// "invite.html" (no fragment) before anything renders or Google's script loads, so the token
// isn't left on screen, in screenshots, or in this tab's history. A copy is kept in this tab's
// sessionStorage only so a reload (e.g. after allowing Google's script) still works; it is
// removed once the invite is accepted.
(function () {
  const TOKEN_KEY = "carenest:invite-token";
  const token = (function readToken() {
    let value = window.location.hash.replace(/^#/, "").trim().toLowerCase();
    try {
      if (value) sessionStorage.setItem(TOKEN_KEY, value);
      else value = sessionStorage.getItem(TOKEN_KEY) || "";
    } catch (e) {
      /* storage unavailable: the closure copy still works until reload */
    }
    if (window.location.hash || window.location.search) {
      window.history.replaceState(null, "", "invite.html");
    }
    return value;
  })();
  const tokenLooksValid = /^[0-9a-f]{64}$/.test(token);

  const auth = window.CareNestAuth;
  // Accepting an invite is real-account work, so it ends this tab's ?demo=1 mode.
  auth.clearDemo();
  const card = document.getElementById("invite-card");
  const esc = auth.escapeHtml;
  document.getElementById("risk-notice").innerHTML = auth.riskNoticeHtml();

  function showProblem(message, extraHtml = "") {
    card.innerHTML = `
      <h2 class="panel-title">This invite can't be used</h2>
      <p class="form-error" role="alert">${esc(message)}</p>
      ${extraHtml}`;
  }

  function renderSignIn() {
    card.innerHTML = `
      <p class="auth-step">Step 1 of 2</p>
      <h2 class="panel-title">Sign in with the invited Google account</h2>
      <p class="signin-note">Use the Google account for the email address the family invited. Other accounts can't accept this invite.</p>
      <div id="invite-signin"></div>`;
    window.CareNestSignIn.mount(card.querySelector("#invite-signin"), { onSignedIn: render });
  }

  function renderAccept(ctx) {
    card.innerHTML = `
      <p class="auth-step">Step 2 of 2</p>
      <h2 class="panel-title">Accept this invite</h2>
      <p>Signed in as <strong>${esc(ctx.email)}</strong>.</p>
      <div class="auth-actions">
        <button type="button" class="primary-btn" data-accept>Accept and join</button>
        <button type="button" class="photo-source-btn" data-switch>Use a different account</button>
      </div>
      <p class="form-error" role="alert" hidden data-error></p>`;
    const errorEl = card.querySelector("[data-error]");
    const accept = card.querySelector("[data-accept]");
    accept.addEventListener("click", async () => {
      accept.disabled = true;
      accept.textContent = "Joining…";
      errorEl.hidden = true;
      const { error } = await auth.client.rpc("accept_invite", { invite_token: token });
      if (error) {
        errorEl.textContent = auth.friendlyError(error);
        errorEl.hidden = false;
        accept.disabled = false;
        accept.textContent = "Accept and join";
        if (/already_member/.test(error.message || "")) {
          errorEl.insertAdjacentHTML(
            "beforeend",
            ` <a href="${esc(auth.homeFor(ctx))}">Go to your family space</a>`
          );
        }
        return;
      }
      try {
        sessionStorage.removeItem(TOKEN_KEY);
      } catch (e) {
        /* storage unavailable */
      }
      auth.go("index.html");
    });
    card.querySelector("[data-switch]").addEventListener("click", async () => {
      const { error } = await auth.endSession();
      if (error) return showProblem(auth.friendlyError(error));
      render();
    });
  }

  async function render() {
    if (!tokenLooksValid) {
      showProblem(
        "We couldn't find this invite. Check that you opened the whole link.",
        '<p class="signin-note">Already joined? <a href="signin.html">Sign in</a>.</p>'
      );
      return;
    }
    let ctx;
    try {
      ctx = await auth.loadContext();
    } catch (e) {
      showProblem("We couldn't reach CareNest. Check your connection and reload the page.");
      return;
    }
    if (!ctx) renderSignIn();
    else renderAccept(ctx);
  }

  render();
})();
