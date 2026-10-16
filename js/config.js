// Public configuration. Every value here is public by design (it ships to every browser):
// the Supabase URL, the *publishable* key (Row Level Security does the protecting), and the
// Google OAuth web client ID. Never put a secret or service_role key in this file.
//
// Local dev (http://localhost:8000 or 127.0.0.1) talks to the local Supabase stack from
// `cd tests && npm run db:start` (a worktree stack: see localApiPort below); every other host
// uses the hosted project.
(function () {
  const GOOGLE_CLIENT_ID =
    "881084208833-qt2sn29afa5sbfsid0tr7epubugtv5m4.apps.googleusercontent.com";

  const isLocalHost = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);

  const config = isLocalHost
    ? {
        supabaseUrl: `http://127.0.0.1:${localApiPort()}`,
        // The Supabase CLI's built-in local default publishable key: identical on every
        // machine, only accepted by a local stack. Not a secret.
        supabasePublishableKey: "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH",
      }
    : {
        supabaseUrl: "https://ibwshlbhszznfhmeckda.supabase.co",
        supabasePublishableKey: "sb_publishable_vDO8Y6dhDFQ_PwJtCaK-9w_Ew5JkU0R",
      };

  config.googleClientId = GOOGLE_CLIENT_ID;
  // The password sign-in form is for smoke-testing against the local stack only. It is shown
  // only when the Supabase URL itself is local (same rule as Carekeeper's lib/dev.ts), and the
  // hosted project has its Email provider turned off, so it could not work there anyway.
  config.devSignInEnabled = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(config.supabaseUrl);

  window.CareNestConfig = Object.freeze(config);

  // Local only: a git worktree runs its own stack on shifted ports (`npm run db:env` in tests/
  // prints them). Open the site once with ?supabasePort=<API port> and this origin remembers it;
  // ?supabasePort= (empty) goes back to 55321. Only reached when isLocalHost, and it can only
  // pick a port on 127.0.0.1, so the hosted config cannot be redirected.
  function localApiPort() {
    const key = "carenest.localSupabasePort";
    // Only a stack API port: 55321 plus a whole slot (tests/stack.sh), slots 0-40.
    const valid = (p) => /^\d{5}$/.test(p) && +p >= 55321 && +p <= 59321 && (p - 55321) % 100 === 0;
    try {
      const param = new URLSearchParams(window.location.search).get("supabasePort");
      if (param === "") localStorage.removeItem(key);
      else if (valid(param)) localStorage.setItem(key, param);
      const saved = localStorage.getItem(key);
      if (valid(saved)) return saved;
    } catch {
      // Storage blocked: fall through to the default port.
    }
    return "55321";
  }
})();
