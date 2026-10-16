// BeReal-style "moment": at a time the database picked for this shift (visits.moment_at), prompt
// the sitter to share a back-camera + front-camera photo within 2:00. The database decides
// whether a post is late; the countdown here is only a guide.
// Waits for the shift backend (js/shift-data.js), which waits for the auth guard and family data.
//
// Upload fallback: a picked photo is refused if its own capture time (EXIF) is before the prompt,
// so an old camera-roll photo can't stand in for a live moment. Photos with no readable capture
// time (PNG, screenshots, stripped EXIF) are accepted. In-page camera captures skip the check.
// The pure helpers below have no DOM dependency so tests/moment-exif.test.mjs can load this file.

(function (root) {
  const EXIF_READ_BYTES = 128 * 1024; // APP1 sits right after SOI; 64 KB is its max size.
  // ponytail: 2 minutes of clock skew between the camera's clock and the server's prompt time.
  const CLOCK_SKEW_MS = 2 * 60 * 1000;

  // "YYYY:MM:DD HH:MM:SS" (+ optional "+HH:MM" offset) -> epoch ms, or null. EXIF times carry no
  // zone, so without an offset they are read as this device's local time.
  function parseExifDate(text, offset) {
    const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(text || "").trim());
    if (!m) return null;
    const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
    if (!y || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
    const off = /^([+-])(\d{2}):(\d{2})$/.exec(String(offset || "").trim());
    if (off) {
      const mins = (off[1] === "-" ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3]));
      return Date.UTC(y, mo - 1, d, h, mi, s) - mins * 60000;
    }
    const t = new Date(y, mo - 1, d, h, mi, s).getTime();
    return Number.isFinite(t) ? t : null;
  }

  // Minimal JPEG APP1/TIFF reader: IFD0 plus the Exif sub-IFD, either byte order. Returns the
  // capture time (DateTimeOriginal, else DateTime) as epoch ms, or null when there is none.
  function readCaptureTime(input) {
    try {
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const len = bytes.length;
      if (len < 4 || view.getUint16(0) !== 0xffd8) return null; // not a JPEG
      let pos = 2;
      while (pos + 4 <= len) {
        if (bytes[pos] !== 0xff) return null;
        const marker = bytes[pos + 1];
        if (marker === 0xff) { pos += 1; continue; } // fill byte
        if (marker === 0xda || marker === 0xd9) return null; // image data starts: no EXIF
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
        const size = view.getUint16(pos + 2);
        if (size < 2) return null;
        if (marker === 0xe1 && pos + 10 <= len && String.fromCharCode(...bytes.subarray(pos + 4, pos + 10)) === "Exif\0\0") {
          const found = readTiff(view, pos + 10, Math.min(len, pos + 2 + size));
          if (found !== undefined) return found;
        }
        pos += 2 + size;
      }
      return null;
    } catch (err) {
      return null; // unreadable header: treat as "no capture time"
    }
  }

  // undefined = not a usable TIFF block (keep scanning); null = TIFF with no capture time.
  function readTiff(view, tiff, end) {
    const order = view.getUint16(tiff);
    if (order !== 0x4949 && order !== 0x4d4d) return undefined;
    const le = order === 0x4949;
    const u16 = (at) => (at + 2 <= end ? view.getUint16(at, le) : null);
    const u32 = (at) => (at + 4 <= end ? view.getUint32(at, le) : null);
    if (u16(tiff + 2) !== 42) return undefined;

    function readIfd(rel) {
      const tags = {};
      if (rel === null) return tags;
      const at = tiff + rel;
      const count = u16(at);
      if (count === null) return tags;
      for (let i = 0; i < count; i++) {
        const e = at + 2 + i * 12;
        if (e + 12 > end) break;
        const tag = u16(e);
        const type = u16(e + 2);
        const n = u32(e + 4);
        if (type === 2 && n > 0) {
          const start = n <= 4 ? e + 8 : tiff + (u32(e + 8) || 0);
          if (start + n > end) continue;
          let s = "";
          for (let k = 0; k < n; k++) {
            const c = view.getUint8(start + k);
            if (!c) break;
            s += String.fromCharCode(c);
          }
          tags[tag] = s;
        } else if (type === 4 && n === 1) {
          tags[tag] = u32(e + 8);
        }
      }
      return tags;
    }

    const ifd0 = readIfd(u32(tiff + 4));
    const exif = typeof ifd0[0x8769] === "number" ? readIfd(ifd0[0x8769]) : {};
    // DateTimeOriginal pairs with OffsetTimeOriginal; DateTime with OffsetTime (EXIF 2.31).
    if (exif[0x9003]) {
      const t = parseExifDate(exif[0x9003], exif[0x9011]);
      if (t !== null) return t;
    }
    return ifd0[0x0132] ? parseExifDate(ifd0[0x0132], exif[0x9010]) : null;
  }

  // True when the photo's own capture time is before the prompt (minus the skew allowance).
  function takenBeforePrompt(captureMs, momentAt, skewMs = CLOCK_SKEW_MS) {
    if (!Number.isFinite(captureMs) || !Number.isFinite(momentAt)) return false;
    return captureMs < momentAt - skewMs;
  }

  // Browser: read the first bytes of a picked File/Blob. Never rejects; null = no capture time.
  function fileCaptureTime(file) {
    if (!file || !file.slice) return Promise.resolve(null);
    const head = file.slice(0, EXIF_READ_BYTES);
    const read = head.arrayBuffer
      ? head.arrayBuffer()
      : new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => reject(r.error);
          r.readAsArrayBuffer(head);
        });
    return read.then(readCaptureTime, () => null);
  }

  const api = { CLOCK_SKEW_MS, parseExifDate, readCaptureTime, takenBeforePrompt, fileCaptureTime };
  if (root) root.CareNestMomentPhoto = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : null);

if (typeof window !== "undefined") (window.CareNestShift ? window.CareNestShift.ready : Promise.resolve(null)).then(function (shift) {
  const store = window.CareNestStore;
  const data = window.CareNestData;
  const page = document.body.dataset.page;
  if (!shift || !store || !data || (page !== "home" && page !== "messages")) return;
  if (document.body.dataset.role === "parent") return; // moments are the sitter's prompt
  if (!document.createElement("dialog").showModal) return;

  const parent = (data.parentName && data.parentName.split(/\s+/)[0]) || (data.contacts && data.contacts[0] && data.contacts[0].firstName) || "the parent";
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
  let pickSeq = 0; // only the latest picked file may set the photo or the error

  function formatLeft(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  function announce(text) {
    status.textContent = "";
    setTimeout(() => (status.textContent = text), 50);
  }

  function tick() {
    const m = shift.getMomentStatus();
    const due = m.state === "due";
    banner.hidden = !due;

    if (dialog.open && !shift.state.active) {
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
    const pct = Math.max(0, Math.min(100, (left / shift.MOMENT_WINDOW_MS) * 100));
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
    postBtn.disabled = next !== "review" || !shift.state.active;
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
    pickSeq++; // a pending upload no longer applies
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
    if (!shift.state.active) return;
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
    showError("");
    const pick = ++pickSeq;
    const momentAt = shift.getMomentStatus().momentAt;
    window.CareNestMomentPhoto.fileCaptureTime(file)
      .then((takenAt) => {
        if (pick !== pickSeq) return null;
        if (window.CareNestMomentPhoto.takenBeforePrompt(takenAt, momentAt)) {
          photoDataUrl = null;
          preview.removeAttribute("src");
          preview.hidden = true;
          retakeBtn.hidden = step === "upload"; // back to the in-page camera, if there is one
          if (step === "review") stepEl.textContent = ""; // no longer "Looks good?"
          postBtn.disabled = true;
          throw new Error(shift.errorMessage(new Error("moment_photo_too_early")));
        }
        return store.downscaleImage(file);
      })
      .then((dataUrl) => {
        if (dataUrl && pick === pickSeq) setPhoto(dataUrl);
      })
      .catch((err) => {
        if (pick === pickSeq) showError(err.message);
      });
  });
  postBtn.addEventListener("click", () => {
    if (!photoDataUrl) return;
    showError("");
    postBtn.disabled = true;
    postBtn.textContent = "Posting…";
    shift
      .postMoment({ dataUrl: photoDataUrl, body: captionEl.value })
      .then((result) => {
        dialog.close();
        // "Late" comes from the database, not from this page's clock.
        announce(`Moment shared with ${parent}${result.late ? " (marked Late)" : ""}.`);
      })
      .catch((err) => {
        showError(shift.errorMessage(err));
        postBtn.disabled = !shift.state.active;
      })
      .finally(() => {
        postBtn.textContent = `Post to ${parent}`;
      });
  });

  shift.subscribe(tick);
  tick();
  setInterval(tick, 1000);
});
