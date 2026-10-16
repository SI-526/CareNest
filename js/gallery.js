// Gallery page (gallery.html): every photo of the family's shifts (task updates, photo messages,
// moments), oldest first and grouped by shift, with a source filter. The sitter adds a photo
// message with "+"; a parent can remove any photo. Removed photos (tombstones) are not shown.
// All text goes in through textContent, never as HTML.
(function () {
  const ui = window.CareNestUI;
  if (document.body.dataset.page !== "gallery" || !ui || !window.CareNestShift) return;

  const SOURCE_LABELS = { task: "Task update", message: "Photo message", moment: "Moment" };
  const EMPTY_TEXT = "No photos yet. Continue capturing moments with your child!";
  const EMPTY_FILTER_TEXT = "No photos in this category yet.";
  const SHIFT_LOCKED_TEXT = "This shift has ended. Photos can't be added after a shift.";

  const list = document.getElementById("gallery-list");
  const filter = document.querySelector(".gallery-filter");
  const status = document.getElementById("gallery-status");
  const locked = document.getElementById("gallery-locked");
  const addBox = document.getElementById("gallery-add");
  const fab = document.getElementById("gallery-fab");
  const fileInput = document.getElementById("gallery-file");
  const dialog = document.getElementById("gallery-dialog");
  const form = document.getElementById("gallery-form");
  const preview = document.getElementById("gallery-preview");
  const caption = document.getElementById("gallery-caption");
  const dialogError = document.getElementById("gallery-error");
  const sendBtn = document.getElementById("gallery-send");
  const cancelBtn = document.getElementById("gallery-cancel");

  let backend = null;
  let pendingFile = null;
  let previewUrl = null;
  let sending = false;
  let newestShownId = null;
  let photoObserver = null;
  // After a removal: where focus goes once the list re-renders without the removed card.
  let pendingFocus = null;

  window.CareNestShift.ready.then((b) => {
    backend = b;
    const isParent = backend.role === "parent";
    if (isParent) ui.renderParentNav("gallery");
    if (isParent) addBox.remove();
    else {
      addBox.hidden = false;
      initAdd();
    }
    filter.addEventListener("change", render);
    list.addEventListener("click", onListClick);
    backend.subscribe(render);
    render();
  });

  function setStatus(text) {
    status.textContent = text || "";
  }

  // "Wed, Oct 15" from 'YYYY-MM-DD'.
  function dayLabel(isoDate) {
    if (!isoDate) return "Earlier shift";
    const [y, m, d] = String(isoDate).split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }

  function altText(item) {
    if (item.source === "task") return `Task update: ${item.title}`;
    if (item.source === "message") return `Photo message from ${item.senderName}`;
    return "Moment";
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function emptyState(text) {
    const box = el("div", "empty-state gallery-empty");
    box.appendChild(el("p", "", text));
    return box;
  }

  // position: { index, count, day } within the item's shift, for a unique Remove button name.
  function photoCard(item, isParent, position) {
    const li = el("li", "gallery-item");
    const figure = el("figure", "gallery-card");
    const img = el("img", "msg-photo gallery-photo");
    img.alt = altText(item);
    img.dataset.photoPath = item.photoPath;
    img.dataset.order = String(position.order);
    figure.appendChild(img);

    const cap = el("figcaption", "gallery-caption");
    cap.appendChild(el("span", `tag-chip gallery-source is-${item.source}`, SOURCE_LABELS[item.source]));
    if (item.source === "task") cap.appendChild(el("p", "gallery-title", item.title));
    if (item.body) cap.appendChild(el("p", "msg-card-note", item.body));
    const meta = el("p", "msg-meta");
    const time = el("time", "", ui.formatTime(item.createdAt));
    time.dateTime = new Date(item.createdAt).toISOString();
    meta.append(`${item.senderName} · `, time);
    cap.appendChild(meta);
    figure.appendChild(cap);

    if (isParent) {
      const remove = el("button", "photo-source-btn gallery-remove", "Remove photo");
      remove.type = "button";
      remove.dataset.removeId = item.id;
      remove.setAttribute(
        "aria-label",
        `Remove photo ${position.index} of ${position.day}: ${altText(item)}, ${ui.formatTime(item.createdAt)}`
      );
      figure.appendChild(remove);
    }
    li.appendChild(figure);
    return li;
  }

  // Object URLs from the private bucket (demo: data URLs); a failed photo gets a text fallback.
  function loadPhoto(img) {
    const fail = () => {
      if (img.isConnected) img.replaceWith(el("p", "photo-removed", "This photo couldn't load."));
    };
    backend
      .photoUrl(img.dataset.photoPath)
      .then((url) => {
        if (url) img.src = url;
        else fail();
      })
      .catch(fail);
  }

  // Pixels between an element and the viewport (0 when on screen).
  function viewportDistance(rect) {
    if (rect.bottom < 0) return -rect.bottom;
    if (rect.top > window.innerHeight) return rect.top - window.innerHeight;
    return 0;
  }

  // Photos load only as they near the viewport: the closest first, and among equally close
  // ones the newest first (the list runs oldest to newest, so a higher order is newer).
  function hydrate(root) {
    const imgs = Array.from(root.querySelectorAll("img[data-photo-path]"));
    if (!("IntersectionObserver" in window)) {
      imgs.reverse().forEach(loadPhoto);
      return;
    }
    const observer = new IntersectionObserver(
      (records) => {
        records
          .filter((r) => r.isIntersecting)
          .sort(
            (a, b) =>
              viewportDistance(a.boundingClientRect) - viewportDistance(b.boundingClientRect) ||
              Number(b.target.dataset.order) - Number(a.target.dataset.order)
          )
          .forEach((r) => {
            observer.unobserve(r.target);
            loadPhoto(r.target);
          });
      },
      { rootMargin: "600px 0px" }
    );
    imgs.forEach((img) => observer.observe(img));
    photoObserver = observer;
  }

  function render() {
    const st = backend.state;
    const isParent = backend.role === "parent";
    const all = (st.gallery || []).filter((p) => p.photoPath);
    const chosen = (filter.querySelector("input:checked") || {}).value || "all";
    const items = chosen === "all" ? all : all.filter((p) => p.source === chosen);

    if (photoObserver) photoObserver.disconnect();
    photoObserver = null;
    list.replaceChildren();
    if (st.loadError) list.appendChild(emptyState(st.loadError));
    else if (!all.length) list.appendChild(emptyState(EMPTY_TEXT));
    else if (!items.length) list.appendChild(emptyState(EMPTY_FILTER_TEXT));
    else {
      // One section per shift, in order of each shift's first photo.
      const groups = new Map();
      items.forEach((item) => {
        const key = item.visitId || item.shiftDate || "none";
        if (!groups.has(key)) groups.set(key, { date: item.shiftDate, items: [] });
        groups.get(key).items.push(item);
      });
      let n = 0;
      let order = 0;
      groups.forEach((group) => {
        const id = `gallery-shift-${++n}`;
        const day = dayLabel(group.date);
        const section = el("section", "gallery-shift");
        section.setAttribute("aria-labelledby", id);
        const heading = el("h2", "gallery-shift-title", day);
        heading.id = id;
        const grid = el("ul", "gallery-grid");
        group.items.forEach((item, i) =>
          grid.appendChild(photoCard(item, isParent, { index: i + 1, day, order: order++ }))
        );
        section.append(heading, grid);
        list.appendChild(section);
      });
      hydrate(list);
    }

    if (!isParent) renderAdd(st);

    // Newest photo at the bottom: scroll to it on first load and whenever a newer one shows up.
    const newest = items.length ? items[items.length - 1].id : null;
    if (newest && newest !== newestShownId) {
      const cards = list.querySelectorAll(".gallery-item");
      cards[cards.length - 1].scrollIntoView({ block: "end" });
    }
    newestShownId = newest;
    applyPendingFocus();
  }

  // ---------- sitter: add a photo message ----------

  function lockText(st) {
    if (st.loadError || st.active) return "";
    if (st.noPlan) return "Your family hasn't set up a schedule yet.";
    if (!st.visit || st.canStart) return "Start your shift to add photos.";
    if (st.tooOld) return "This shift is too old to change. Shifts before yesterday are read-only.";
    if (st.ended) return SHIFT_LOCKED_TEXT;
    return "";
  }

  function renderAdd(st) {
    const reason = st.loaded ? lockText(st) : "";
    locked.textContent = reason;
    locked.hidden = !reason;
    // aria-disabled (not disabled) keeps the button focusable, so its reason is still read out.
    fab.setAttribute("aria-disabled", String(Boolean(reason) || !st.loaded));
  }

  function initAdd() {
    fab.addEventListener("click", () => {
      if (fab.getAttribute("aria-disabled") === "true") {
        setStatus(lockText(backend.state));
        return;
      }
      setStatus("");
      fileInput.click();
    });

    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = ""; // choosing the same photo again still fires change
      if (!file) return;
      if (!/^image\//.test(file.type || "")) {
        setStatus("That file isn't a photo. Choose a JPEG, PNG, or WebP image.");
        return;
      }
      pendingFile = file;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(file);
      preview.src = previewUrl;
      caption.value = "";
      dialogError.hidden = true;
      sendBtn.disabled = false;
      dialog.showModal();
      caption.focus();
    });

    cancelBtn.addEventListener("click", () => dialog.close());
    dialog.addEventListener("cancel", (e) => {
      if (sending) e.preventDefault(); // Esc while sending would hide the result
    });
    dialog.addEventListener("close", () => {
      pendingFile = null;
      preview.removeAttribute("src");
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = null;
      fab.focus();
    });

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!pendingFile || sending) return;
      sending = true;
      sendBtn.disabled = true;
      cancelBtn.disabled = true;
      dialogError.hidden = true;
      backend
        .postPhoto({ file: pendingFile, body: caption.value })
        .then(() => {
          dialog.close();
          setStatus("Photo sent.");
        })
        .catch((err) => {
          dialogError.textContent = backend.errorMessage(err);
          dialogError.hidden = false;
          sendBtn.disabled = false;
        })
        .finally(() => {
          sending = false;
          cancelBtn.disabled = false;
        });
    });
  }

  // ---------- parent: remove a photo ----------

  function removeButton(id) {
    return Array.from(list.querySelectorAll("[data-remove-id]")).find((b) => b.dataset.removeId === id) || null;
  }

  // Once the removed card is gone: the next card's Remove button, else the previous one's, else
  // the page heading (so focus never falls back to the top of the list or the body).
  function applyPendingFocus() {
    if (!pendingFocus || removeButton(pendingFocus.removedId)) return;
    const { next, prev } = pendingFocus;
    pendingFocus = null;
    const target = next.map(removeButton).find(Boolean) || prev.map(removeButton).find(Boolean);
    if (target) {
      target.focus();
      return;
    }
    const heading = document.getElementById("gallery-title");
    heading.tabIndex = -1;
    heading.focus();
  }

  function onListClick(e) {
    const button = e.target.closest("[data-remove-id]");
    if (!button || backend.role !== "parent") return;
    if (!window.confirm("Remove this photo for everyone in the family? This can't be undone.")) return;
    const removedId = button.dataset.removeId;
    const ids = Array.from(list.querySelectorAll("[data-remove-id]")).map((b) => b.dataset.removeId);
    const at = ids.indexOf(removedId);
    button.disabled = true;
    setStatus("");
    backend
      .removePhoto(removedId)
      .then(() => {
        setStatus("Photo removed.");
        pendingFocus = { removedId, next: ids.slice(at + 1), prev: ids.slice(0, at).reverse() };
        applyPendingFocus(); // the list may already have re-rendered; otherwise render() does it
      })
      .catch((err) => {
        button.disabled = false;
        setStatus(backend.errorMessage(err));
        if (err.retry) offerRetry(err.retry);
      });
  }

  // The photo is gone for everyone but its stored file isn't: "Try again" deletes only the file.
  function offerRetry(retry) {
    const again = el("button", "text-btn", "Try again");
    again.type = "button";
    again.addEventListener("click", () => {
      again.disabled = true;
      retry()
        .then(() => {
          setStatus("Photo removed.");
          const heading = document.getElementById("gallery-title"); // the button is gone with the old status
          heading.tabIndex = -1;
          heading.focus();
        })
        .catch((err) => {
          setStatus(backend.errorMessage(err));
          if (err.retry) offerRetry(err.retry);
        });
    });
    status.append(" ", again);
    again.focus();
  }
})();
