// CareNestStore — the ?demo=1 backend (completions, messages, shift) in localStorage.
// Signed-in people use Supabase through js/shift-data.js; parent.js still reads this store until
// the parent side moves (T3b-2). The image helpers at the bottom are shared by both backends.
(function () {
  // The key is per person and chosen by the auth guard (js/auth.js): "carenest:v1:<user id>" or
  // "carenest:demo:v1". Until it is set (or when signed out) reads are empty and writes fail.
  // Pages without the guard (none ship today) fall back to the demo key.
  function storageKey() {
    const auth = window.CareNestAuth;
    return auth ? auth.storeKey : "carenest:demo:v1";
  }
  const MOMENT_WINDOW_MS = 2 * 60 * 1000;
  const listeners = new Set();

  class StoreError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code; // "quota" | "shift_ended" | "task_not_completed"
    }
  }

  function emptyState() {
    // reads/saves/insights are keyed by message id; each value is shaped like a future row
    // (message_reads, saved_photos, photo_insights).
    // logs mirror care_logs rows (append-only; SI-28).
    return { completions: {}, messages: [], shift: null, reads: {}, saves: {}, insights: {}, logs: [] };
  }

  function read() {
    const key = storageKey();
    if (!key) return emptyState();
    try {
      const parsed = JSON.parse(localStorage.getItem(key));
      if (parsed && typeof parsed === "object") {
        return Object.assign(emptyState(), parsed);
      }
    } catch (e) {
      /* corrupt or unavailable storage: fall through to a fresh state */
    }
    return emptyState();
  }

  function write(state) {
    const key = storageKey();
    if (!key) throw new Error("Please sign in again.");
    try {
      localStorage.setItem(key, JSON.stringify(state));
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
    if (e.key === null || e.key === storageKey()) notify();
  });

  function newId() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function newShift(now) {
    // BeReal-style prompt lands at a random 1–5 minutes after the shift starts (demo timing).
    const delay = (60 + Math.floor(Math.random() * 241)) * 1000;
    return { id: newId(), startedAt: now, endedAt: null, momentAt: now + delay, events: [] };
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

  function isPhotoMessage(state, id) {
    return state.messages.some(
      (m) => m.id === id && (m.kind === "task_proof" || m.kind === "moment")
    );
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
          if (storageKey()) localStorage.setItem(storageKey(), JSON.stringify(state));
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
      if (!state.shift.endedAt) {
        state.shift.endedAt = Date.now();
        state.shift.events = (state.shift.events || []).concat({ kind: "ended", at: state.shift.endedAt });
      }
      write(state);
      return state.shift;
    },

    // Demo mirror of reopen_visit(): history is kept, the end is cleared.
    reopenShift() {
      const state = read();
      if (!state.shift || !state.shift.endedAt) return;
      state.shift.events = (state.shift.events || []).concat({ kind: "reopened", at: Date.now() });
      state.shift.endedAt = null;
      write(state);
    },

    // Demo mirror of an uncheck; logged when it removes an original-shift check after a reopen.
    uncheckTask(taskId, taskTitle) {
      const state = read();
      requireActiveShift(state);
      const completion = state.completions[taskId];
      if (!completion) return;
      const events = state.shift.events || [];
      const ends = events.filter((e) => e.kind === "ended").map((e) => e.at);
      if (ends.length && events.some((e) => e.kind === "reopened") && completion.sentAt <= Math.min.apply(null, ends)) {
        state.shift.events = events.concat({ kind: "unchecked", at: Date.now(), taskTitle });
      }
      delete state.completions[taskId];
      write(state);
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

    // Care logs: demo mirror of care_logs. Allowed on an open or ended shift (the demo shift is
    // always in the date window), only for a task checked in it. Never edited or deleted.
    getLogs() {
      return read().logs || [];
    },

    addCareLog({ taskId, category, note, mealAmount, bottleOz, author }) {
      const state = read();
      if (!state.shift) state.shift = newShift(Date.now());
      if (!state.completions[taskId]) {
        throw new StoreError("task_not_completed", "Complete this task before adding details.");
      }
      const log = {
        id: newId(),
        shiftId: state.shift.id,
        taskId,
        category,
        note: note || "",
        mealAmount: mealAmount || null,
        bottleOz: bottleOz == null ? null : bottleOz,
        author: author === "parent" ? "parent" : "sitter",
        createdAt: Date.now(),
      };
      state.logs = (state.logs || []).concat(log);
      write(state);
      return log;
    },

    // replyTo = id of the task_proof/moment message being replied to (a reply_to FK).
    sendChat(body, sender = "sitter", replyTo = null) {
      const text = String(body || "").trim();
      if (!text) return null;
      const state = read();
      const message = { id: newId(), kind: "chat", body: text, sender, sentAt: Date.now() };
      if (replyTo) {
        if (!isPhotoMessage(state, replyTo)) throw new Error("That photo is no longer available.");
        message.replyTo = replyTo;
      }
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

    // Photo message (gallery "+"): a sitter's chat message with a photo; the caption may be empty.
    postPhoto({ photoDataUrl, body }) {
      const state = read();
      requireActiveShift(state);
      if (!isPhotoDataUrl(photoDataUrl)) throw new Error("A photo is required.");
      const message = {
        id: newId(),
        kind: "chat",
        body: String(body || "").trim(),
        photo: photoDataUrl,
        shiftId: state.shift.id,
        sender: "sitter",
        sentAt: Date.now(),
      };
      state.messages.push(message);
      write(state);
      return message;
    },

    // Parent read receipts: messageId -> { messageId, reader, seenAt }.
    getReads() {
      return read().reads;
    },

    markSeen(messageIds, reader = "parent") {
      const state = read();
      const seenAt = Date.now();
      let changed = false;
      messageIds.forEach((id) => {
        if (state.reads[id] || !isPhotoMessage(state, id)) return;
        state.reads[id] = { messageId: id, reader, seenAt };
        changed = true;
      });
      if (changed) write(state);
    },

    // Parent album: messageId -> { messageId, savedBy, savedAt }.
    getSaves() {
      return read().saves;
    },

    savePhoto(messageId, savedBy = "parent") {
      const state = read();
      if (!isPhotoMessage(state, messageId)) throw new Error("That photo is no longer available.");
      state.saves[messageId] = { messageId, savedBy, savedAt: Date.now() };
      write(state);
    },

    unsavePhoto(messageId) {
      const state = read();
      if (!state.saves[messageId]) return;
      delete state.saves[messageId];
      write(state);
    },

    // Concept-only "insight" on a photo. source is always "concept_demo": nothing analyses
    // the image; a demo control sets the text by hand.
    getInsights() {
      return read().insights;
    },

    setConceptAlert(messageId, text) {
      const state = read();
      if (!isPhotoMessage(state, messageId)) return;
      state.insights[messageId] = {
        messageId,
        text: String(text),
        source: "concept_demo",
        createdAt: Date.now(),
      };
      write(state);
    },

    clearConceptAlerts() {
      const state = read();
      state.insights = {};
      write(state);
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

  // Same downscale, as a JPEG Blob for upload to Storage.
  api.downscaleImageBlob = function (blob, maxSide = 1280, quality = 0.82) {
    return loadImage(blob).then((img) => {
      const canvas = drawScaled(img, maxSide);
      if (img.close) img.close();
      return new Promise((resolve, reject) => {
        canvas.toBlob(
          (out) => (out ? resolve(out) : reject(new Error("That photo couldn't be prepared. Try another."))),
          "image/jpeg",
          quality
        );
      });
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
