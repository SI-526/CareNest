// onboarding.html: a signed-in person with no family space creates one and becomes its parent.
// create_household requires the at-your-own-risk acknowledgement (stored as
// households.risk_acknowledged_at); the child's name and age are then saved on the new row.
(function () {
  const auth = window.CareNestAuth;
  // Creating a family space is real-account work, so it ends this tab's ?demo=1 mode.
  auth.clearDemo();
  const form = document.getElementById("onboarding-form");
  const errorEl = document.getElementById("onboarding-error");
  const submit = document.getElementById("onboarding-submit");
  document.getElementById("risk-notice").innerHTML = auth.riskNoticeHtml();

  function showError(text) {
    errorEl.textContent = text;
    errorEl.hidden = !text;
  }

  (async () => {
    let ctx;
    try {
      ctx = await auth.loadContext();
    } catch (e) {
      auth.reveal();
      showError("We couldn't reach CareNest. Check your connection and reload the page.");
      submit.disabled = true;
      return;
    }
    if (!ctx) return auth.go("signin.html");
    if (ctx.role) return auth.go(auth.homeFor(ctx));
    document.getElementById("onboarding-email").textContent = ctx.email;
    auth.reveal();
  })();

  document.getElementById("onboarding-signout").addEventListener("click", () => auth.signOut());

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    showError("");
    const name = form.household_name.value.trim();
    const childName = form.child_name.value.trim();
    const childAge = form.child_age_label.value.trim();
    if (!name) {
      showError("Please give your family space a name.");
      form.household_name.focus();
      return;
    }
    if (!form.acknowledged.checked) {
      showError("Please read the notice and tick the box before creating your family space.");
      form.acknowledged.focus();
      return;
    }
    submit.disabled = true;
    submit.textContent = "Creating…";
    const { data: householdId, error } = await auth.client.rpc("create_household", {
      household_name: name,
      acknowledged: true,
    });
    if (error) {
      showError(auth.friendlyError(error));
      submit.disabled = false;
      submit.textContent = "Create family space";
      return;
    }
    if (childName || childAge) {
      const { error: childError } = await auth.client
        .from("households")
        .update({ child_name: childName, child_age_label: childAge })
        .eq("id", householdId);
      if (childError) {
        // The family space exists; only the child's details didn't save. Don't strand them here.
        showError(
          "Your family space was created, but the child's name and age didn't save. You can continue."
        );
        submit.textContent = "Continue";
        submit.disabled = false;
        submit.type = "button"; // so Continue doesn't submit (and create) again
        submit.addEventListener("click", () => auth.go("parent.html"), { once: true });
        return;
      }
    }
    auth.go("people.html?welcome=1");
  });
})();
