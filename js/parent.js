// Parent home (parent.html): today's shift at a glance (status, progress, schedule with no-photo
// check-off, end/reopen), a live feed of this shift's proofs and moments, replies, saving photos,
// removing photos, and an album of saved photos.
// Data comes from js/shift-data.js (CareNestShift): Supabase when signed in, js/store.js in demo.
// Realtime there refetches; this file diffs each new state to raise in-app alerts.
(function () {
  const ui = window.CareNestUI;
  const auth = window.CareNestAuth;
  if (!ui || !window.CareNestShift || document.body.dataset.page !== "parent") return;

  window.CareNestShift.ready.then(init, (err) => console.error("CareNest: parent page failed", err));

  function init(shift) {
    const data = window.CareNestData;
    const { escapeHtml, announce, formatTime, shortTime } = ui;
    // Read live: js/family-data.js replaces these when a parent's edits arrive (issue #11).
    const sitterName = () => data.babysitter.name;
    const childFirst = () => data.child.name.split(" ")[0];
    const parentContact = () => (data.contacts && data.contacts[0]) || {};
    const SEEN_AFTER_MS = 1500;

    const list = document.getElementById("feed-list");
    const empty = document.getElementById("feed-empty");
    const banner = document.getElementById("new-photo-banner");
    const bannerText = document.getElementById("new-photo-text");
    const bannerLink = document.getElementById("new-photo-link");
    const title = document.getElementById("parent-title");
    const pageError = document.getElementById("parent-error");
    const taskList = document.getElementById("parent-task-list");
    const endBtn = document.getElementById("parent-end-shift");
    const reopenBtn = document.getElementById("parent-reopen-shift");

    const entries = new Map(); // message id -> { li, article, body, sig, refs, item }
    let known = null; // what the previous state held, for alerts: { feed:Set, events:Set, visitId }
    let pendingNew = []; // new feed photos (proofs, moments) the banner's View scrolls to
    let pendingMessagePhotos = 0; // new photo messages: not in the feed, so View opens the Gallery
    let view = viewFromHash("today");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const coarsePointer = window.matchMedia("(pointer: coarse)");

    function renderHeader() {
      document.getElementById("parent-greeting").textContent =
        `Hi ${data.viewerFirstName || parentContact().firstName || "there"}`;
      const avatar = document.getElementById("parent-child-avatar");
      // Only the demo family has a child photo; signed in there is none yet, so none is shown.
      if (data.child.avatar) {
        avatar.src = data.child.avatar;
        avatar.hidden = false;
      }
      // A new family has nothing for the sitter yet: point the parent at Family info.
      const nudge = document.querySelector(".setup-nudge");
      if (data.isEmpty && !nudge) {
        document.querySelector(".parent-header").insertAdjacentHTML(
          "afterend",
          `<p class="auth-status setup-nudge">Your sitter will see your child's schedule, care info, allergies, and emergency contacts once you add them. <a href="manage.html">Add family info</a></p>`
        );
      } else if (!data.isEmpty && nudge) nudge.remove();
    }
    renderHeader();

    function showError(text) {
      pageError.textContent = text || "";
      pageError.hidden = !text;
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

    function viewFromHash(current) {
      if (window.location.hash === "#album") return "album";
      if (window.location.hash.startsWith("#item-")) return current;
      return "today";
    }

    function render() {
      const st = shift.state;
      renderChrome();
      if (st.loadError) showError(st.loadError);
      renderStatus(st);
      renderSchedule(st);
      renderCareLog(st);

      const items = view === "album" ? st.album : st.feed;
      const visibleIds = new Set(items.map((i) => i.id));
      entries.forEach((entry, id) => {
        if (!visibleIds.has(id)) {
          observer.unobserve(entry.article);
          entry.li.remove();
          entries.delete(id);
        }
      });
      items.forEach((item, index) => {
        let entry = entries.get(item.id);
        if (!entry) {
          entry = createEntry(item);
          entries.set(item.id, entry);
          observer.observe(entry.article);
        }
        // Only move nodes that are out of place so focus inside them is kept.
        if (list.children[index] !== entry.li) list.insertBefore(entry.li, list.children[index] || null);
        updateEntry(entry, item, {
          isNew: !item.mine && !st.reads.has(item.id),
          saved: Boolean(st.saves[item.id]),
          flag: st.flags[item.id] || null,
          replies: st.thread.filter((m) => m.kind === "chat" && m.replyTo === item.id),
        });
      });

      empty.hidden = items.length > 0;
      empty.querySelector("p").textContent =
        view === "album"
          ? "No saved photos yet. Use “Save photo” on any photo to keep it here."
          : `No photos from this shift yet. When ${sitterName()} finishes a task or shares a moment, it shows up here.`;

      detectChanges(st);
    }

    function renderChrome() {
      const current = view === "album" ? "album" : "today";
      document.querySelectorAll(".primary-nav [data-nav]").forEach((link) => {
        if (link.dataset.nav === current) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
      });
      const heading = view === "album" ? "Saved photos" : `${childFirst()}'s day`;
      title.textContent = heading;
      document.title = `CareNest — ${heading}`;
      document.getElementById("feed-heading").textContent = view === "album" ? "Album" : "Photos";
      document.getElementById("day-status").hidden = view === "album";
      document.getElementById("parent-schedule").hidden = view === "album";
      document.getElementById("parent-care-log").hidden = view === "album";
    }

    // SI-28/SI-36: read-only care log, completed tasks in check-time order with the sitter's
    // details under each (js/care-log.js escapes every user-written field).
    function renderCareLog(st) {
      const el = document.getElementById("parent-care-log-list");
      const careLog = window.CareNestCareLog;
      if (!el || !careLog) return;
      const live = st.visit && !st.canStart;
      el.innerHTML = careLog.timelineHtml(live ? st : { checks: {}, logs: [] }, { canAdd: false, schedule: data.schedule });
    }

    // not started / active / reopened / ended
    function shiftPhase(st) {
      if (!st.visit || st.canStart) return "idle";
      if (st.active) return st.events.some((e) => e.kind === "reopened") ? "reopened" : "active";
      return "ended";
    }

    function historyLine(st) {
      const v = st.visit;
      const parts = [`Started ${shortTime(v.startedAt)} by ${v.startedByName}`];
      st.events
        .filter((e) => e.kind !== "unchecked")
        .forEach((e) => parts.push(`${e.kind} ${shortTime(e.at)} by ${e.actorName}`));
      st.events
        .filter((e) => e.kind === "unchecked")
        .forEach((e) => parts.push(`${e.actorName} unchecked ${e.taskTitle || "a task"} at ${shortTime(e.at)}`));
      return parts.join(" · ");
    }

    function renderStatus(st) {
      const phase = shiftPhase(st);
      const pill = document.getElementById("day-status-pill");
      const titleEl = document.getElementById("day-status-title");
      const detail = document.getElementById("day-status-detail");
      const labels = { idle: "Not started", active: "Active", reopened: "Reopened", ended: "Ended" };
      pill.textContent = labels[phase];
      pill.className = `status-pill is-${phase === "ended" ? "ended" : phase === "idle" ? "idle" : phase === "reopened" ? "reopened" : "active"}`;
      if (phase === "idle") {
        titleEl.textContent = st.noPlan
          ? "No schedule yet"
          : `${sitterName()} hasn't started today's shift`;
        detail.textContent = st.noPlan
          ? "Add tasks in Family info so your sitter can start a shift."
          : "You'll see it here as soon as the shift starts.";
      } else {
        titleEl.textContent =
          phase === "ended" ? "The shift has ended" : `${st.visit.startedByName} is with ${childFirst()}`;
        detail.textContent = historyLine(st);
      }

      const { total, done } = progress(st);
      document.getElementById("day-progress-count").textContent = `${done} of ${total} done`;
      const bar = document.getElementById("day-progress");
      bar.max = total || 1;
      bar.value = done;

      endBtn.hidden = !st.active || shift.demo;
      reopenBtn.hidden = !st.canReopen || shift.demo;
    }

    // Today's tasks plus any archived task checked this shift (shown from its snapshot).
    function scheduleRows(st) {
      const rows = data.schedule.map((t) => ({ id: t.id, title: t.title, time: t.time || "", check: st.checks[t.id] || null }));
      Object.values(st.checks).forEach((c) => {
        if (!rows.some((r) => r.id === c.taskId)) {
          rows.push({ id: c.taskId, title: c.snapshot.title, time: c.snapshot.time, check: c });
        }
      });
      return rows;
    }

    function progress(st) {
      const rows = st.visit && !st.canStart ? scheduleRows(st) : data.schedule;
      return { total: rows.length, done: rows.filter((r) => r.check).length };
    }

    function checkMeta(check) {
      const parts = [];
      if (check.afterReopen) parts.push(`<span class="reopen-badge">Added after reopen</span>`);
      if (!check.proof) parts.push(`<span>Done by ${escapeHtml(check.checkedByName)} · ${escapeHtml(shortTime(check.checkedAt))}</span>`);
      else if (check.proof.photoRemoved) {
        parts.push(`<span>Photo removed by ${escapeHtml(check.proof.photoRemovedByName || "a parent")}</span>`);
      } else {
        parts.push(`<span>Photo from ${escapeHtml(check.checkedByName)} · ${escapeHtml(shortTime(check.checkedAt))}</span>`);
      }
      return parts.join("");
    }

    function renderSchedule(st) {
      const live = st.visit && !st.canStart;
      const rows = live ? scheduleRows(st) : data.schedule.map((t) => ({ id: t.id, title: t.title, time: t.time || "", check: null }));
      const focusedId = document.activeElement && document.activeElement.dataset.check;
      if (!rows.length) {
        taskList.innerHTML = `<li class="parent-task"><p class="people-sub">No tasks yet. <a href="manage.html">Add tasks</a></p></li>`;
        return;
      }
      taskList.innerHTML = rows
        .map((r) => {
          const action =
            !r.check && st.active && !shift.demo
              ? `<button type="button" class="photo-source-btn parent-task-btn" data-check="${escapeHtml(r.id)}" aria-label="Mark ${escapeHtml(r.title)} done (no photo)">Mark done</button>`
              : "";
          return `<li class="parent-task${r.check ? " is-done" : ""}">
            <div class="parent-task-main">
              <p class="parent-task-title">${r.time ? `<span class="parent-task-time">${escapeHtml(r.time)}</span>` : ""}${escapeHtml(r.title)}</p>
              ${r.check ? `<p class="schedule-check-meta">${checkMeta(r.check)}</p>` : ""}
            </div>
            ${action}
          </li>`;
        })
        .join("");
      if (focusedId) {
        const again = taskList.querySelector(`[data-check="${CSS.escape(focusedId)}"]`);
        if (again) again.focus();
        else title.focus();
      }
    }

    taskList.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-check]");
      if (!btn) return;
      const taskId = btn.dataset.check;
      const task = data.schedule.find((t) => t.id === taskId);
      btn.disabled = true;
      showError("");
      try {
        await shift.checkTask(taskId);
        announce(`${task ? task.title : "Task"} marked done.`);
      } catch (err) {
        btn.disabled = false;
        showError(shift.errorMessage(err));
      }
    });

    async function shiftAction(kind) {
      const ending = kind === "end";
      const ok = await auth.confirmDialog({
        title: ending ? "End this shift?" : "Reopen this shift?",
        body: ending
          ? `${sitterName()} won't be able to add photos or check tasks until the shift is reopened.`
          : `${sitterName()} can add photos and check tasks again. Everyone sees that it was reopened, and anything checked now is marked "Added after reopen".`,
        confirmLabel: ending ? "End shift" : "Reopen shift",
        danger: ending,
      });
      if (!ok) return;
      showError("");
      try {
        if (ending) await shift.endShift();
        else await shift.reopenShift();
        announce(ending ? "Shift ended." : "Shift reopened.");
      } catch (err) {
        showError(shift.errorMessage(err));
      }
    }
    endBtn.addEventListener("click", () => shiftAction("end"));
    reopenBtn.addEventListener("click", () => shiftAction("reopen"));

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
            <button type="button" class="danger-btn feed-remove" data-remove>Remove photo</button>
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
          removeBtn: li.querySelector("[data-remove]"),
          albumRow: li.querySelector("[data-album-row]"),
          unsaveBtn: li.querySelector("[data-unsave]"),
          status: li.querySelector("[data-status]"),
          form: li.querySelector("[data-reply-form]"),
          input: li.querySelector("input"),
          error: li.querySelector("[data-reply-error]"),
          label: li.querySelector("label"),
        },
      };
      entry.refs.label.textContent = `Reply to ${item.senderName} about this photo`;
      entry.refs.input.placeholder = `Reply to ${item.senderName}`;

      entry.refs.replyBtn.addEventListener("click", () => toggleReply(entry));
      entry.refs.form.addEventListener("submit", (e) => {
        e.preventDefault();
        sendReply(entry);
      });
      entry.refs.form.addEventListener("keydown", (e) => {
        if (e.key === "Escape") toggleReply(entry, false);
      });
      entry.refs.saveBtn.addEventListener("click", () => savePhoto(entry));
      entry.refs.removeBtn.addEventListener("click", () => removePhoto(entry));
      entry.refs.unsaveBtn.addEventListener("click", async () => {
        const inAlbum = view === "album";
        try {
          await shift.unsavePhoto(entry.id);
          announce(`${entry.item.title} photo removed from your album.`);
          if (inAlbum) title.focus();
          else entry.refs.saveBtn.focus();
        } catch (err) {
          setStatus(entry, shift.errorMessage(err), true);
        }
      });
      return entry;
    }

    function updateEntry(entry, item, state) {
      entry.item = item;
      const sig = JSON.stringify([
        item.title,
        item.taskTime,
        item.photoPath,
        item.photoRemovedByName,
        item.tag,
        item.body,
        item.late,
        item.afterReopen,
        item.createdAt,
        item.senderName,
        state.isNew,
        state.flag,
        state.replies.map((r) => [r.id, r.senderName]),
      ]);
      if (sig !== entry.sig) {
        entry.sig = sig;
        entry.body.innerHTML = bodyHtml(item, state);
        hydratePhotos(entry.body);
      }
      const hasPhoto = Boolean(item.photoPath);
      entry.refs.saveBtn.hidden = !hasPhoto || state.saved;
      entry.refs.removeBtn.hidden = !hasPhoto || shift.demo;
      entry.refs.saveBtn.setAttribute("aria-label", `Save photo: ${item.title}`);
      entry.refs.removeBtn.setAttribute("aria-label", `Remove photo: ${item.title}`);
      entry.refs.albumRow.hidden = !state.saved;
    }

    function bodyHtml(item, state) {
      const id = escapeHtml(item.id);
      const kicker =
        item.kind === "moment"
          ? `Live moment${item.late ? ` <span class="late-badge">Late</span>` : ""}`
          : `<img src="assets/check.svg" alt="" width="16" height="16" /> Task completed`;
      const newBadge = state.isNew ? `<span class="new-badge">New</span>` : "";
      const reopenBadge = item.afterReopen ? `<span class="reopen-badge">Added after reopen</span>` : "";
      const photo = item.photoPath
        ? `<img class="msg-photo feed-photo" data-photo-path="${escapeHtml(item.photoPath)}" alt="${escapeHtml(`Photo from ${item.senderName}: ${item.title}`)}" />`
        : `<p class="photo-removed">Photo removed by ${escapeHtml(item.photoRemovedByName || "a parent")}</p>`;
      const concept = state.flag
        ? `<div class="concept-alert" role="note" aria-label="Concept alert, not real analysis">
            <p class="concept-label">Concept — not real analysis</p>
            <p class="concept-text">${escapeHtml(state.flag)}</p>
          </div>`
        : "";
      const replies = state.replies.length
        ? `<ol class="feed-replies" aria-label="Replies">
            ${state.replies
              .map(
                (r) => `
              <li class="feed-reply${r.senderRole === "parent" ? " is-parent" : ""}">
                <p class="feed-reply-body">${escapeHtml(r.body)}</p>
                <p class="msg-meta">${escapeHtml(r.senderName)} · ${timeHtml(r.createdAt)}</p>
              </li>`
              )
              .join("")}
          </ol>`
        : "";
      return `
        <p class="msg-card-kicker">${kicker}${newBadge}${reopenBadge}</p>
        <h3 class="msg-card-title" id="item-${id}-title">${escapeHtml(item.title)}${item.taskTime ? ` <span class="msg-card-time">${escapeHtml(item.taskTime)}</span>` : ""}</h3>
        ${photo}
        ${concept}
        ${item.tag ? `<p class="tag-chip">${escapeHtml(item.tag)}</p>` : ""}
        ${item.body ? `<p class="msg-card-note">${escapeHtml(item.body)}</p>` : ""}
        <p class="msg-meta">${escapeHtml(item.senderName)} · ${timeHtml(item.createdAt)}</p>
        ${replies}`;
    }

    // <img data-photo-path> -> object URL (Supabase) or data URL (demo).
    function hydratePhotos(root) {
      root.querySelectorAll("img[data-photo-path]").forEach((img) => {
        const path = img.dataset.photoPath;
        shift
          .photoUrl(path)
          .then((url) => {
            if (url && img.dataset.photoPath === path) img.src = url;
          })
          .catch(() => {
            img.replaceWith(Object.assign(document.createElement("p"), {
              className: "photo-removed",
              textContent: "This photo couldn't be loaded.",
            }));
          });
      });
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

    async function sendReply(entry) {
      const { input, error } = entry.refs;
      error.hidden = true;
      if (!input.value.trim()) {
        error.textContent = "Type a reply first.";
        error.hidden = false;
        input.focus();
        return;
      }
      try {
        await shift.sendChat(input.value, entry.id);
        input.value = "";
        toggleReply(entry, false);
        announce(`Reply sent to ${entry.item.senderName}. It's in Messages too.`);
      } catch (err) {
        error.textContent = shift.errorMessage(err) || "Reply not sent. Please try again.";
        error.hidden = false;
      }
    }

    // ---------- save ----------

    function fileName(item, type) {
      const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const d = new Date(item.createdAt);
      const pad = (n) => String(n).padStart(2, "0");
      const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
      return `carenest-${slug(childFirst())}-${slug(item.title)}-${date}.${ext}`;
    }

    // An entry the list re-rendered away (a removed photo leaves the album) reports in the
    // photo section's own status line instead, so its message and "Try again" stay visible.
    function statusLine(entry) {
      return entry.refs.status.isConnected ? entry.refs.status : document.getElementById("feed-status");
    }

    function setStatus(entry, text, isError) {
      const status = statusLine(entry);
      status.textContent = text;
      status.classList.toggle("is-error", Boolean(isError));
      status.hidden = !text;
      announce(text);
    }

    async function markSaved(entry) {
      try {
        await shift.savePhoto(entry.id);
        return true;
      } catch (err) {
        setStatus(entry, shift.errorMessage(err) || "Couldn't add this photo to your album.", true);
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

    async function savePhoto(entry) {
      const item = entry.item;
      // Already downloaded for display, so the share sheet can open inside the tap (iOS).
      let blob = shift.photoBlobNow(item.photoPath);
      const inTap = Boolean(blob);
      if (!blob) {
        try {
          blob = await shift.photoBlob(item.photoPath);
        } catch (err) {
          setStatus(entry, "This photo couldn't be prepared for saving.", true);
          return;
        }
      }
      const type = blob.type || "image/jpeg";
      const name = fileName(item, type);
      const file = new File([blob], name, { type });

      // Phones: the share sheet offers "Save Image" (iOS Photos). Desktop: plain download.
      const canShareFile =
        inTap && coarsePointer.matches && navigator.canShare && navigator.canShare({ files: [file] });
      if (canShareFile) {
        navigator
          .share({ files: [file] })
          .then(async () => {
            // The share sheet can't tell us which option was picked, so don't claim "saved".
            if (await markSaved(entry)) {
              setStatus(entry, "Shared. If you chose Save Image, it's in your Photos. Added to your album.");
            }
          })
          .catch(async (err) => {
            if (err && err.name === "AbortError") {
              setStatus(entry, "Not saved — the share sheet was closed.");
              return;
            }
            download(blob, name);
            if (await markSaved(entry)) setStatus(entry, "Photo saved to your downloads and your album.");
          });
        return;
      }

      download(blob, name);
      if (await markSaved(entry)) setStatus(entry, "Photo saved to your downloads and your album.");
    }

    // ---------- remove ----------

    async function removePhoto(entry) {
      const item = entry.item;
      const me = data.viewerFirstName || "you";
      const ok = await auth.confirmDialog({
        title: "Remove this photo?",
        body: `The photo is deleted for everyone in your family, including from anyone's album. The ${item.title} entry stays and shows "Photo removed by ${me}". This can't be undone. Copies already saved to a phone or computer aren't affected.`,
        confirmLabel: "Remove photo",
        danger: true,
      });
      if (!ok) {
        entry.refs.removeBtn.focus();
        return;
      }
      try {
        await shift.removePhoto(item.id);
        announce(`${item.title} photo removed.`);
        (entry.refs.replyBtn.isConnected ? entry.refs.replyBtn : title).focus();
      } catch (err) {
        setStatus(entry, shift.errorMessage(err), true);
        if (err.retry) offerRetry(entry, err.retry);
      }
    }

    // The photo is gone for everyone but its stored file isn't: "Try again" deletes only the file.
    function offerRetry(entry, retry) {
      const button = Object.assign(document.createElement("button"), {
        type: "button",
        className: "text-btn",
        textContent: "Try again",
      });
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await retry();
          setStatus(entry, `${entry.item.title} photo removed.`);
          (entry.refs.replyBtn.isConnected ? entry.refs.replyBtn : title).focus();
        } catch (err) {
          setStatus(entry, shift.errorMessage(err), true);
          if (err.retry) offerRetry(entry, err.retry);
        }
      });
      statusLine(entry).append(" ", button);
      button.focus();
    }

    // ---------- live alerts (in-app only; no push) ----------

    function eventKey(e) {
      return `${e.kind}:${e.at}`;
    }

    function eventText(e) {
      const at = shortTime(e.at);
      if (e.kind === "ended") return `${e.actorName} ended the shift at ${at}`;
      if (e.kind === "reopened") return `${e.actorName} reopened the shift at ${at}`;
      return `${e.actorName} unchecked ${e.taskTitle || "a task"} at ${at}`;
    }

    // href: where View goes when there is no feed item to scroll to (photo messages: the Gallery).
    function showBanner(text, itemId, href) {
      bannerText.textContent = text;
      bannerLink.hidden = !itemId && !href;
      if (itemId) bannerLink.href = `#item-${itemId}`;
      else if (href) bannerLink.href = href;
      banner.hidden = false;
      announce(text);
    }

    // The sitter's photo messages (the Gallery's "+"): chat with a photo, from someone else.
    function isPhotoMessage(m) {
      return m.kind === "chat" && Boolean(m.photoPath) && m.senderRole === "caretaker" && !m.mine;
    }

    function detectChanges(st) {
      if (!st.loaded) return;
      const now = {
        feed: new Set(st.feed.map((i) => i.id)),
        events: new Set(st.events.map(eventKey)),
        photoMessages: new Set(st.thread.filter(isPhotoMessage).map((m) => m.id)),
        visitId: st.visit ? st.visit.id : null,
      };
      const before = known;
      known = now;
      if (!before) return;

      if (now.visitId && now.visitId !== before.visitId) {
        showBanner(`${st.visit.startedByName} started the shift at ${shortTime(st.visit.startedAt)}`);
        return;
      }
      const freshEvents = st.events.filter((e) => !e.mine && !before.events.has(eventKey(e)));
      const freshPhotos = st.feed.filter((i) => !i.mine && !before.feed.has(i.id));
      const freshMessagePhotos = st.thread.filter((m) => isPhotoMessage(m) && !before.photoMessages.has(m.id));
      const anyFreshPhoto = freshPhotos.length > 0 || freshMessagePhotos.length > 0;
      if (anyFreshPhoto) {
        pendingNew = freshPhotos.map((i) => i.id).concat(pendingNew);
        pendingMessagePhotos += freshMessagePhotos.length;
        const total = pendingNew.length + pendingMessagePhotos;
        const from = (freshPhotos[0] || freshMessagePhotos[0]).senderName;
        const text = total > 1 ? `${total} new photos from ${from}` : `New photo from ${from}`;
        if (pendingNew.length) {
          // A feed photo is on this page: View scrolls to the newest one.
          const target = st.feed.find((i) => i.id === pendingNew[0]);
          showBanner(text, pendingNew[0]);
          bannerLink.setAttribute("aria-label", target ? `View new photo: ${target.title}` : "View new photo");
        } else {
          showBanner(text, null, "gallery.html?as=parent");
          bannerLink.setAttribute("aria-label", "View new photo in the Gallery");
        }
      }
      if (freshEvents.length) {
        const latest = freshEvents[freshEvents.length - 1];
        if (anyFreshPhoto) announce(eventText(latest));
        else {
          pendingNew = [];
          pendingMessagePhotos = 0;
          showBanner(eventText(latest));
        }
      }
    }

    function hideBanner() {
      banner.hidden = true;
      pendingNew = [];
      pendingMessagePhotos = 0;
    }

    bannerLink.addEventListener("click", (e) => {
      // Only photo messages are new: let the link open the Gallery.
      if (!pendingNew.length) return;
      e.preventDefault();
      const id = pendingNew[0];
      hideBanner();
      if (view === "album") {
        history.replaceState(null, "", "#today");
        view = "today";
        render();
      }
      const entry = entries.get(id);
      if (!entry) return;
      entry.article.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth", block: "start" });
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
          if (onScreen.has(id) && document.visibilityState === "visible" && !shift.state.reads.has(id)) {
            shift.markSeen([id]).catch((err) => console.warn("CareNest: read mark not saved", err));
          }
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
                  (r.intersectionRatio >= 0.5 || r.intersectionRect.height >= window.innerHeight * 0.4);
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

    // ---------- demo / dev tools (localhost or ?demo=1; not part of the product) ----------

    function renderDevTools() {
      if (!ui.isDevHost) return;
      const box = document.createElement("section");
      box.className = "panel dev-tools";
      box.setAttribute("aria-labelledby", "parent-dev-heading");
      box.innerHTML = `
        <h2 class="panel-title" id="parent-dev-heading">Demo tools (not part of the product)</h2>
        <div class="dev-tools-actions">
          ${shift.demo ? `<a class="photo-source-btn dev-link" href="index.html" target="_blank" rel="noopener">Open sitter view<span class="visually-hidden"> (opens in a new tab)</span></a>` : ""}
          ${shift.demo ? "" : `<button type="button" class="photo-source-btn" data-dev="moment">Bring moment forward (1–5 min)</button>`}
          <button type="button" class="photo-source-btn" data-dev="concept">Concept — not real analysis: flag newest photo as “tired”</button>
          <button type="button" class="photo-source-btn" data-dev="clear">Clear concept alerts</button>
        </div>
        <p class="photo-upload-error" data-dev-error role="alert" hidden></p>`;
      const err = box.querySelector("[data-dev-error]");
      const run = (fn, done) => () => {
        err.hidden = true;
        Promise.resolve()
          .then(fn)
          .then(done)
          .catch((e) => {
            err.textContent = shift.errorMessage(e);
            err.hidden = false;
          });
      };
      const moment = box.querySelector('[data-dev="moment"]');
      if (moment) {
        moment.addEventListener(
          "click",
          run(() => shift.triggerMomentNow(), () => announce(`${sitterName()}'s moment prompt will appear within 5 minutes.`))
        );
      }
      box.querySelector('[data-dev="concept"]').addEventListener("click", () => {
        const newest = shift.state.feed.find((i) => i.photoPath);
        if (!newest) {
          announce("There are no photos to flag yet.");
          return;
        }
        run(
          () => shift.setConceptFlag(newest.id, `${childFirst()} seems a little tired in this photo.`),
          () => announce(`Concept alert added to ${newest.title}. Not real analysis.`)
        )();
      });
      box.querySelector('[data-dev="clear"]').addEventListener(
        "click",
        run(() => shift.clearConceptFlags(), () => announce("Concept alerts cleared."))
      );
      document.querySelector(".parent-main").appendChild(box);
    }

    window.addEventListener("hashchange", () => {
      const next = viewFromHash(view);
      if (next === view) return;
      view = next;
      document.getElementById("feed-status").hidden = true; // its message was about the other view
      render();
    });

    ui.renderParentNav(view);
    renderDevTools();
    shift.subscribe(render);
    if (window.CareNestFamily && window.CareNestFamily.subscribe) {
      window.CareNestFamily.subscribe(() => {
        renderHeader();
        render();
      });
    }
    render();
    window.setInterval(refreshRelativeTimes, 30000);
  }
})();
