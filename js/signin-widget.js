// The sign-in widget used by signin.html and invite.html.
//
// Google Identity Services (GIS) renders Google's own button on our origin and returns an ID
// token, which Supabase exchanges for a session (signInWithIdToken). Popup or FedCM only:
// no One Tap, no auto-select, no page redirect.
//
// Nonce (Supabase "Login with Google" guide): each page load makes a random 256-bit raw nonce.
// Google gets its SHA-256 hex (it is copied into the ID token's `nonce` claim); Supabase gets the
// raw value, hashes it, and compares, so an ID token from another page load is rejected.
//
// On the local stack only (CareNestConfig.devSignInEnabled) a password form signs in or signs up
// a throwaway local user, so flows can be tested without Google.
(function () {
  const GIS_SCRIPT_SRC = "https://accounts.google.com/gsi/client";
  // After this long the widget says the button is slow, but keeps waiting for it.
  const GIS_SLOW_MS = 5000;
  const DEV_PASSWORD = "local-dev-only-password";

  async function sha256Hex(input) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function createNonce() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const raw = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return { raw, hashed: await sha256Hex(raw) };
  }

  function signInError(error) {
    const message = ((error && error.message) || "").toLowerCase();
    if (message.includes("nonce")) return "That sign-in expired. Reload the page and try again.";
    if ((error && error.name === "AuthRetryableFetchError") || /fetch|network/.test(message)) {
      return "We couldn't reach the sign-in service. Check your connection and try again.";
    }
    return "Google sign-in didn't finish. Please try again.";
  }

  // Loads Google's script once. A failed load is not cached, so a later mount can retry.
  let gisScript = null;
  function loadGis() {
    if (!gisScript) {
      gisScript = new Promise((resolve, reject) => {
        if (window.google && window.google.accounts && window.google.accounts.id) {
          resolve(window.google.accounts.id);
          return;
        }
        const script = document.createElement("script");
        script.src = GIS_SCRIPT_SRC;
        script.async = true;
        script.onload = () =>
          window.google && window.google.accounts && window.google.accounts.id
            ? resolve(window.google.accounts.id)
            : reject(new Error("gis missing"));
        script.onerror = () => {
          script.remove();
          reject(new Error("gis blocked"));
        };
        document.head.appendChild(script);
      });
      gisScript.catch(() => {
        gisScript = null;
      });
    }
    return gisScript;
  }

  // Renders the widget into `container`; calls onSignedIn() after a session exists.
  function mount(container, { onSignedIn }) {
    const auth = window.CareNestAuth;
    const config = window.CareNestConfig;
    const client = auth.client;

    container.innerHTML = `
      <div class="gis-button" data-gis aria-busy="true"></div>
      <p class="signin-note" data-gis-note role="status"></p>
      <p class="form-error" data-signin-error role="alert" hidden></p>`;
    const buttonEl = container.querySelector("[data-gis]");
    const note = container.querySelector("[data-gis-note]");
    const errorEl = container.querySelector("[data-signin-error]");

    function showError(text) {
      errorEl.textContent = text;
      errorEl.hidden = !text;
    }

    if (!client) {
      showError("Sign-in couldn't load. Check your connection and reload the page.");
      return;
    }

    async function finishGoogle(credential, rawNonce) {
      note.textContent = "Signing you in…";
      showError("");
      const { error } = await client.auth.signInWithIdToken({
        provider: "google",
        token: credential,
        nonce: rawNonce,
      });
      if (error) {
        note.textContent = "";
        showError(signInError(error));
        return;
      }
      onSignedIn();
    }

    function render(id) {
      // GIS buttons take a fixed pixel width between 200 and 400.
      const width = Math.round(Math.min(400, Math.max(200, buttonEl.clientWidth || 280)));
      if (buttonEl.dataset.width === String(width)) return;
      buttonEl.dataset.width = String(width);
      id.renderButton(buttonEl, {
        type: "standard",
        theme: "filled_blue",
        size: "large",
        text: "continue_with",
        shape: "pill",
        logo_alignment: "left",
        width,
      });
    }

    // Slow network: say so at 5s, but keep waiting and render the button whenever it arrives.
    const slowTimer = window.setTimeout(() => {
      if (buttonEl.hasAttribute("aria-busy")) {
        note.textContent =
          "Google's sign-in button is taking a while to load. You can keep waiting; if it doesn't appear, a browser extension may be blocking accounts.google.com.";
      }
    }, GIS_SLOW_MS);

    (async () => {
      try {
        const [id, nonce] = await Promise.all([loadGis(), createNonce()]);
        window.clearTimeout(slowTimer);
        if (buttonEl.hasAttribute("aria-busy")) note.textContent = "";
        id.initialize({
          client_id: config.googleClientId,
          callback: (response) => void finishGoogle(response.credential, nonce.raw),
          nonce: nonce.hashed,
          context: "signin",
          ux_mode: "popup",
          auto_select: false,
          itp_support: true,
          use_fedcm_for_button: true,
        });
        render(id);
        buttonEl.removeAttribute("aria-busy");
        if (window.ResizeObserver) new ResizeObserver(() => render(id)).observe(buttonEl);
      } catch (e) {
        window.clearTimeout(slowTimer);
        buttonEl.removeAttribute("aria-busy");
        buttonEl.hidden = true;
        note.textContent =
          "Google's sign-in button didn't load. A browser extension may be blocking it; allow accounts.google.com and reload the page.";
      }
    })();

    if (config.devSignInEnabled) mountDevSignIn(container, client, onSignedIn);
  }

  function mountDevSignIn(container, client, onSignedIn) {
    const form = document.createElement("form");
    form.className = "card dev-signin";
    form.noValidate = true;
    form.innerHTML = `
      <p class="dev-signin-title"><strong>Local development sign-in</strong></p>
      <p class="signin-note">Only shown with the local Supabase stack. Not available on the live site.</p>
      <label class="field-label" for="dev-email">Test email</label>
      <input class="text-input" id="dev-email" type="email" autocomplete="off" required />
      <button type="submit" class="photo-source-btn">Dev sign in</button>
      <p class="form-error" role="alert" hidden></p>`;
    const errorEl = form.querySelector(".form-error");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = form.querySelector("input").value.trim().toLowerCase();
      if (!email) return;
      errorEl.hidden = true;
      const credentials = { email, password: DEV_PASSWORD };
      const signIn = await client.auth.signInWithPassword(credentials);
      if (signIn.error) {
        const signUp = await client.auth.signUp(credentials);
        if (signUp.error || !signUp.data.session) {
          errorEl.textContent = (signUp.error && signUp.error.message) || "Dev sign-in failed.";
          errorEl.hidden = false;
          return;
        }
      }
      onSignedIn();
    });
    container.appendChild(form);
  }

  window.CareNestSignIn = { mount, createNonce, sha256Hex };
})();
