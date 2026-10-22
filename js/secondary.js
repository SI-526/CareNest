// Focused secondary views linked from the CareNest dashboard.
(function () {
  const data = window.CareNestData;
  const page = document.body.dataset.page;
  const ui = window.CareNestUI;
  const root = document.getElementById("secondary-content");
  if (!data || !ui || !root) return;

  const ready = (window.CareNestFamily || window.CareNestAuth).ready;
  ready.then((ctx) => {
    if (ctx.role === "parent") ui.renderParentNav(page === "carelog" ? "care-log" : page);
    else ui.renderSitterNav(page === "carelog" ? "care-log" : page);
    render(ctx);
  });

  function link(href, label) { return `<a class="secondary-link" href="${href}">${label}<span aria-hidden="true">→</span></a>`; }
  function taskRows() {
    return data.schedule.map((item) => `<li class="secondary-row"><span class="secondary-time">${item.time}</span><span><strong>${item.title}</strong><small>${item.detail || item.location || "Details available in the session"}</small></span></li>`).join("");
  }
  function escapeHtml(value) {
    return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function sitterProfile(ctx) {
    const key = `carenest:sitter-profile:${ctx.user ? ctx.user.id : "demo"}`;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(key) || "{}"); } catch (e) { /* start with defaults */ }
    const defaults = {
      name: data.babysitter && data.babysitter.name || "",
      bio: "Friendly, dependable care for busy families.",
      phone: "",
      availability: "Weekday afternoons and weekends",
      showBio: true,
      showPhone: false,
      showAvailability: true,
      updates: true,
    };
    const profile = { ...defaults, ...saved };
    return `<section class="profile-settings-layout"><article class="panel secondary-panel public-profile-card"><p class="page-eyebrow">VISIBLE TO PARENTS</p><h2 class="section-title">Your public profile</h2><p class="supporting-copy">Parents only see the fields you choose to share below.</p><form class="profile-settings-form" id="profile-settings-form"><label class="field-label" for="profile-name">Display name</label><input class="text-input" id="profile-name" name="name" maxlength="80" value="${escapeHtml(profile.name)}"><label class="field-label" for="profile-bio">About you</label><textarea class="text-input profile-textarea" id="profile-bio" name="bio" maxlength="500" rows="4">${escapeHtml(profile.bio)}</textarea><label class="field-label" for="profile-phone">Phone number</label><input class="text-input" id="profile-phone" name="phone" type="tel" maxlength="40" value="${escapeHtml(profile.phone)}"><label class="field-label" for="profile-availability">Availability</label><input class="text-input" id="profile-availability" name="availability" maxlength="160" value="${escapeHtml(profile.availability)}"><fieldset class="profile-visibility"><legend class="field-label">What parents can see</legend><label><input type="checkbox" name="showBio"${profile.showBio ? " checked" : ""}> About you</label><label><input type="checkbox" name="showPhone"${profile.showPhone ? " checked" : ""}> Phone number</label><label><input type="checkbox" name="showAvailability"${profile.showAvailability ? " checked" : ""}> Availability</label></fieldset><fieldset class="profile-visibility"><legend class="field-label">Your preferences</legend><label><input type="checkbox" name="updates"${profile.updates ? " checked" : ""}> Receive session update reminders</label></fieldset><div class="profile-save-row"><button class="primary-btn" type="submit">Save profile</button><p class="profile-save-status" id="profile-save-status" role="status" aria-live="polite"></p></div></form></article><aside class="panel secondary-panel profile-preview"><p class="page-eyebrow">PARENT PREVIEW</p><h2 class="section-title" id="profile-preview-name">${escapeHtml(profile.name) || "Your name"}</h2><p class="supporting-copy" id="profile-preview-bio"${profile.showBio ? "" : " hidden"}>${escapeHtml(profile.bio)}</p><p class="supporting-copy" id="profile-preview-phone"${profile.showPhone ? "" : " hidden"}>${escapeHtml(profile.phone)}</p><p class="supporting-copy" id="profile-preview-availability"${profile.showAvailability ? "" : " hidden"}>${escapeHtml(profile.availability)}</p><p class="profile-private-note">Private fields stay visible only to you.</p></aside></section>`;
  }

  function bindSitterProfile(ctx) {
    const form = document.getElementById("profile-settings-form");
    if (!form) return;
    const key = `carenest:sitter-profile:${ctx.user ? ctx.user.id : "demo"}`;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form).entries());
      ["showBio", "showPhone", "showAvailability", "updates"].forEach((name) => { values[name] = form.elements[name].checked; });
      try { localStorage.setItem(key, JSON.stringify(values)); } catch (e) { /* the page still reflects this visit */ }
      document.getElementById("profile-preview-name").textContent = values.name || "Your name";
      [["bio", "showBio"], ["phone", "showPhone"], ["availability", "showAvailability"]].forEach(([field, visible]) => {
        const el = document.getElementById(`profile-preview-${field}`);
        el.textContent = values[field] || "";
        el.hidden = !values[visible] || !values[field];
      });
      document.getElementById("profile-save-status").textContent = "Profile saved.";
    });
  }

  function render(ctx) {
    const child = data.child || {};
    const view = {
      schedule: {
        eyebrow: "CURRENT SESSION",
        title: "Today’s schedule",
        intro: "A clear plan for the day, with everything in time order.",
        body: `<section class="panel secondary-panel"><h2 class="section-title">Current session schedule</h2><ul class="secondary-list">${taskRows()}</ul></section><section class="secondary-grid"><article class="panel secondary-panel"><h2 class="section-title">Calendar view</h2><p class="supporting-copy">See upcoming care dates and planned sessions at a glance.</p></article><article class="panel secondary-panel"><h2 class="section-title">Checklist</h2><p class="supporting-copy">Complete the session’s essential to-dos as you go.</p>${link("index.html", "Open today’s checklist")}</article><article class="panel secondary-panel"><h2 class="section-title">Session notes</h2><p class="supporting-copy">Review the parent’s notes without leaving the current session.</p>${link("index.html", "Open important today")}</article></section>`,
      },
      carelog: {
        eyebrow: "CURRENT SESSION",
        title: "Care log",
        intro: "Keep notes, task updates, and handoff details together.",
        body: `<section class="secondary-grid"><article class="panel secondary-panel"><h2 class="section-title">Current session log</h2><p class="supporting-copy">Notes and photos from today’s care session, collected in one place.</p>${link("index.html", "Open current session log")}</article><article class="panel secondary-panel"><h2 class="section-title">Photo updates</h2><p class="supporting-copy">Photos and moments shared with the care team.</p>${link("gallery.html", "Open photo updates")}</article><article class="panel secondary-panel"><h2 class="section-title">End-session handoff summary</h2><p class="supporting-copy">A clear record of what happened before care changes hands.</p></article><article class="panel secondary-panel"><h2 class="section-title">Past sessions</h2><p class="supporting-copy">Review prior care sessions and their shared updates.</p></article></section>`,
      },
      children: {
        eyebrow: "CHILD PROFILE",
        title: child.name || "Child profile",
        intro: "Permanent care information that supports every session.",
        body: `<section class="panel secondary-panel child-profile-card"><h2 class="section-title">Child profile</h2><p class="supporting-copy">${child.name || "This child"}’s permanent profile is separate from session-specific updates.</p></section><section class="secondary-grid"><article class="panel secondary-panel"><h2 class="section-title">Critical information</h2><p class="supporting-copy">Food, allergy, emergency, and contact details.</p>${link("food-allergies.html", "View food & allergies")}</article><article class="panel secondary-panel"><h2 class="section-title">Routine</h2><p class="supporting-copy">Preferences, comfort items, and familiar routines.</p>${link("info.html?category=preferences", "View routine details")}</article><article class="panel secondary-panel"><h2 class="section-title">Care team</h2><p class="supporting-copy">The people and contacts supporting this child.</p>${link("index.html#contacts", "View care contacts")}</article></section>`,
      },
      profile: {
        eyebrow: "PROFILE & SETTINGS",
        title: ctx.role === "parent" ? "Your CareNest settings" : "Your sitter profile",
        intro: ctx.role === "parent" ? "Manage your details and the family space with confidence." : "Choose what parents can see, and keep your personal preferences in one place.",
        body: ctx.role === "parent" ? `<section class="secondary-grid"><article class="panel secondary-panel"><h2 class="section-title">My profile</h2><p class="supporting-copy">Review the information connected to your account.</p></article><article class="panel secondary-panel"><h2 class="section-title">Manage household</h2><p class="supporting-copy">Update care information, schedules, and the people in your space.</p>${link("manage.html", "Open family information")}</article><article class="panel secondary-panel"><h2 class="section-title">Notification preferences</h2><p class="supporting-copy">Choose how and when CareNest keeps you informed.</p></article><article class="panel secondary-panel"><h2 class="section-title">Account settings</h2><p class="supporting-copy">Sign-in and account controls are available from the Account menu.</p></article></section>` : sitterProfile(ctx),
      },
    }[page];
    if (!view) return;
    document.title = `CareNest — ${view.title}`;
    root.innerHTML = `<header class="secondary-header"><p class="page-eyebrow">${view.eyebrow}</p><h1>${view.title}</h1><p>${view.intro}</p></header>${view.body}`;
    if (page === "profile" && ctx.role !== "parent") bindSitterProfile(ctx);
  }
})();
