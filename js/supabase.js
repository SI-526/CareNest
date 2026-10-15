// Creates the one Supabase client every page shares (window.CareNestSupabase).
// Loaded after the pinned supabase-js UMD build (window.supabase) and js/config.js.
(function () {
  const config = window.CareNestConfig;
  if (!window.supabase || !config) {
    window.CareNestSupabase = null;
    return;
  }
  window.CareNestSupabase = window.supabase.createClient(
    config.supabaseUrl,
    config.supabasePublishableKey,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Sign-in is Google ID token (or local dev password), never a redirect back with
        // tokens in the URL, so never read a session out of the address bar.
        detectSessionInUrl: false,
      },
    }
  );
})();
