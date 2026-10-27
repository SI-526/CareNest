// people.html (parents only): invite a sitter by email, show the private link once, revoke
// pending invites, remove sitters. The database enforces all of this (parents only, RLS).
(function () {
  const auth = window.CareNestAuth;
  const esc = auth.escapeHtml;

  auth.whenReady((ctx) => {
    if (!ctx || ctx.demo) {
      document.querySelector(".people-main").innerHTML =
        '<p class="signin-note">People and invites need a signed-in parent. <a href="signin.html">Sign in</a></p>';
      return;
    }
    if (window.CareNestUI) window.CareNestUI.renderParentNav("profile");
    auth.mountChrome(ctx);

    const client = ctx.client;
    const householdId = ctx.household.id;
    const form = document.getElementById("invite-form");
    const submit = document.getElementById("invite-submit");
    const inviteError = document.getElementById("invite-error");
    const linkBox = document.getElementById("invite-link");
    const linkInput = document.getElementById("invite-link-input");
    const copyStatus = document.getElementById("invite-copy-status");
    const peopleError = document.getElementById("people-error");

    if (new URLSearchParams(window.location.search).has("welcome")) {
      document.getElementById("people-welcome").hidden = false;
    }

    function show(el, text) {
      el.textContent = text;
      el.hidden = !text;
    }

    function announce(text) {
      const status = document.getElementById("app-status");
      if (status) status.textContent = text;
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      show(inviteError, "");
      const email = form.email.value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        show(inviteError, "Please enter a valid email address.");
        form.email.focus();
        return;
      }
      submit.disabled = true;
      const { data: token, error } = await client.rpc("create_invite", {
        target_household_id: householdId,
        invite_email: email,
      });
      submit.disabled = false;
      if (error) {
        show(inviteError, auth.friendlyError(error));
        return;
      }
      // Fragment, not path or query: browsers never send it to a server or in a Referer.
      const url = new URL("invite.html", window.location.href);
      url.search = "";
      url.hash = token;
      linkInput.value = url.toString();
      document.getElementById("invite-link-email").textContent = email;
      copyStatus.textContent = "";
      linkBox.hidden = false;
      form.reset();
      linkInput.focus();
      linkInput.select();
      loadPeople();
    });

    document.getElementById("invite-copy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(linkInput.value);
        copyStatus.textContent = "Link copied. Send it to your sitter.";
      } catch (e) {
        linkInput.focus();
        linkInput.select();
        copyStatus.textContent = "Couldn't copy automatically. The link is selected: copy it now.";
      }
    });

    async function loadPeople() {
      const [invites, members, profiles] = await Promise.all([
        client
          .from("invites")
          .select("id, email, expires_at, created_at")
          .eq("household_id", householdId)
          .is("accepted_at", null)
          .is("revoked_at", null)
          .gt("expires_at", new Date().toISOString())
          .order("created_at", { ascending: false }),
        client
          .from("household_members")
          .select("user_id, role, email, display_name")
          .eq("household_id", householdId)
          .order("created_at", { ascending: true }),
        // Only the fields each sitter chose to share, filtered by the database.
        client.rpc("household_sitter_profiles", { target_household_id: householdId }),
      ]);
      if (invites.error || members.error) {
        show(peopleError, auth.friendlyError(invites.error || members.error));
        return;
      }
      show(peopleError, "");
      renderInvites(invites.data);
      // A profile that fails to load only hides the extra details; the member list still works.
      const byUser = new Map((profiles.error ? [] : profiles.data || []).map((row) => [row.user_id, row]));
      renderMembers(members.data, byUser);
    }

    function renderInvites(rows) {
      const list = document.getElementById("pending-list");
      document.getElementById("pending-empty").hidden = rows.length > 0;
      list.innerHTML = rows
        .map(
          (row) => `<li class="people-row">
            <div class="people-meta">
              <p class="people-name">${esc(row.email)}</p>
              <p class="people-sub">Expires ${esc(new Date(row.expires_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }))}</p>
            </div>
            <button type="button" class="photo-source-btn people-action" data-revoke="${esc(row.id)}" data-email="${esc(row.email)}">Revoke</button>
          </li>`
        )
        .join("");
    }

    function sitterDetails(profile) {
      if (!profile) return "";
      const href = profile.phone && window.CareNestFamily ? window.CareNestFamily.phoneHref(profile.phone) : "";
      const phone = profile.phone
        ? `<p class="people-sub">${href ? `<a href="${esc(href)}">${esc(profile.phone)}</a>` : esc(profile.phone)}</p>`
        : "";
      return `${profile.bio ? `<p class="people-sub">${esc(profile.bio)}</p>` : ""}${phone}${
        profile.availability ? `<p class="people-sub">Available: ${esc(profile.availability)}</p>` : ""
      }`;
    }

    function renderMembers(rows, profiles) {
      const list = document.getElementById("members-list");
      list.innerHTML = rows
        .map((row) => {
          const isMe = row.user_id === ctx.user.id;
          const label = row.role === "parent" ? "Parent" : "Sitter";
          const profile = row.role === "caretaker" ? profiles.get(row.user_id) : null;
          const shownName = (profile && profile.display_name) || row.display_name;
          const name = shownName || row.email;
          return `<li class="people-row">
            <div class="people-meta">
              <p class="people-name">${esc(name)}${isMe ? " (you)" : ""}</p>
              <p class="people-sub">${esc(label)}${shownName ? ` · ${esc(row.email)}` : ""}</p>
              ${sitterDetails(profile)}
            </div>
            ${
              row.role === "caretaker"
                ? `<button type="button" class="danger-btn people-action" data-remove="${esc(row.user_id)}" data-name="${esc(name)}">Remove</button>`
                : ""
            }
          </li>`;
        })
        .join("");
    }

    document.getElementById("pending-list").addEventListener("click", async (event) => {
      const button = event.target.closest("[data-revoke]");
      if (!button) return;
      const ok = await auth.confirmDialog({
        title: "Revoke this invite?",
        body: `The link sent to ${button.dataset.email} will stop working.`,
        confirmLabel: "Revoke invite",
        danger: true,
      });
      if (!ok) return;
      const { error } = await client
        .from("invites")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", button.dataset.revoke);
      if (error) show(peopleError, auth.friendlyError(error));
      else announce(`Invite for ${button.dataset.email} revoked.`);
      loadPeople();
    });

    document.getElementById("members-list").addEventListener("click", async (event) => {
      const button = event.target.closest("[data-remove]");
      if (!button) return;
      const ok = await auth.confirmDialog({
        title: `Remove ${button.dataset.name}?`,
        body: "They lose access to your family space right away. Task checks and notes they wrote stay in your history.",
        confirmLabel: "Remove sitter",
        danger: true,
      });
      if (!ok) return;
      const { error } = await client
        .from("household_members")
        .delete()
        .eq("household_id", householdId)
        .eq("user_id", button.dataset.remove);
      if (error) show(peopleError, auth.friendlyError(error));
      else announce(`${button.dataset.name} removed.`);
      loadPeople();
    });

    loadPeople();
  });
})();
