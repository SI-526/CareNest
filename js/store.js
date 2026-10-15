// CareNestStore — the single home for mutable app state (completions, messages, shift).
// ponytail: localStorage is the stand-in until Supabase. Rows below are shaped like the
// future tables (task_completions, messages, shifts) so the swap only touches this file.
(function () {
  const KEY = "carenest:v1";
  const MOMENT_WINDOW_MS = 2 * 60 * 1000;
  const listeners = new Set();

  class StoreError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code; // "quota" | "shift_ended"
    }
  }

  function emptyState() {
    return { completions: {}, messages: [], shift: null };
  }

  function read() {
    try {
      const parsed = JSON.parse(localStorage.getItem(KEY));
      if (parsed && typeof parsed === "object") {
        return Object.assign(emptyState(), parsed);
      }
    } catch (e) {
      /* corrupt or unavailable storage: fall through to a fresh state */
    }
    return emptyState();
  }

  function write(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      if (e && (e.name === "QuotaExceededError" || e.code === 22)) {
        throw new StoreError(
          "quota",
          "This device is out of storage space for CareNest, so this wasn't saved."
        );
      }
      throw e;
    }
    notify();
  }

  function notify() {
    listeners.forEach((fn) => fn());
  }

  // Fires for writes from other tabs (sitter tab + parent tab in one browser).
  window.addEventListener("storage", (e) => {
    if (e.key === KEY || e.key === null) notify();
  });

  function newId() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function newShift(now) {
    // BeReal-style prompt lands at a random 1–5 minutes after the shift starts (demo timing).
    const delay = (60 + Math.floor(Math.random() * 241)) * 1000;
    return { id: newId(), startedAt: now, endedAt: null, momentAt: now + delay };
  }

  function requireActiveShift(state) {
    if (!state.shift || state.shift.endedAt) {
      throw new StoreError(
        "shift_ended",
        "This shift has ended. Photos can't be added after a shift."
      );
    }
  }

  function isPhotoDataUrl(value) {
    return typeof value === "string" && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value);
  }

  const api = {
    StoreError,
    MOMENT_WINDOW_MS,
    isPhotoDataUrl,

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    // Starts a shift on first visit so the demo always has one in progress.
    getShift() {
      const state = read();
      if (!state.shift) {
        state.shift = newShift(Date.now());
        try {
          localStorage.setItem(KEY, JSON.stringify(state));
        } catch (e) {
          /* still return the in-memory shift */
        }
      }
      return state.shift;
    },

    isShiftActive() {
      return !api.getShift().endedAt;
    },

    endShift() {
      const state = read();
      if (!state.shift) state.shift = newShift(Date.now());
      if (!state.shift.endedAt) state.shift.endedAt = Date.now();
      write(state);
      return state.shift;
    },

    getCompletions() {
      return read().completions;
    },

    getCompletion(taskId) {
      return read().completions[taskId] || null;
    },

    completeTask({ taskId, photoDataUrl, note, tag }) {
      const state = read();
      requireActiveShift(state);
      if (!isPhotoDataUrl(photoDataUrl)) throw new Error("A photo is required.");
      const sentAt = Date.now();
      const completion = {
        taskId,
        photoDataUrl,
        note: note || "",
        tag: tag || "",
        sentAt,
        sender: "sitter",
      };
      state.completions[taskId] = completion;
      // The proof message points at the completion row (like a task_id FK) so the
      // photo is stored once.
      state.messages.push({ id: newId(), kind: "task_proof", taskId, sender: "sitter", sentAt });
      write(state);
      return completion;
    },

    getMessages() {
      return read().messages;
    },

    sendChat(body, sender = "sitter") {
      const text = String(body || "").trim();
      if (!text) return null;
      const state = read();
      const message = { id: newId(), kind: "chat", body: text, sender, sentAt: Date.now() };
      state.messages.push(message);
      write(state);
      return message;
    },

    // Moment = BeReal-style prompt. Pending while the shift is active, the prompt time
    // has passed, and nothing has been posted for this shift yet.
    getMomentStatus(now = Date.now()) {
      const state = read();
      const shift = state.shift;
      if (!shift || shift.endedAt) return { state: "none" };
      const posted = state.messages.some(
        (m) => m.kind === "moment" && m.shiftId === shift.id
      );
      if (posted) return { state: "posted" };
      if (now < shift.momentAt) return { state: "waiting", momentAt: shift.momentAt };
      const deadline = shift.momentAt + MOMENT_WINDOW_MS;
      return { state: "due", momentAt: shift.momentAt, deadline, late: now > deadline };
    },

    postMoment({ photoDataUrl, body }) {
      const state = read();
      requireActiveShift(state);
      if (!isPhotoDataUrl(photoDataUrl)) throw new Error("A photo is required.");
      const sentAt = Date.now();
      const message = {
        id: newId(),
        kind: "moment",
        body: String(body || "").trim(),
        photo: photoDataUrl,
        shiftId: state.shift.id,
        late: sentAt > state.shift.momentAt + MOMENT_WINDOW_MS,
        sender: "sitter",
        sentAt,
      };
      state.messages.push(message);
      write(state);
      return message;
    },

    // Dev-only helpers (UI shows them on localhost only).
    triggerMomentNow() {
      const state = read();
      if (!state.shift) state.shift = newShift(Date.now());
      state.shift.momentAt = Date.now();
      write(state);
    },

    resetShift() {
      const state = emptyState();
      state.shift = newShift(Date.now());
      write(state);
    },
  };

  // Downscale any image Blob to a JPEG data URL (longest side <= maxSide) so a shift's
  // worth of photos fits in localStorage's ~5MB.
  api.downscaleImage = function (blob, maxSide = 1280, quality = 0.82) {
    return loadImage(blob).then((img) => {
      const canvas = drawScaled(img, maxSide);
      if (img.close) img.close();
      return canvas.toDataURL("image/jpeg", quality);
    });
  };

  function loadImage(blob) {
    if (window.createImageBitmap) return createImageBitmap(blob);
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("That file isn't an image we can read."));
      };
      img.src = url;
    });
  }

  function drawScaled(source, maxSide) {
    const w = source.width || source.videoWidth;
    const h = source.height || source.videoHeight;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  api.drawScaled = drawScaled;
  api.loadImage = loadImage;

  window.CareNestStore = api;
})();
