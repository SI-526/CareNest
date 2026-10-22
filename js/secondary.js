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
    render();
  });

  function link(href, label) { return `<a class="secondary-link" href="${href}">${label}<span aria-hidden="true">→</span></a>`; }
  function taskRows() {
    return data.schedule.map((item) => `<li class="secondary-row"><span class="secondary-time">${item.time}</span><span><strong>${item.title}</strong><small>${item.detail || item.location || "Details available in the session"}</small></span></li>`).join("");
  }
  function render() {
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
        title: "Your CareNest settings",
        intro: "Manage your details and the family space with confidence.",
        body: `<section class="secondary-grid"><article class="panel secondary-panel"><h2 class="section-title">My profile</h2><p class="supporting-copy">Review the information connected to your account.</p></article><article class="panel secondary-panel"><h2 class="section-title">Manage household</h2><p class="supporting-copy">Update care information, schedules, and the people in your space.</p>${link("manage.html", "Open family information")}</article><article class="panel secondary-panel"><h2 class="section-title">Notification preferences</h2><p class="supporting-copy">Choose how and when CareNest keeps you informed.</p></article><article class="panel secondary-panel"><h2 class="section-title">Account settings</h2><p class="supporting-copy">Sign-in and account controls are available from the Account menu.</p></article></section>`,
      },
    }[page];
    if (!view) return;
    document.title = `CareNest — ${view.title}`;
    root.innerHTML = `<header class="secondary-header"><p class="page-eyebrow">${view.eyebrow}</p><h1>${view.title}</h1><p>${view.intro}</p></header>${view.body}`;
  }
})();
