// Parent home (parent.html): the child's day at a glance, a live photo feed of task proofs
// and moments, replies, saving photos, and an album of saved photos.
// ponytail: same localStorage store as the sitter side; a sitter tab and a parent tab in one
// browser stay in sync through the store's `storage` event until the real backend lands.
// Waits for the auth guard (js/auth.js), which fills in real names first.
((window.CareNestFamily || window.CareNestAuth) ? (window.CareNestFamily || window.CareNestAuth).ready : Promise.resolve()).then(function () {
  const data = window.CareNestData;
  const store = window.CareNestStore;
  const ui = window.CareNestUI;
  if (!data || !store || !ui || document.body.dataset.page !== "parent") return;

  const { escapeHtml, announce, formatTime, senderName, photoTitle, photoImg } = ui;
  const sitterName = data.babysitter.name;
  const childFirst = data.child.name.split(" ")[0];
  const parentContact = (data.contacts && data.contacts[0]) || {};
  const CONCEPT_TEXT = `${childFirst} seems a little tired in this photo.`;
  const SEEN_AFTER_MS = 1500;

  const list = document.getElementById("feed-list");
  const empty = document.getElementById("feed-empty");
  const banner = document.getElementById("new-photo-banner");
  const bannerText = document.getElementById("new-photo-text");
  const bannerLink = document.getElementById("new-photo-link");
  const title = document.getElementById("parent-title");

  const entries = new Map(); // message id -> { li, article, body, sig, refs }
  let knownIds = null;
  let pendingNew = [];
  let lastShiftEnded = null;
  let view = "today";
  view = viewFromHash();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const coarsePointer = window.matchMedia("(pointer: coarse)");

  document.getElementById("parent-greeting").textContent = `Hi ${data.viewerFirstName || parentContact.firstName || "there"}`;
  const avatar = document.getElementById("parent-child-avatar");
  // Only the demo family has a child photo; signed in there is none yet, so none is shown.
  if (data.child.avatar) {
    avatar.src = data.child.avatar;
    avatar.hidden = false;
  }
  // A new family has nothing for the sitter yet: point the parent at Family info.
  if (data.isEmpty) {
    document.querySelector(".parent-header").insertAdjacentHTML(
      "afterend",
      `<p class="auth-status setup-nudge">Your sitter will see your child's schedule, care info, allergies, and emergency contacts once you add them. <a href="manage.html">Add family info</a></p>`
    );
  }

  // ---------- data ----------

  function photoItems() {
    const completions = store.getCompletions();
    return store
      .getMessages()
      .filter((m) => m.kind === "task_proof" || m.kind === "moment")
      .map((m) => {
        if (m.kind === "moment") {
          return {
            id: m.id,
            kind: "moment",
            title: "Moment",
            taskTime: "",
            photo: m.photo,
            tag: "",
            note: m.body || "",
            late: Boolean(m.late),
            sender: m.sender,
            sentAt: m.sentAt,
          };
        }
        const completion = completions[m.taskId] || {};
        const task = data.schedule.find((s) => s.id === m.taskId);
        return {
          id: m.id,
          kind: "task_proof",
          title: photoTitle(m),
          taskTime: task ? task.time : "",
          photo: completion.photoDataUrl,
          tag: completion.tag || "",
          note: completion.note || "",
          late: false,
          sender: m.sender,
          sentAt: m.sentAt,
        };
      })
      .filter((item) => store.isPhotoDataUrl(item.photo))
      .sort((a, b) => b.sentAt - a.sentAt);
  }

  function repliesFor(id, messages) {
    return messages.filter((m) => m.kind === "chat" && m.replyTo === id);
  }

  // ---------- time ----------

  function relativeTime(ms, now = Date.now()) {
    const diff = Math.max(0, now - ms);
    const min = Math.round(diff / 60000);
    if (diff < 45000) return "just now";
    if (min < 60) return `${min} min ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr} hr ago`;
    return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function timeHtml(ms) {
    const iso = new Date(ms).toISOString();
    const full = new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    return `<time datetime="${iso}" title="${escapeHtml(full)}"><span data-rel="${ms}">${escapeHtml(relativeTime(ms))}</span> · ${escapeHtml(formatTime(ms))}</time>`;
  }

  function refreshRelativeTimes() {
    const now = Date.now();
    list.querySelectorAll("[data-rel]").forEach((el) => {
      el.textContent = relativeTime(Number(el.dataset.rel), now);
    });
  }

  // ---------- view ----------

  function viewFromHash() {
    if (window.location.hash === "#album") return "album";
    if (window.location.hash.startsWith("#item-")) return view;
    return "today";
  }

  function render() {
    const messages = store.getMessages();
    const items = photoItems();
    const saves = store.getSaves();
    const reads = store.getReads();
    const insights = store.getInsights();

    renderStatus();
    renderChrome();

    const visible = view === "album" ? items.filter((i) => saves[i.id]) : items;
    const visibleIds = new Set(visible.map((i) => i.id));

    entries.forEach((entry, id) => {
      if (!visibleIds.has(id)) {
        observer.unobserve(entry.article);
        entry.li.remove();
        entries.delete(id);
      }
    });

    visible.forEach((item, index) => {
      let entry = entries.get(item.id);
      if (!entry) {
        entry = createEntry(item);
        entries.set(item.id, entry);
        observer.observe(entry.article);
      }
      // Only move nodes that are out of place so focus inside them is kept.
      if (list.children[index] !== entry.li) list.insertBefore(entry.li, list.children[index] || null);
      updateEntry(entry, item, {
        isNew: !reads[item.id],
        saved: Boolean(saves[item.id]),
        insight: insights[item.id] || null,
        replies: repliesFor(item.id, messages),
      });
    });

    empty.hidden = visible.length > 0;
    empty.querySelector("p").textContent =
      view === "album"
        ? "No saved photos yet. Use “Save photo” on any photo to keep it here."
        : `No photos yet. When ${sitterName} finishes a task or shares a moment, it shows up here.`;

    detectNew(items);
  }

  function renderChrome() {
    const current = view === "album" ? "album" : "today";
    document.querySelectorAll(".primary-nav [data-nav]").forEach((link) => {
      if (link.dataset.nav === current) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    const heading = view === "album" ? "Saved photos" : `${childFirst}'s day`;
    title.textContent = heading;
    document.title = `CareNest — ${heading}`;
    document.getElementById("feed-heading").textContent =
      view === "album" ? "Album" : "Photos";
    document.getElementById("day-status").hidden = view === "album";
  }

  function renderStatus() {
    const shift = store.getShift();
    const ended = Boolean(shift.endedAt);
    document.getElementById("day-status-title").textContent = ended
      ? `${sitterName}'s shift has ended`
      : `${sitterName} is with ${childFirst}`;
    document.getElementById("day-status-detail").textContent = ended
      ? `Ended at ${formatTime(shift.endedAt)} · started ${formatTime(shift.startedAt)}`
      : `In progress since ${formatTime(shift.startedAt)}`;
    const pill = document.getElementById("day-status-pill");
    pill.textContent = ended ? "Ended" : "Active";
    pill.className = `status-pill ${ended ? "is-ended" : "is-active"}`;

    const completions = store.getCompletions();
    const total = data.schedule.length;
    const done = data.schedule.filter((s) => completions[s.id]).length;
    document.getElementById("day-progress-count").textContent = `${done} of ${total} tasks done`;
    const progress = document.getElementById("day-progress");
    progress.max = total || 1;
    progress.value = done;

    if (lastShiftEnded === false && ended) {
      announce(`${sitterName} ended the shift at ${formatTime(shift.endedAt)}.`);
    }
    lastShiftEnded = ended;
  }

  // ---------- feed items ----------

  function createEntry(item) {
    const id = escapeHtml(item.id);
    const li = document.createElement("li");
    li.className = "feed-item";
    li.innerHTML = `
      <article class="msg-card feed-card${item.kind === "moment" ? " moment-card" : ""}" id="item-${id}" tabindex="-1" aria-labelledby="item-${id}-title">
        <div class="feed-body"></div>
        <div class="feed-actions">
          <button type="button" class="photo-source-btn" data-reply aria-expanded="false" aria-controls="reply-${id}">Reply</button>
          <button type="button" class="primary-btn feed-save" data-save>Save photo</button>
        </div>
        <div class="feed-album-row" data-album-row hidden>
          <span class="tag-chip album-chip">In your album</span>
          <button type="button" class="text-btn" data-unsave>Remove from album</button>
        </div>
        <p class="feed-status" data-status hidden></p>
        <form class="feed-reply-form" id="reply-${id}" data-reply-form novalidate hidden>
          <label class="feed-reply-label" for="reply-input-${id}"></label>
          <div class="message-form">
            <input class="complete-note message-input" id="reply-input-${id}" type="text" maxlength="1000" autocomplete="off" enterkeyhint="send" />
            <button type="submit" class="primary-btn message-send">Send</button>
            <p class="photo-upload-error message-error" data-reply-error role="alert" hidden></p>
          </div>
        </form>
      </article>`;
    const article = li.querySelector("article");
    const entry = {
      id: item.id,
      li,
      article,
      body: li.querySelector(".feed-body"),
      sig: "",
      item,
      refs: {
        replyBtn: li.querySelector("[data-reply]"),
        saveBtn: li.querySelector("[data-save]"),
        albumRow: li.querySelector("[data-album-row]"),
        unsaveBtn: li.querySelector("[data-unsave]"),
        status: li.querySelector("[data-status]"),
        form: li.querySelector("[data-reply-form]"),
        input: li.querySelector("input"),
        error: li.querySelector("[data-reply-error]"),
        label: li.querySelector("label"),
      },
    };
    entry.refs.label.textContent = `Reply to ${sitterName} about this photo`;
    entry.refs.input.placeholder = `Reply to ${sitterName}`;
    entry.refs.saveBtn.setAttribute("aria-label", `Save photo: ${item.title}`);

    entry.refs.replyBtn.addEventListener("click", () => toggleReply(entry));
    entry.refs.form.addEventListener("submit", (e) => {
      e.preventDefault();
      sendReply(entry);
    });
    entry.refs.form.addEventListener("keydown", (e) => {
      if (e.key === "Escape") toggleReply(entry, false);
    });
    entry.refs.saveBtn.addEventListener("click", () => savePhoto(entry));
    entry.refs.unsaveBtn.addEventListener("click", () => {
      const inAlbum = view === "album";
      store.unsavePhoto(entry.id);
      announce(`${entry.item.title} photo removed from your album.`);
      if (inAlbum) title.focus();
      else entry.refs.saveBtn.focus();
    });
    return entry;
  }

  function updateEntry(entry, item, state) {
    entry.item = item;
    const sig = JSON.stringify([
      item.title,
      item.taskTime,
      item.photo.length,
      item.tag,
      item.note,
      item.late,
      item.sentAt,
      state.isNew,
      state.insight && state.insight.text,
      state.replies.map((r) => r.id),
    ]);
    if (sig !== entry.sig) {
      entry.sig = sig;
      entry.body.innerHTML = bodyHtml(item, state);
    }
    entry.refs.albumRow.hidden = !state.saved;
  }

  function bodyHtml(item, state) {
    const id = escapeHtml(item.id);
    const kicker =
      item.kind === "moment"
        ? `Live moment${item.late ? ` <span class="late-badge">Late</span>` : ""}`
        : `<img src="assets/check.svg" alt="" width="16" height="16" /> Task completed`;
    const newBadge = state.isNew ? `<span class="new-badge">New</span>` : "";
    const concept = state.insight
      ? `<div class="concept-alert" role="note" aria-label="Concept alert, not real analysis">
          <p class="concept-label">Concept — not real analysis</p>
          <p class="concept-text">${escapeHtml(state.insight.text)}</p>
        </div>`
      : "";
    const replies = state.replies.length
      ? `<ol class="feed-replies" aria-label="Replies">
          ${state.replies
            .map(
              (r) => `
            <li class="feed-reply${r.sender === "parent" ? " is-parent" : ""}">
              <p class="feed-reply-body">${escapeHtml(r.body)}</p>
              <p class="msg-meta">${escapeHtml(senderName(r.sender))} · ${timeHtml(r.sentAt)}</p>
            </li>`
            )
            .join("")}
        </ol>`
      : "";
    return `
      <p class="msg-card-kicker">${kicker}${newBadge}</p>
      <h3 class="msg-card-title" id="item-${id}-title">${escapeHtml(item.title)}${item.taskTime ? ` <span class="msg-card-time">${escapeHtml(item.taskTime)}</span>` : ""}</h3>
      ${photoImg(item.photo, `Photo from ${sitterName}: ${item.title}`, "msg-photo feed-photo")}
      ${concept}
      ${item.tag ? `<p class="tag-chip">${escapeHtml(item.tag)}</p>` : ""}
      ${item.note ? `<p class="msg-card-note">${escapeHtml(item.note)}</p>` : ""}
      <p class="msg-meta">${escapeHtml(senderName(item.sender))} · ${timeHtml(item.sentAt)}</p>
      ${replies}`;
  }

  // ---------- reply ----------

  function toggleReply(entry, open) {
    const { form, replyBtn, input, error } = entry.refs;
    const show = typeof open === "boolean" ? open : form.hidden;
    form.hidden = !show;
    replyBtn.setAttribute("aria-expanded", String(show));
    error.hidden = true;
    if (show) input.focus();
    else replyBtn.focus();
  }

  function sendReply(entry) {
    const { input, error } = entry.refs;
    error.hidden = true;
    try {
      const sent = store.sendChat(input.value, "parent", entry.id);
      if (!sent) {
        error.textContent = "Type a reply first.";
        error.hidden = false;
        input.focus();
        return;
      }
      input.value = "";
      toggleReply(entry, false);
      announce(`Reply sent to ${sitterName}.`);
    } catch (err) {
      error.textContent = (err && err.message) || "Reply not sent. Please try again.";
      error.hidden = false;
    }
  }

  // ---------- save ----------

  // Synchronous on purpose: iOS Safari only opens the share sheet if navigator.share is
  // called directly inside the tap (no awaited fetch first).
  function dataUrlToBlob(dataUrl) {
    const [head, b64] = dataUrl.split(",");
    const type = head.slice(5, head.indexOf(";"));
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  function fileName(item, type) {
    const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const d = new Date(item.sentAt);
    const pad = (n) => String(n).padStart(2, "0");
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
    return `carenest-${slug(childFirst)}-${slug(item.title)}-${date}.${ext}`;
  }

  function setStatus(entry, text, isError) {
    const { status } = entry.refs;
    status.textContent = text;
    status.classList.toggle("is-error", Boolean(isError));
    status.hidden = !text;
    announce(text);
  }

  function markSaved(entry) {
    try {
      store.savePhoto(entry.id);
      return true;
    } catch (err) {
      setStatus(entry, (err && err.message) || "Couldn't add this photo to your album.", true);
      return false;
    }
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function savePhoto(entry) {
    const item = entry.item;
    let blob;
    try {
      blob = dataUrlToBlob(item.photo);
    } catch (e) {
      setStatus(entry, "This photo couldn't be prepared for saving.", true);
      return;
    }
    const name = fileName(item, blob.type);
    const file = new File([blob], name, { type: blob.type });

    // Phones: the share sheet offers "Save Image" (iOS Photos). Desktop: plain download.
    const canShareFile =
      coarsePointer.matches && navigator.canShare && navigator.canShare({ files: [file] });
    if (canShareFile) {
      navigator
        .share({ files: [file] })
        .then(() => {
          // The share sheet can't tell us which option was picked, so don't claim "saved".
          if (markSaved(entry)) {
            setStatus(entry, "Shared. If you chose Save Image, it's in your Photos. Added to your album.");
          }
        })
        .catch((err) => {
          if (err && err.name === "AbortError") {
            setStatus(entry, "Not saved — the share sheet was closed.");
            return;
          }
          download(blob, name);
          if (markSaved(entry)) setStatus(entry, "Photo saved to your downloads and your album.");
        });
      return;
    }

    download(blob, name);
    if (markSaved(entry)) setStatus(entry, "Photo saved to your downloads and your album.");
  }

  // ---------- live "new photo" alert ----------

  function detectNew(items) {
    if (!knownIds) {
      knownIds = new Set(items.map((i) => i.id));
      return;
    }
    const fresh = items.filter((i) => !knownIds.has(i.id));
    if (!fresh.length) return;
    fresh.forEach((i) => knownIds.add(i.id));
    pendingNew = fresh.map((i) => i.id).concat(pendingNew);
    bannerText.textContent =
      pendingNew.length > 1
        ? `${pendingNew.length} new photos from ${sitterName}`
        : `New photo from ${sitterName}`;
    bannerLink.href = `#item-${pendingNew[0]}`;
    bannerLink.setAttribute("aria-label", `View new photo: ${fresh[0].title}`);
    banner.hidden = false;
    announce(`New photo from ${sitterName}: ${fresh[0].title}.`);
  }

  function hideBanner() {
    banner.hidden = true;
    pendingNew = [];
  }

  bannerLink.addEventListener("click", (e) => {
    e.preventDefault();
    const id = pendingNew[0];
    hideBanner();
    if (view === "album" && !store.getSaves()[id]) {
      history.replaceState(null, "", "#today");
      view = "today";
      render();
    }
    const entry = entries.get(id);
    if (!entry) return;
    entry.article.scrollIntoView({
      behavior: reducedMotion.matches ? "auto" : "smooth",
      block: "start",
    });
    entry.article.focus({ preventScroll: true });
  });

  document.getElementById("new-photo-dismiss").addEventListener("click", () => {
    hideBanner();
    title.focus();
  });

  // ---------- "New" marker: seen after the item has been on screen for a moment ----------

  const timers = new Map();
  const onScreen = new Set();

  function scheduleSeen(id) {
    if (timers.has(id) || document.visibilityState !== "visible") return;
    timers.set(
      id,
      window.setTimeout(() => {
        timers.delete(id);
        if (onScreen.has(id) && document.visibilityState === "visible") store.markSeen([id]);
      }, SEEN_AFTER_MS)
    );
  }

  const observer =
    "IntersectionObserver" in window
      ? new IntersectionObserver(
          (records) => {
            records.forEach((r) => {
              const id = r.target.id.replace(/^item-/, "");
              // Half the card, or (for tall cards) a good chunk of the screen.
              const enough =
                r.isIntersecting &&
                (r.intersectionRatio >= 0.5 ||
                  r.intersectionRect.height >= window.innerHeight * 0.4);
              if (enough) {
                onScreen.add(id);
                scheduleSeen(id);
              } else {
                onScreen.delete(id);
                window.clearTimeout(timers.get(id));
                timers.delete(id);
              }
            });
          },
          { threshold: [0, 0.25, 0.5, 0.75, 1] }
        )
      : { observe() {}, unobserve() {} };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onScreen.forEach(scheduleSeen);
  });

  // ---------- demo tools ----------

  function renderDevTools() {
    if (!ui.isDevHost) return;
    const box = document.createElement("section");
    box.className = "panel dev-tools";
    box.setAttribute("aria-labelledby", "parent-dev-heading");
    box.innerHTML = `
      <h2 class="panel-title" id="parent-dev-heading">Demo tools (not part of the product)</h2>
      <div class="dev-tools-actions">
        <a class="photo-source-btn dev-link" href="index.html" target="_blank" rel="noopener">Open sitter view<span class="visually-hidden"> (opens in a new tab)</span></a>
        <button type="button" class="photo-source-btn" data-dev="concept">Concept: flag newest photo as “tired”</button>
        <button type="button" class="photo-source-btn" data-dev="clear">Clear concept alerts</button>
      </div>`;
    box.querySelector('[data-dev="concept"]').addEventListener("click", () => {
      const newest = photoItems()[0];
      if (!newest) {
        announce("There are no photos to flag yet.");
        return;
      }
      store.setConceptAlert(newest.id, CONCEPT_TEXT);
      announce(`Concept alert added to ${newest.title}. Not real analysis.`);
    });
    box.querySelector('[data-dev="clear"]').addEventListener("click", () => {
      store.clearConceptAlerts();
      announce("Concept alerts cleared.");
    });
    document.querySelector(".parent-main").appendChild(box);
  }

  window.addEventListener("hashchange", () => {
    const next = viewFromHash();
    if (next === view) return;
    view = next;
    render();
  });

  ui.renderParentNav(view);
  renderDevTools();
  store.subscribe(render);
  render();
  window.setInterval(refreshRelativeTimes, 30000);
});
