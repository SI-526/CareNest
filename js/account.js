// account.html (parents only): the parent's own name and phone number, and whether their sitters
// see that phone on the Children page. The email is the sign-in address, shown read-only. The
// database enforces who may read and write (public.parent_profiles, owner only).
(function () {
  const auth = window.CareNestAuth;

  auth.whenReady(async (ctx) => {
    if (!ctx) return;
    if (window.CareNestUI) window.CareNestUI.renderParentNav("profile");
    if (!ctx.demo) auth.mountChrome(ctx);

    const loading = document.getElementById("account-loading");
    const card = document.getElementById("account-card");
    const form = document.getElementById("account-form");
    const save = document.getElementById("account-save");
    const status = document.getElementById("account-status");
    const errorEl = document.getElementById("account-error");

    function showError(text) {
      errorEl.textContent = text;
      errorEl.hidden = !text;
    }

    const { profile, error: loadError } = await auth.loadParentProfile(ctx);
    form.name.value = profile.name || "";
    // Demo: the sample parent's address (js/data.js).
    form.email.value = ctx.demo ? (window.CareNestData && window.CareNestData.parentEmail) || "" : ctx.email || "";
    form.phone.value = profile.phone || "";
    form.share_phone.checked = profile.sharePhone !== false;
    loading.hidden = true;
    card.hidden = false;

    // A failed load could hide saved details; saving the blank form would overwrite them.
    if (loadError) {
      save.disabled = true;
      showError(`Your saved details could not be loaded (${auth.friendlyError(loadError)}), so saving is turned off to keep them safe. Reload the page to try again.`);
      return;
    }

    form.addEventListener("input", () => {
      status.textContent = "";
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      showError("");
      status.textContent = "";
      const name = form.name.value.trim();
      if (!name) {
        showError("Please enter your name.");
        form.name.focus();
        return;
      }
      save.disabled = true;
      const { error } = await auth.saveParentProfile(ctx, {
        name,
        phone: form.phone.value,
        sharePhone: form.share_phone.checked,
      });
      save.disabled = false;
      if (error) {
        showError(error.message && !error.code ? error.message : auth.friendlyError(error));
        return;
      }
      form.name.value = name;
      form.phone.value = form.phone.value.trim();
      status.textContent = ctx.demo ? "Saved in this tab (demo)." : "Saved.";
    });
  });
})();
