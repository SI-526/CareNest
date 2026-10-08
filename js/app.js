(function () {
  const data = window.CareNestData;
  if (!data) return;

  const page = document.body.dataset.page;

  if (page === "home") {
    initHome();
  } else if (page === "food") {
    initFood();
  } else if (page === "info") {
    initInfo();
  }

  function initHome() {
    renderSitterHeader(document.getElementById("sitter-header"));
    renderShift();
    renderSchedule(document.getElementById("schedule-list"));
    renderContacts(document.getElementById("contacts-list"));
    renderKnowTiles(document.getElementById("know-grid"));
    initModal();
  }

  function initFood() {
    const allergies = data.allergies;
    const list = document.getElementById("restriction-list");
    const careNoteEl = document.getElementById("care-note-body");

    list.innerHTML = allergies.items
      .map(
        (item) => `
      <article class="restriction-item">
        <img class="restriction-thumb" src="${item.image}" alt="" width="64" height="64" />
        <div class="restriction-content">
          <div class="restriction-top">
            <h3 class="restriction-name">${escapeHtml(item.name)}</h3>
            <span class="badge ${item.severityClass}">${escapeHtml(item.severity)}</span>
          </div>
          <p class="restriction-desc">${escapeHtml(item.description)}</p>
        </div>
      </article>`
      )
      .join("");

    careNoteEl.textContent = allergies.careNote;
  }

  function initInfo() {
    const params = new URLSearchParams(window.location.search);
    const key = params.get("category") || "";
    const category = data.categories[key];
    const title = category ? category.title : "Care information";
    const titleEl = document.getElementById("info-title");
    if (titleEl) titleEl.textContent = title;
    document.title = `CareNest — ${title}`;
  }

  function renderSitterHeader(el) {
    if (!el) return;
    const sitter = data.babysitter;
    el.innerHTML = `
      <img class="sitter-avatar" src="${sitter.avatar}" alt="${escapeHtml(sitter.name)}" width="39" height="39" />
      <div class="sitter-meta">
        <p class="sitter-welcome">Welcome ${escapeHtml(sitter.name)}</p>
        <p class="sitter-address">${escapeHtml(sitter.address)}</p>
      </div>`;
  }

  function renderShift() {
    const cardEl = document.getElementById("shift-card");
    if (!cardEl) return;

    const child = data.child;
    cardEl.innerHTML = `
      <div class="shift-timing">
        <p class="shift-date">${escapeHtml(child.dateLabel)}</p>
        <p class="shift-hours">${escapeHtml(child.shiftTime)}</p>
      </div>
      <div class="shift-child">
        <img class="shift-avatar" src="${child.avatar}" alt="${escapeHtml(child.name)}" width="60" height="60" />
        <div class="shift-meta">
          <p class="shift-name">${escapeHtml(child.name)}</p>
          <p class="shift-age">${escapeHtml(child.age)}</p>
        </div>
      </div>`;
  }

  function renderSchedule(el) {
    if (!el) return;

    el.innerHTML = data.schedule
      .map((item, index) => {
        const detailHtml = item.location
          ? `<div class="schedule-location">
              <img src="assets/location.svg" alt="" width="16" height="16" />
              <p>${escapeHtml(item.location)}</p>
            </div>`
          : `<p class="schedule-detail">${escapeHtml(item.detail || "")}</p>`;

        const checkControl = item.completed
          ? `<span class="check-icon" aria-label="Completed">
              <img src="assets/check.svg" alt="" width="24" height="24" />
            </span>`
          : `<button type="button" class="check-btn" data-complete-id="${item.id}" aria-label="Mark ${escapeHtml(item.title)} as complete">
              <img src="assets/check.svg" alt="" width="24" height="24" />
            </button>`;

        const divider =
          index < data.schedule.length - 1
            ? `<hr class="schedule-divider" />`
            : "";

        return `
          <li class="schedule-row${item.completed ? " is-completed" : ""}">
            <div class="schedule-item-wrap">
              <button type="button" class="schedule-item" data-schedule-id="${item.id}" aria-label="View details for ${escapeHtml(item.title)}">
                <span class="schedule-time">${escapeHtml(item.time)}</span>
                <div class="schedule-body">
                  <p class="schedule-title">${escapeHtml(item.title)}</p>
                  ${detailHtml}
                </div>
              </button>
              <div class="schedule-check">${checkControl}</div>
            </div>
            ${divider}
          </li>`;
      })
      .join("");

    el.querySelectorAll("[data-schedule-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = data.schedule.find((s) => s.id === btn.dataset.scheduleId);
        if (item) openModal(item);
      });
    });

    el.querySelectorAll("[data-complete-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = data.schedule.find((s) => s.id === btn.dataset.completeId);
        if (!item) return;
        item.completed = true;
        renderSchedule(el);
      });
    });
  }

  function renderContacts(el) {
    if (!el) return;
    el.innerHTML = data.contacts
      .map(
        (contact) => `
      <article class="contact-card">
        <img class="contact-avatar" src="${contact.avatar}" alt="${escapeHtml(contact.name)}" width="35" height="35" />
        <div class="contact-meta">
          <p class="contact-name">${escapeHtml(contact.name)}</p>
          <p class="contact-phone">${escapeHtml(contact.phone)}</p>
        </div>
        <a class="call-btn" href="${contact.phoneHref}" aria-label="Call ${escapeHtml(contact.name)}">
          <img src="assets/call.svg" alt="" width="23" height="22" />
        </a>
      </article>`
      )
      .join("");
  }

  function renderKnowTiles(el) {
    if (!el) return;
    el.innerHTML = data.knowTiles
      .map(
        (tile) => `
      <a class="know-tile" href="${tile.href}">
        <img src="${tile.icon}" alt="" width="24" height="24" />
        <span>${escapeHtml(tile.label)}</span>
      </a>`
      )
      .join("");
  }

  function initModal() {
    const overlay = document.getElementById("activity-modal");
    if (!overlay) return;

    const closeBtn = overlay.querySelector("[data-close-modal]");
    closeBtn.addEventListener("click", closeModal);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && overlay.classList.contains("is-open")) {
        closeModal();
      }
    });
  }

  function openModal(item) {
    const overlay = document.getElementById("activity-modal");
    if (!overlay) return;

    overlay.querySelector("[data-modal-time]").textContent = item.time;
    overlay.querySelector("[data-modal-date]").textContent = data.child.dateLabel;
    overlay.querySelector("[data-modal-title]").textContent = item.title;

    const mapEl = overlay.querySelector("[data-modal-map]");
    if (item.map) {
      mapEl.src = item.map;
      mapEl.hidden = false;
    } else {
      mapEl.hidden = true;
      mapEl.removeAttribute("src");
    }

    const locationEl = overlay.querySelector("[data-modal-location]");
    const locationText = overlay.querySelector("[data-modal-location-text]");
    const detailEl = overlay.querySelector("[data-modal-detail]");

    if (item.location) {
      locationText.textContent = item.location;
      locationEl.hidden = false;
      detailEl.hidden = true;
      detailEl.textContent = "";
    } else if (item.detail) {
      locationEl.hidden = true;
      locationText.textContent = "";
      detailEl.textContent = item.detail;
      detailEl.hidden = false;
    } else {
      locationEl.hidden = true;
      locationText.textContent = "";
      detailEl.hidden = true;
      detailEl.textContent = "";
    }

    const careEl = overlay.querySelector("[data-modal-care]");
    const careBody = overlay.querySelector("[data-modal-care-body]");
    if (item.careNote) {
      careBody.textContent = item.careNote;
      careEl.hidden = false;
    } else {
      careEl.hidden = true;
    }

    overlay.classList.add("is-open");
    overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    overlay.querySelector("[data-close-modal]").focus();
  }

  function closeModal() {
    const overlay = document.getElementById("activity-modal");
    if (!overlay) return;
    overlay.classList.remove("is-open");
    overlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
