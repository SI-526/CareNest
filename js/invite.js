// invite.html#<token>: the token lives in the URL fragment, so it is never sent to a server or
// in a Referer header. Signed out -> sign in with the invited Google account -> accept.
(function () {
  const auth = window.CareNestAuth;
  const card = document.getElementById("invite-card");
  const esc = auth.escapeHtml;
  document.getElementById("risk-notice").innerHTML = auth.riskNoticeHtml();

  const token = window.location.hash.replace(/^#/, "").trim().toLowerCase();
  const tokenLooksValid = /^[0-9a-f]{64}$/.test(token);

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
      // replace(): the invite URL (with its token) leaves this tab's history.
      auth.go("index.html");
    });
    card.querySelector("[data-switch]").addEventListener("click", async () => {
      await auth.client.auth.signOut();
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
