(function () {
  const data = window.CareNestData;
  const store = window.CareNestStore;
  if (!data) return;

  const page = document.body.dataset.page;
  let pendingCompleteItem = null;
  let pendingPhotoFile = null;
  let photoObjectUrl = null;
  let cameraStream = null;
  let returnFocusEl = null;

  const SHIFT_LOCKED_TEXT = "This shift has ended. Photos can't be added after a shift.";
  const isDevHost =
    ["localhost", "127.0.0.1", "[::1]", ""].includes(window.location.hostname) ||
    demoFlag();
  // Until real accounts exist, the parent side is the same app opened as parent.html or
  // messages.html?as=parent (a second tab in the same browser stays in sync via the store).
  const role =
    page === "parent" ||
    (page === "messages" && new URLSearchParams(window.location.search).get("as") === "parent")
      ? "parent"
      : "sitter";
  if (role === "parent") document.body.dataset.role = "parent";

  // ?demo=1 turns on the demo/dev controls for this browser tab (e.g. on the deployed site).
  function demoFlag() {
    try {
      if (new URLSearchParams(window.location.search).has("demo")) {
        sessionStorage.setItem("carenest:demo", "1");
      }
      return sessionStorage.getItem("carenest:demo") === "1";
    } catch (e) {
      return false;
    }
  }

  // Render only after the auth guard (js/auth.js) has checked the session and role and filled in
  // real names. Without the guard (no js/auth.js on the page) render straight away.
  const authReady = window.CareNestAuth ? window.CareNestAuth.ready : Promise.resolve();
  authReady.then(() => {
    if (page === "home") {
      initHome();
    } else if (page === "food") {
      initFood();
    } else if (page === "info") {
      initInfo();
    } else if (page === "messages") {
      initMessages();
    }
  });

  function initHome() {
    initNavigation();
    const profileHeading = document.getElementById("profile-heading");
    if (profileHeading) profileHeading.textContent = `Welcome ${data.babysitter.name}`;
    renderSitterHeader(document.getElementById("sitter-header"));
    renderShift();
    renderShiftControls();
    renderSchedule(document.getElementById("schedule-list"));
    renderEmergencyEntry(document.getElementById("emergency-entry"));
    renderContacts(document.getElementById("contacts-list"));
    renderKnowTiles(document.getElementById("know-grid"));
    initModal();
    initCompleteModal();
    initEndShiftDialog();
    renderDevTools();

    store.subscribe(() => {
      renderShiftControls();
      renderSchedule(document.getElementById("schedule-list"));
      applyShiftLockToCompleteModal();
    });
  }

  function initNavigation() {
    const links = Array.from(document.querySelectorAll(".primary-nav .nav-item"));
    if (!links.length) return;

    const updateCurrentPage = () => {
      const hash = window.location.hash || "#home";
      links.forEach((link) => {
        if (link.getAttribute("href") === hash) {
          link.setAttribute("aria-current", "page");
        } else {
          link.removeAttribute("aria-current");
        }
      });
    };

    window.addEventListener("hashchange", updateCurrentPage);
    updateCurrentPage();
  }

  function initFood() {
    const allergies = data.allergies;
    const list = document.getElementById("restriction-list");
    const careNoteEl = document.getElementById("care-note-body");

    const items = allergies.items || [];
    list.innerHTML = items.length
      ? items
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
          .join("")
      : emptyStateHtml("");

    if (allergies.careNote) {
      careNoteEl.textContent = allergies.careNote;
    } else {
      careNoteEl.closest(".care-note").hidden = true;
    }
  }

  function initInfo() {
    const params = new URLSearchParams(window.location.search);
    const key = params.get("category") || "";
    const category = data.categories[key];
    const title = category ? category.title : "Care information";
    const titleEl = document.getElementById("info-title");
    if (titleEl) titleEl.textContent = title;
    document.title = `CareNest — ${title}`;

    const contentEl = document.getElementById("info-content");
    if (!contentEl) return;

    if (!category || !categoryHasContent(category)) {
      contentEl.innerHTML = `<section class="panel">${emptyStateHtml()}</section>`;
      return;
    }

    contentEl.innerHTML = [
      renderEmergencyCallout(category.callout),
      renderEmergencySteps(category.steps),
      renderHospital(category.hospital),
      renderEmergencyContacts(category.contacts),
      renderInfoItems(category.items),
    ].join("");
  }

  function categoryHasContent(category) {
    return Boolean(
      (category.items && category.items.length) ||
        (category.steps && category.steps.length) ||
        category.hospital ||
        (category.contacts && category.contacts.length)
    );
  }

  function emptyStateHtml(cardClass = "card") {
    return `<div class="${cardClass} empty-state"><p>No information provided</p></div>`;
  }

  function renderInfoItems(items) {
    if (!items || !items.length) return "";
    return `
      <section class="panel">
        <ul class="info-list">
          ${items
            .map(
              (item) => `
            <li class="info-item">
              <h2 class="info-item-title">${escapeHtml(item.title)}</h2>
              ${item.detail ? `<p class="info-item-detail">${escapeHtml(item.detail)}</p>` : ""}
            </li>`
            )
            .join("")}
        </ul>
      </section>`;
  }

  function renderEmergencyCallout(callout) {
    if (!callout) return "";
    return `
      <section class="emergency-callout" aria-label="Call 911">
        <p>${escapeHtml(callout.text)}</p>
        <a class="emergency-call-btn" href="${escapeHtml(callout.href)}">${escapeHtml(callout.label)}</a>
      </section>`;
  }

  function renderEmergencySteps(steps) {
    if (!steps || !steps.length) return "";
    return `
      <section class="panel" aria-labelledby="steps-heading">
        <h2 class="panel-title" id="steps-heading">What to do</h2>
        <div class="card">
          <ol class="emergency-steps">
            ${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}
          </ol>
        </div>
      </section>`;
  }

  function renderHospital(hospital) {
    if (!hospital) return "";
    const callBtn = hospital.phoneHref
      ? `<a class="call-btn" href="${escapeHtml(hospital.phoneHref)}" aria-label="Call ${escapeHtml(hospital.name)}">
          <img src="assets/call.svg" alt="" width="23" height="22" />
        </a>`
      : "";
    const address = hospital.mapHref
      ? `<a class="hospital-address" href="${escapeHtml(hospital.mapHref)}" target="_blank" rel="noopener">${escapeHtml(hospital.address)}<span class="visually-hidden"> (opens map in a new tab)</span></a>`
      : `<p class="hospital-address">${escapeHtml(hospital.address)}</p>`;
    return `
      <section class="panel" aria-labelledby="hospital-heading">
        <h2 class="panel-title" id="hospital-heading">Hospital</h2>
        <div class="card hospital-card">
          <div class="hospital-meta">
            <p class="contact-name">${escapeHtml(hospital.name)}</p>
            ${hospital.system ? `<p class="hospital-system">${escapeHtml(hospital.system)}</p>` : ""}
            <div class="modal-location">
              <img src="assets/location.svg" alt="" width="16" height="16" />
              ${address}
            </div>
            ${hospital.phone ? `<p class="contact-phone">${escapeHtml(hospital.phone)}</p>` : ""}
          </div>
          ${callBtn}
        </div>
      </section>`;
  }

  function renderEmergencyContacts(contacts) {
    if (!contacts || !contacts.length) return "";
    const resolved = contacts
      .map((c) => {
        if (!c.contactId) return c;
        const base = data.contacts.find((d) => d.id === c.contactId);
        return base ? Object.assign({}, base, c) : null;
      })
      .filter(Boolean);
    if (!resolved.length) return "";
    return `
      <section class="panel" aria-labelledby="who-heading">
        <h2 class="panel-title" id="who-heading">Who to contact</h2>
        <div class="contacts-list">
          ${resolved
            .map((contact) => {
              const avatar = contact.avatar
                ? `<img class="contact-avatar" src="${escapeHtml(contact.avatar)}" alt="" width="35" height="35" />`
                : `<span class="contact-avatar contact-initials" aria-hidden="true">${escapeHtml(initials(contact.name))}</span>`;
              return `
            <article class="contact-card">
              ${avatar}
              <div class="contact-meta">
                <p class="contact-name">${escapeHtml(contact.name)}</p>
                ${contact.role ? `<p class="contact-role">${escapeHtml(contact.role)}</p>` : ""}
                <p class="contact-phone">${escapeHtml(contact.phone)}</p>
              </div>
              <a class="call-btn" href="${escapeHtml(contact.phoneHref)}" aria-label="Call ${escapeHtml(contact.name)}">
                <img src="assets/call.svg" alt="" width="23" height="22" />
              </a>
            </article>`;
            })
            .join("")}
        </div>
      </section>`;
  }

  function initials(name) {
    return String(name)
      .replace(/^Dr\.\s*/, "")
      .split(/\s+/)
      .map((part) => part.charAt(0))
      .join("")
      .slice(0, 2)
      .toUpperCase();
  }

  function renderEmergencyEntry(el) {
    if (!el) return;
    const emergency = data.categories.emergency;
    if (!emergency) return;
    el.innerHTML = `
      <a class="emergency-card" href="info.html?category=emergency">
        <span class="emergency-card-icon" aria-hidden="true">
          <img src="assets/emergency.svg" alt="" width="22" height="22" />
        </span>
        <span class="emergency-card-meta">
          <span class="emergency-card-title">${escapeHtml(emergency.title)}</span>
          <span class="emergency-card-text">${escapeHtml(emergency.summary)}</span>
        </span>
      </a>`;
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

  // Merge the static schedule with persisted completions from the store.
  function scheduleWithCompletions() {
    const completions = store.getCompletions();
    return data.schedule.map((item) => {
      const completion = completions[item.id];
      return Object.assign({}, item, {
        completed: Boolean(completion),
        completion: completion || null,
        photoUrl:
          completion && store.isPhotoDataUrl(completion.photoDataUrl)
            ? completion.photoDataUrl
            : null,
      });
    });
  }

  function renderSchedule(el) {
    if (!el) return;

    const shiftActive = store.isShiftActive();
    const lockNote = document.getElementById("schedule-locked");
    if (lockNote) lockNote.hidden = shiftActive;
    const items = scheduleWithCompletions();

    el.innerHTML = items
      .map((item, index) => {
        const detailHtml = item.location
          ? `<div class="schedule-location">
              <img src="assets/location.svg" alt="" width="16" height="16" />
              <p>${escapeHtml(item.location)}</p>
            </div>`
          : `<p class="schedule-detail">${escapeHtml(item.detail || "")}</p>`;

        const photoThumb =
          item.completed && item.photoUrl
            ? `<span class="photo-thumb">
                <img src="${item.photoUrl}" alt="" width="36" height="36" />
              </span>`
            : "";

        const completedMark = item.completed
          ? `<span class="check-icon">
              <img src="assets/check.svg" alt="" width="24" height="24" />
            </span>`
          : "";

        const trailing =
          photoThumb || completedMark
            ? `<span class="schedule-trailing">${photoThumb}${completedMark}</span>`
            : "";

        const completeButton = item.completed
          ? ""
          : `<button type="button" class="check-btn" data-complete-id="${escapeHtml(item.id)}" aria-label="Mark ${escapeHtml(item.title)} as complete"${shiftActive ? "" : ` disabled aria-describedby="schedule-locked"`}>
              <img src="assets/check.svg" alt="" width="24" height="24" />
            </button>`;

        const divider =
          index < items.length - 1
            ? `<hr class="schedule-divider" />`
            : "";

        const completedLabel = item.completed ? ", completed" : "";

        return `
          <li class="schedule-row${item.completed ? " is-completed" : ""}">
            <div class="schedule-item-wrap">
              <button type="button" class="schedule-item" data-schedule-id="${escapeHtml(item.id)}" aria-label="View details for ${escapeHtml(item.title)}${completedLabel}">
                <span class="schedule-time">${escapeHtml(item.time)}</span>
                <div class="schedule-body">
                  <p class="schedule-title">${escapeHtml(item.title)}</p>
                  ${detailHtml}
                </div>
                ${trailing}
              </button>
              ${completeButton}
            </div>
            ${divider}
          </li>`;
      })
      .join("");

    el.querySelectorAll("[data-schedule-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = items.find((s) => s.id === btn.dataset.scheduleId);
        if (item) openModal(item, btn);
      });
    });

    el.querySelectorAll("[data-complete-id]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const item = items.find((s) => s.id === btn.dataset.completeId);
        if (!item || item.completed || !store.isShiftActive()) return;
        openCompleteModal(item, btn);
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
  }

  function initCompleteModal() {
    const overlay = document.getElementById("complete-modal");
    if (!overlay) return;

    const closeBtn = overlay.querySelector("[data-close-complete]");
    const uploadBtn = document.getElementById("complete-photo-upload");
    const cameraBtn = document.getElementById("complete-photo-camera-btn");
    const input = document.getElementById("complete-photo-input");
    const cameraInput = document.getElementById("complete-photo-camera-input");
    const captureBtn = document.getElementById("complete-photo-capture");
    const cancelCameraBtn = document.getElementById("complete-photo-camera-cancel");
    const sendBtn = document.getElementById("complete-send-btn");

    closeBtn.addEventListener("click", closeCompleteModal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeCompleteModal();
    });

    uploadBtn.addEventListener("click", () => {
      stopCamera();
      restorePhotoPreview();
      input.click();
    });
    cameraBtn.addEventListener("click", startCamera);
    captureBtn.addEventListener("click", captureCameraPhoto);
    cancelCameraBtn.addEventListener("click", cancelCamera);
    input.addEventListener("change", handlePhotoSelected);
    cameraInput.addEventListener("change", handlePhotoSelected);
    sendBtn.addEventListener("click", submitComplete);

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const completeOpen = overlay.classList.contains("is-open");
      const activityOpen = document
        .getElementById("activity-modal")
        ?.classList.contains("is-open");
      if (completeOpen) closeCompleteModal();
      else if (activityOpen) closeModal();
    });
  }

  function parentFirstName() {
    if (data.parentName) return data.parentName.split(/\s+/)[0];
    const contact = data.contacts && data.contacts[0];
    return (contact && contact.firstName) || "parent";
  }

  function taskDetailText(item) {
    return item.location || item.detail || "";
  }

  function openCompleteModal(item, opener) {
    const overlay = document.getElementById("complete-modal");
    if (!overlay) return;

    returnFocusEl = opener || document.activeElement;
    pendingCompleteItem = item;
    resetPhotoUpload();

    overlay.querySelector("[data-complete-time]").textContent = item.time;
    overlay.querySelector("[data-complete-title]").textContent = item.title;
    overlay.querySelector("[data-complete-detail]").textContent =
      taskDetailText(item);

    document.getElementById("complete-note").value = "";
    const noTag = overlay.querySelector('input[name="complete-tag"][value=""]');
    if (noTag) noTag.checked = true;
    const sendBtn = document.getElementById("complete-send-btn");
    sendBtn.textContent = `Send to ${parentFirstName()}`;
    sendBtn.disabled = false;

    closeModal(false);
    overlay.classList.add("is-open");
    overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    overlay.querySelector("[data-close-complete]").focus();
  }

  function closeCompleteModal(restoreFocus = true) {
    const overlay = document.getElementById("complete-modal");
    if (!overlay) return;
    const wasOpen = overlay.classList.contains("is-open");
    overlay.classList.remove("is-open");
    overlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    pendingCompleteItem = null;
    resetPhotoUpload();
    if (wasOpen && restoreFocus) restoreFocusAfterModal();
  }

  function restoreFocusAfterModal() {
    const el = returnFocusEl;
    returnFocusEl = null;
    if (el && el.isConnected && !el.disabled) el.focus();
  }

  function applyShiftLockToCompleteModal() {
    const overlay = document.getElementById("complete-modal");
    if (!overlay || !overlay.classList.contains("is-open")) return;
    if (store.isShiftActive()) return;
    const error = document.getElementById("complete-photo-error");
    error.textContent = SHIFT_LOCKED_TEXT;
    error.hidden = false;
    document.getElementById("complete-send-btn").disabled = true;
  }

  function resetPhotoUpload() {
    const input = document.getElementById("complete-photo-input");
    const cameraInput = document.getElementById("complete-photo-camera-input");
    const preview = document.getElementById("complete-photo-preview");
    const stage = document.getElementById("complete-photo-stage");
    const error = document.getElementById("complete-photo-error");
    const cameraError = document.getElementById("complete-photo-camera-error");

    stopCamera();
    pendingPhotoFile = null;

    if (photoObjectUrl) {
      URL.revokeObjectURL(photoObjectUrl);
      photoObjectUrl = null;
    }

    if (input) input.value = "";
    if (cameraInput) cameraInput.value = "";
    if (preview) {
      preview.hidden = true;
      preview.removeAttribute("src");
      preview.alt = "";
    }
    if (stage) stage.hidden = true;
    if (error) {
      error.hidden = true;
      error.textContent = "Please add a photo before sending.";
    }
    if (cameraError) cameraError.hidden = true;

    const choices = document.getElementById("complete-photo-choices");
    if (choices) choices.hidden = false;
  }

  function handlePhotoSelected(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    const otherId =
      e.target.id === "complete-photo-input"
        ? "complete-photo-camera-input"
        : "complete-photo-input";
    const other = document.getElementById(otherId);
    if (other) other.value = "";

    stopCamera();
    setPendingPhoto(file);
  }

  function setPendingPhoto(file) {
    const preview = document.getElementById("complete-photo-preview");
    const stage = document.getElementById("complete-photo-stage");
    const error = document.getElementById("complete-photo-error");
    const cameraError = document.getElementById("complete-photo-camera-error");
    if (!file || !preview || !stage) return;

    pendingPhotoFile = file;
    if (photoObjectUrl) URL.revokeObjectURL(photoObjectUrl);
    photoObjectUrl = URL.createObjectURL(file);
    preview.src = photoObjectUrl;
    preview.alt = "Task photo";
    preview.hidden = false;
    stage.hidden = false;
    if (error) error.hidden = true;
    if (cameraError) cameraError.hidden = true;
  }

  function restorePhotoPreview() {
    const preview = document.getElementById("complete-photo-preview");
    const stage = document.getElementById("complete-photo-stage");
    const video = document.getElementById("complete-photo-video");
    if (video) video.hidden = true;
    if (pendingPhotoFile && preview && preview.getAttribute("src")) {
      preview.hidden = false;
      if (stage) stage.hidden = false;
      return;
    }
    if (preview) preview.hidden = true;
    if (stage) stage.hidden = true;
  }

  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = null;
    }

    const video = document.getElementById("complete-photo-video");
    if (video) {
      video.pause();
      video.srcObject = null;
      video.hidden = true;
    }

    const cameraActions = document.getElementById("complete-photo-camera-actions");
    const choices = document.getElementById("complete-photo-choices");
    if (cameraActions) cameraActions.hidden = true;
    if (choices) choices.hidden = false;
  }

  function startCamera() {
    const cameraError = document.getElementById("complete-photo-camera-error");
    const error = document.getElementById("complete-photo-error");
    if (error) error.hidden = true;
    if (cameraError) cameraError.hidden = true;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      document.getElementById("complete-photo-camera-input").click();
      return;
    }

    stopCamera();
    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      })
      .then((stream) => {
        cameraStream = stream;
        const video = document.getElementById("complete-photo-video");
        const preview = document.getElementById("complete-photo-preview");
        const stage = document.getElementById("complete-photo-stage");
        const choices = document.getElementById("complete-photo-choices");
        const cameraActions = document.getElementById(
          "complete-photo-camera-actions"
        );
        video.srcObject = stream;
        video.hidden = false;
        if (preview) preview.hidden = true;
        if (stage) stage.hidden = false;
        if (choices) choices.hidden = true;
        if (cameraActions) cameraActions.hidden = false;
        document.getElementById("complete-photo-capture").focus();
      })
      .catch(() => {
        restorePhotoPreview();
        if (cameraError) cameraError.hidden = false;
        document.getElementById("complete-photo-upload").focus();
      });
  }

  function cancelCamera() {
    stopCamera();
    restorePhotoPreview();
  }

  function captureCameraPhoto() {
    const video = document.getElementById("complete-photo-video");
    if (!video || !video.videoWidth) return;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const file = new File([blob], "task-photo.jpg", { type: "image/jpeg" });
        stopCamera();
        setPendingPhoto(file);
      },
      "image/jpeg",
      0.92
    );
  }

  function submitComplete() {
    const error = document.getElementById("complete-photo-error");
    const note = document.getElementById("complete-note").value.trim();

    if (cameraStream) {
      if (error) {
        error.textContent = "Capture the photo before sending.";
        error.hidden = false;
      }
      document.getElementById("complete-photo-capture").focus();
      return;
    }

    const file = pendingPhotoFile;

    if (!file) {
      if (error) {
        error.textContent = "Please add a photo before sending.";
        error.hidden = false;
      }
      document.getElementById("complete-photo-upload").focus();
      return;
    }

    if (!pendingCompleteItem) return;

    const item = pendingCompleteItem;
    const tagInput = document.querySelector('input[name="complete-tag"]:checked');
    const tag = tagInput ? tagInput.value : "";
    const sendBtn = document.getElementById("complete-send-btn");
    sendBtn.disabled = true;

    store
      .downscaleImage(file)
      .then((photoDataUrl) => {
        store.completeTask({ taskId: item.id, photoDataUrl, note, tag });
        // The check button is gone after re-render; return focus to the task row.
        returnFocusEl = null;
        closeCompleteModal(false);
        const row = document.querySelector(
          `[data-schedule-id="${cssEscape(item.id)}"]`
        );
        if (row) row.focus();
        announce(`${item.title} sent to ${parentFirstName()}.`);
      })
      .catch((err) => {
        sendBtn.disabled = Boolean(err && err.code === "shift_ended");
        if (error) {
          error.textContent =
            (err && err.message) || "Something went wrong. Please try again.";
          error.hidden = false;
        }
      });
  }

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : String(value);
  }

  function announce(text) {
    const el = document.getElementById("app-status");
    if (!el) return;
    el.textContent = "";
    window.setTimeout(() => {
      el.textContent = text;
    }, 50);
  }

  function formatTime(ms) {
    return new Date(ms).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function renderShiftControls() {
    const el = document.getElementById("shift-controls");
    if (!el) return;
    const shift = store.getShift();
    const status = el.querySelector("[data-shift-status]");
    const endBtn = el.querySelector("[data-end-shift]");
    if (shift.endedAt) {
      status.textContent = `Shift ended at ${formatTime(shift.endedAt)}.`;
      endBtn.hidden = true;
    } else {
      status.textContent = `Shift in progress since ${formatTime(shift.startedAt)}.`;
      endBtn.hidden = false;
    }
  }

  function initEndShiftDialog() {
    const dialog = document.getElementById("end-shift-dialog");
    const openBtn = document.querySelector("[data-end-shift]");
    if (!dialog || !openBtn || typeof dialog.showModal !== "function") return;

    openBtn.addEventListener("click", () => {
      dialog.returnValue = "";
      dialog.showModal();
    });

    dialog.addEventListener("close", () => {
      if (dialog.returnValue === "confirm") {
        store.endShift();
        announce("Shift ended. Photos can no longer be added.");
        const heading = document.getElementById("shift-heading");
        const status = document.querySelector("[data-shift-status]");
        if (status) {
          status.setAttribute("tabindex", "-1");
          status.focus();
        } else if (heading) heading.focus();
      } else {
        openBtn.focus();
      }
    });
  }

  // Dev-only controls so the moment prompt and shift lock can be tested quickly.
  function renderDevTools() {
    if (!isDevHost) return;
    const host = document.querySelector(".side-column") || document.querySelector(".app");
    if (!host) return;
    const box = document.createElement("section");
    box.className = "panel dev-tools";
    box.setAttribute("aria-labelledby", "dev-tools-heading");
    box.innerHTML = `
      <h2 class="panel-title" id="dev-tools-heading">Dev tools (localhost only)</h2>
      <div class="dev-tools-actions">
        <a class="photo-source-btn dev-link" href="parent.html" target="_blank" rel="noopener">Open parent view<span class="visually-hidden"> (opens in a new tab)</span></a>
        <button type="button" class="photo-source-btn" data-dev="moment">Trigger moment now</button>
        <button type="button" class="photo-source-btn" data-dev="reset">Start a new shift (clears data)</button>
      </div>`;
    box.querySelector('[data-dev="moment"]').addEventListener("click", () => {
      if (!store.isShiftActive()) store.resetShift();
      store.triggerMomentNow();
    });
    box.querySelector('[data-dev="reset"]').addEventListener("click", () => {
      store.resetShift();
      announce("New shift started.");
    });
    host.appendChild(box);
  }

  function senderName(sender) {
    if (sender === "parent") {
      if (data.parentName) return data.parentName;
      const contact = data.contacts && data.contacts[0];
      return (contact && contact.name) || "Parent";
    }
    return data.babysitter.name;
  }

  function photoImg(src, alt, className) {
    if (!store.isPhotoDataUrl(src)) return "";
    return `<img class="${className}" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" />`;
  }

  function messageMeta(message) {
    const iso = new Date(message.sentAt).toISOString();
    return `<p class="msg-meta">${escapeHtml(senderName(message.sender))} · <time datetime="${iso}">${escapeHtml(formatTime(message.sentAt))}</time></p>`;
  }

  // Label for a task_proof/moment message, e.g. "Snack" or "Moment".
  function photoTitle(message) {
    if (!message) return "Photo";
    if (message.kind === "moment") return "Moment";
    const task = data.schedule.find((s) => s.id === message.taskId);
    return task ? task.title : "Task";
  }

  function renderMessage(message, completions, byId) {
    const side = message.sender === role ? "is-mine" : "is-theirs";

    if (message.kind === "task_proof") {
      const task = data.schedule.find((s) => s.id === message.taskId);
      const completion = completions[message.taskId];
      const title = task ? task.title : "Task";
      return `
        <li class="msg ${side}" id="msg-${escapeHtml(message.id)}">
          <article class="msg-card proof-card" aria-label="Task completed: ${escapeHtml(title)}">
            <p class="msg-card-kicker">
              <img src="assets/check.svg" alt="" width="16" height="16" />
              Task completed
            </p>
            <h2 class="msg-card-title">${escapeHtml(title)}${task ? ` <span class="msg-card-time">${escapeHtml(task.time)}</span>` : ""}</h2>
            ${completion ? photoImg(completion.photoDataUrl, `Photo for ${title}`, "msg-photo") : ""}
            ${completion && completion.tag ? `<p class="tag-chip">${escapeHtml(completion.tag)}</p>` : ""}
            ${completion && completion.note ? `<p class="msg-card-note">${escapeHtml(completion.note)}</p>` : ""}
            ${messageMeta(message)}
          </article>
        </li>`;
    }

    if (message.kind === "moment") {
      return `
        <li class="msg ${side}" id="msg-${escapeHtml(message.id)}">
          <article class="msg-card moment-card" aria-label="Moment${message.late ? ", late" : ""}">
            <p class="msg-card-kicker">
              Moment
              ${message.late ? `<span class="late-badge">Late</span>` : ""}
            </p>
            ${photoImg(message.photo, "Moment photo from the shift", "msg-photo")}
            ${message.body ? `<p class="msg-card-note">${escapeHtml(message.body)}</p>` : ""}
            ${messageMeta(message)}
          </article>
        </li>`;
    }

    const replyRef = message.replyTo
      ? `<a class="msg-reply-ref" href="#msg-${escapeHtml(message.replyTo)}">Reply to ${escapeHtml(photoTitle(byId && byId[message.replyTo]))} photo</a>`
      : "";
    return `
      <li class="msg ${side}">
        <div class="msg-bubble">
          ${replyRef}
          <p class="msg-body">${escapeHtml(message.body)}</p>
        </div>
        ${messageMeta(message)}
      </li>`;
  }

  function initMessages() {
    const list = document.getElementById("message-list");
    const form = document.getElementById("message-form");
    const input = document.getElementById("message-input");
    const error = document.getElementById("message-error");
    const title = document.getElementById("messages-title");
    // The other person in the thread, from the viewer's side.
    const parentName = role === "parent" ? data.babysitter.name : parentFirstName();
    if (role === "parent") renderParentNav("messages");
    if (title) title.textContent = `Messages with ${parentName}`;
    if (input) input.placeholder = `Message ${parentName}`;
    const label = document.querySelector('label[for="message-input"]');
    if (label) label.textContent = `Message to ${parentName}`;

    let lastCount = -1;
    const render = () => {
      const messages = store.getMessages();
      const completions = store.getCompletions();
      const byId = {};
      messages.forEach((m) => {
        byId[m.id] = m;
      });
      list.innerHTML = messages.length
        ? messages.map((m) => renderMessage(m, completions, byId)).join("")
        : `<li class="empty-state msg-empty"><p>No messages yet. Say hi to ${escapeHtml(parentName)}!</p></li>`;
      const lock = document.getElementById("messages-locked");
      if (lock) lock.hidden = role === "parent" || store.isShiftActive();
      if (messages.length !== lastCount) {
        lastCount = messages.length;
        const last = list.lastElementChild;
        if (last) last.scrollIntoView({ block: "end" });
      }
    };

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      error.hidden = true;
      try {
        const sent = store.sendChat(input.value, role);
        if (!sent) {
          error.textContent = "Type a message first.";
          error.hidden = false;
          input.focus();
          return;
        }
        input.value = "";
        announce(`Message sent to ${parentName}.`);
      } catch (err) {
        error.textContent = (err && err.message) || "Message not sent. Please try again.";
        error.hidden = false;
      }
      input.focus();
    });

    store.subscribe(render);
    render();
  }

  function openModal(item, opener) {
    const overlay = document.getElementById("activity-modal");
    if (!overlay) return;
    returnFocusEl = opener || document.activeElement;

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

    const emptyEl = overlay.querySelector("[data-modal-empty]");
    if (emptyEl) {
      emptyEl.hidden = Boolean(
        item.detail || item.location || item.map || item.careNote
      );
    }

    const photoWrap = overlay.querySelector("[data-modal-photo-wrap]");
    const photoEl = overlay.querySelector("[data-modal-photo]");
    if (item.photoUrl) {
      photoEl.src = item.photoUrl;
      photoEl.alt = `Submitted photo for ${item.title}`;
      photoWrap.hidden = false;
    } else {
      photoEl.removeAttribute("src");
      photoEl.alt = "";
      photoWrap.hidden = true;
    }

    const completion = item.completion;
    const tagEl = overlay.querySelector("[data-modal-tag]");
    if (tagEl) {
      tagEl.textContent = completion && completion.tag ? completion.tag : "";
      tagEl.hidden = !(completion && completion.tag);
    }

    const noteWrap = overlay.querySelector("[data-modal-note-wrap]");
    const noteEl = overlay.querySelector("[data-modal-note]");
    if (completion && completion.note) {
      noteEl.textContent = completion.note;
      noteWrap.hidden = false;
    } else {
      noteEl.textContent = "";
      noteWrap.hidden = true;
    }

    closeCompleteModal(false);
    overlay.classList.add("is-open");
    overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    overlay.querySelector("[data-close-modal]").focus();
  }

  function closeModal(restoreFocus = true) {
    const overlay = document.getElementById("activity-modal");
    if (!overlay) return;
    const wasOpen = overlay.classList.contains("is-open");
    overlay.classList.remove("is-open");
    overlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    if (wasOpen && restoreFocus) restoreFocusAfterModal();
  }

  // A function (not a const) because initMessages runs before this line is reached.
  function parentNavItems() {
    return [
    {
      id: "today",
      href: "parent.html#today",
      label: "Today",
      icon: '<path d="m12 3 9 7.5V21h-6v-6H9v6H3v-10.5L12 3Z" />',
    },
    {
      id: "album",
      href: "parent.html#album",
      label: "Album",
      icon: '<path d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2ZM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5Z" />',
    },
    {
      id: "messages",
      href: "messages.html?as=parent",
      label: "Messages",
      icon: '<path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8.4L4.6 21.2A1 1 0 0 1 3 20.4V5a2 2 0 0 1 1-2Zm3 6a1.25 1.25 0 1 0 0 2.5A1.25 1.25 0 0 0 7 9Zm5 0a1.25 1.25 0 1 0 0 2.5A1.25 1.25 0 0 0 12 9Zm5 0a1.25 1.25 0 1 0 0 2.5A1.25 1.25 0 0 0 17 9Z" />',
    },
    {
      id: "people",
      href: "people.html",
      label: "People",
      icon: '<path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8-1a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM9 13c-3.87 0-7 2.24-7 5v3h14v-3c0-2.76-3.13-5-7-5Zm8.24.05c-.45-.03-.91-.05-1.38-.05a11.5 11.5 0 0 0-2.66.3c1.73.96 2.8 2.37 2.8 4V21H22v-3c0-2.42-2.1-4.47-4.76-4.95Z" />',
    },
  ];
  }

  // Parent-side primary nav (static markup only).
  function renderParentNav(current) {
    const nav = document.querySelector(".primary-nav");
    if (!nav) return;
    nav.setAttribute("aria-label", "Parent navigation");
    const account = nav.querySelector("[data-account-button]"); // added by js/auth.js
    nav.innerHTML = parentNavItems().map(
      (item) => `
        <a class="nav-item" href="${item.href}" data-nav="${item.id}"${item.id === current ? ' aria-current="page"' : ""}>
          <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">${item.icon}</svg>
          <span>${item.label}</span>
        </a>`
    ).join("");
    if (account) nav.appendChild(account);
  }

  // Shared helpers for js/parent.js.
  window.CareNestUI = {
    escapeHtml,
    announce,
    formatTime,
    senderName,
    photoTitle,
    photoImg,
    renderParentNav,
    isDevHost,
  };

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
