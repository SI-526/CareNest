// signin.html: signed in already -> straight to your home (or onboarding); otherwise sign in.
(function () {
  const auth = window.CareNestAuth;
  // Choosing to sign in ends this tab's ?demo=1 mode, so app pages use the real account again.
  auth.clearDemo();
  document.getElementById("risk-notice").innerHTML = auth.riskNoticeHtml();

  async function routeSignedIn() {
    try {
      const ctx = await auth.loadContext();
      if (ctx) return auth.go(auth.homeFor(ctx));
    } catch (e) {
      showStatus("We couldn't reach CareNest. Check your connection and try again.");
    }
    auth.reveal();
  }

  function showStatus(text) {
    const el = document.getElementById("signin-status");
    el.textContent = text;
    el.hidden = !text;
  }

  if (new URLSearchParams(window.location.search).has("deleted")) {
    showStatus("Your account and data were deleted.");
  }

  window.CareNestSignIn.mount(document.getElementById("signin-widget"), {
    onSignedIn: routeSignedIn,
  });
  routeSignedIn();
})();
