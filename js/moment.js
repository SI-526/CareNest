// BeReal-style "moment": at a random time during the shift, prompt the sitter to share
// a back-camera + front-camera photo within 2:00. Posts after the window are marked Late.
(function () {
  const store = window.CareNestStore;
  const data = window.CareNestData;
  const page = document.body.dataset.page;
  if (!store || !data || (page !== "home" && page !== "messages")) return;
  if (document.body.dataset.role === "parent") return; // moments are the sitter's prompt
  if (!document.createElement("dialog").showModal) return;

  const parent = (data.contacts && data.contacts[0] && data.contacts[0].firstName) || "the parent";
  const LOCKED_TEXT = "This shift has ended. Photos can't be added after a shift.";

  // Static markup only; dynamic text is set with textContent below.
  const banner = document.createElement("section");
  banner.className = "moment-banner";
  banner.id = "moment-banner";
  banner.hidden = true;
  banner.setAttribute("aria-labelledby", "moment-heading");
  banner.innerHTML = `
    <div class="moment-banner-text">
      <h2 class="moment-heading" id="moment-heading"></h2>
      <p class="moment-timer" data-timer></p>
    </div>
    <div class="moment-progress" aria-hidden="true"><span data-bar></span></div>
    <button type="button" class="primary-btn" data-open>Share a moment</button>`;
  banner.querySelector("#moment-heading").textContent = `Time to share a moment with ${parent}!`;

  const status = document.createElement("p");
  status.className = "visually-hidden";
  status.setAttribute("aria-live", "polite");
  status.id = "moment-status";

  const dialog = document.createElement("dialog");
  dialog.className = "moment-dialog";
  dialog.setAttribute("aria-labelledby", "moment-dialog-title");
  dialog.innerHTML = `
    <div class="moment-dialog-body">
      <h2 class="complete-heading" id="moment-dialog-title">Share a moment</h2>
      <p class="moment-timer" data-timer></p>
      <p class="moment-step" data-step></p>
      <div class="photo-preview-frame moment-stage">
        <video class="photo-preview" data-video autoplay playsinline muted hidden></video>
        <img class="photo-preview" data-preview alt="" hidden />
      </div>
      <div class="photo-source-actions">
        <button type="button" class="primary-btn" data-capture hidden>Capture photo</button>
        <button type="button" class="photo-source-btn" data-upload>Upload a photo instead</button>
        <button type="button" class="photo-source-btn" data-retake hidden>Retake</button>
        <input type="file" accept="image/*" data-file hidden />
      </div>
      <label class="complete-note-label" for="moment-caption">Caption (optional)</label>
      <input class="complete-note moment-caption" id="moment-caption" type="text" maxlength="200" autocomplete="off" />
      <p class="photo-upload-error" data-error role="alert" hidden></p>
      <div class="moment-dialog-actions">
        <button type="button" class="primary-btn" data-post disabled></button>
        <button type="button" class="photo-source-btn" data-cancel>Cancel</button>
      </div>
    </div>`;

  const q = (sel) => dialog.querySelector(sel);
  const video = q("[data-video]");
  const preview = q("[data-preview]");
  const captureBtn = q("[data-capture]");
  const uploadBtn = q("[data-upload]");
  const retakeBtn = q("[data-retake]");
  const fileInput = q("[data-file]");
  const postBtn = q("[data-post]");
  const errorEl = q("[data-error]");
  const stepEl = q("[data-step]");
  const captionEl = q("#moment-caption");
  postBtn.textContent = `Post to ${parent}`;

  const nav = document.querySelector(".primary-nav") || document.querySelector(".detail-nav");
  const app = document.querySelector(".app");
  if (nav && nav.parentNode) nav.insertAdjacentElement("afterend", banner);
  else if (app) app.prepend(banner);
  document.body.append(status, dialog);

  let stream = null;
  let step = "back";
  let backCanvas = null;
  let photoDataUrl = null;
  let announcedFor = null;
  let announced = new Set();

  function formatLeft(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  function announce(text) {
    status.textContent = "";
    setTimeout(() => (status.textContent = text), 50);
  }

  function tick() {
    const m = store.getMomentStatus();
    const due = m.state === "due";
    banner.hidden = !due;

    if (dialog.open && !store.isShiftActive()) {
      showError(LOCKED_TEXT);
      postBtn.disabled = true;
    }
    if (!due) return;

    const left = m.deadline - Date.now();
    const timerText = m.late
      ? "Time's up. You can still share, but it will be marked Late."
      : `${formatLeft(left)} left`;
    banner.querySelector("[data-timer]").textContent = timerText;
    q("[data-timer]").textContent = timerText;
    banner.classList.toggle("is-late", m.late);
    const pct = Math.max(0, Math.min(100, (left / store.MOMENT_WINDOW_MS) * 100));
    banner.querySelector("[data-bar]").style.width = `${pct}%`;

    // Polite announcements at a few checkpoints, not every second.
    if (announcedFor !== m.momentAt) {
      announcedFor = m.momentAt;
      announced = new Set();
      if (!m.late) announce(`Time to share a moment with ${parent}! You have ${formatLeft(left)}.`);
      announced.add("start");
    }
    const checkpoints = [
      ["60", left <= 60000 && left > 50000, "1 minute left to share a moment."],
      ["10", left <= 10000 && left > 0, "10 seconds left to share a moment."],
      ["late", m.late, "Time's up. A moment shared now will be marked Late."],
    ];
    checkpoints.forEach(([key, hit, text]) => {
      if (hit && !announced.has(key)) {
        announced.add(key);
        announce(text);
      }
    });
  }

  function showError(text) {
    errorEl.textContent = text;
    errorEl.hidden = !text;
  }

  function stopCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    video.hidden = true;
  }

  function setStep(next) {
    step = next;
    const camera = next === "back" || next === "front";
    captureBtn.hidden = !camera;
    retakeBtn.hidden = next !== "review";
    preview.hidden = next !== "review";
    q(".moment-stage").hidden = next === "upload";
    stepEl.textContent = {
      back: "Step 1 of 2: photo with the back camera",
      front: "Step 2 of 2: selfie with the front camera",
      review: "Looks good? Post it, or retake.",
      upload: "Camera isn't available. Upload a photo instead.",
    }[next];
    postBtn.disabled = next !== "review" || !store.isShiftActive();
  }

  function startCamera(facing) {
    stopCamera();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error("no camera"));
    }
    return navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: facing } }, audio: false })
      .then((s) => {
        stream = s;
        video.srcObject = s;
        video.hidden = false;
        captureBtn.focus();
      });
  }

  function beginCapture() {
    backCanvas = null;
    photoDataUrl = null;
    preview.removeAttribute("src");
    setStep("back");
    startCamera("environment").catch(() => {
      setStep("upload");
      uploadBtn.focus();
    });
  }

  function capture() {
    if (!video.videoWidth) return;
    const frame = store.drawScaled(video, 1280);
    stopCamera();
    if (step === "back") {
      backCanvas = frame;
      setStep("front");
      startCamera("user").catch(() => finish(backCanvas, null));
    } else {
      finish(backCanvas, frame);
    }
  }

  // Composite the selfie as an inset over the back-camera photo (one image per moment).
  function finish(back, front) {
    const ctx = back.getContext("2d");
    if (front) {
      const w = Math.round(back.width * 0.3);
      const h = Math.round((front.height / front.width) * w);
      const x = 16;
      const y = 16;
      ctx.save();
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, 12);
      else ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.drawImage(front, x, y, w, h);
      ctx.restore();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 4;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, 12);
      else ctx.rect(x, y, w, h);
      ctx.stroke();
    }
    setPhoto(back.toDataURL("image/jpeg", 0.82));
  }

  function setPhoto(dataUrl) {
    photoDataUrl = dataUrl;
    preview.src = dataUrl;
    preview.alt = "Moment photo preview";
    setStep("review");
    postBtn.focus();
  }

  function openDialog() {
    if (!store.isShiftActive()) return;
    showError("");
    captionEl.value = "";
    dialog.showModal();
    beginCapture();
  }

  dialog.addEventListener("close", () => {
    stopCamera();
    // Back to the opener while the prompt is still showing; otherwise to the page.
    const target = !banner.hidden
      ? banner.querySelector("[data-open]")
      : document.querySelector("main, .app");
    if (target) {
      if (!target.hasAttribute("tabindex") && target.tagName !== "BUTTON") {
        target.setAttribute("tabindex", "-1");
      }
      target.focus();
    }
  });

  banner.querySelector("[data-open]").addEventListener("click", openDialog);
  captureBtn.addEventListener("click", capture);
  retakeBtn.addEventListener("click", beginCapture);
  q("[data-cancel]").addEventListener("click", () => dialog.close());
  uploadBtn.addEventListener("click", () => {
    stopCamera();
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    store
      .downscaleImage(file)
      .then(setPhoto)
      .catch((err) => showError(err.message));
  });
  postBtn.addEventListener("click", () => {
    if (!photoDataUrl) return;
    try {
      const msg = store.postMoment({ photoDataUrl, body: captionEl.value });
      dialog.close();
      announce(`Moment shared with ${parent}${msg.late ? " (marked Late)" : ""}.`);
    } catch (err) {
      showError(err.message);
    }
  });

  store.subscribe(tick);
  tick();
  setInterval(tick, 1000);
})();
