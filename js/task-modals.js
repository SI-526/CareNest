// CareNestTaskModals: the task details and "Submit a photo" dialogs, shared by the sitter's Home
// (index.html) and Schedule (schedule.html) checklists (SI-71). One copy of the markup, added to
// the page by js/app.js before it wires the checklist, so both pages check tasks off the same way.
(function () {
  const MARKUP = `
  <div
    class="modal-overlay"
    id="activity-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="modal-title"
    aria-hidden="true"
  >
    <div class="modal">
      <button
        type="button"
        class="back-btn"
        data-close-modal
        aria-label="Close activity details"
      >
        <img src="assets/back.svg" alt="" width="30" height="30" />
      </button>

      <div class="modal-summary">
        <div class="modal-summary-meta">
          <span data-modal-time></span>
          <span data-modal-date></span>
        </div>
        <h2 id="modal-title" data-modal-title></h2>
      </div>

      <div class="submitted-photo-frame modal-photo" data-modal-photo-wrap hidden>
        <img
          class="submitted-photo"
          data-modal-photo
          alt=""
        />
      </div>

      <p class="tag-chip" data-modal-tag hidden></p>

      <div class="submitted-note" data-modal-note-wrap hidden>
        <h3 class="complete-note-label">Note to parent</h3>
        <p class="submitted-note-text" data-modal-note></p>
      </div>

      <p class="check-meta" data-modal-check-meta hidden></p>
      <button type="button" class="photo-source-btn uncheck-btn" data-uncheck hidden>Uncheck this task</button>
      <p class="photo-upload-error" data-uncheck-error role="alert" hidden></p>

      <div class="modal-location" data-modal-location hidden>
        <img src="assets/location.svg" alt="" width="16" height="16" />
        <div>
          <p data-modal-location-text></p>
          <a class="map-link" data-modal-map-link href="https://www.google.com/maps" target="_blank" rel="noopener">Open in Maps<span class="visually-hidden"> (opens in a new tab)</span></a>
        </div>
      </div>

      <p class="modal-detail" data-modal-detail hidden></p>

      <p class="modal-detail modal-empty" data-modal-empty hidden>
        No information provided
      </p>

      <div class="care-note modal-care" data-modal-care hidden>
        <h3>Care note</h3>
        <p data-modal-care-body></p>
      </div>

      <div class="care-log-modal-section" data-modal-logs hidden>
        <h3 class="complete-note-label">Care log</h3>
        <div data-modal-logs-list></div>
      </div>
    </div>
  </div>

  <div
    class="modal-overlay"
    id="complete-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="complete-modal-heading"
    aria-hidden="true"
  >
    <div class="modal complete-modal">
      <button
        type="button"
        class="back-btn"
        data-close-complete
        aria-label="Cancel and go back"
      >
        <img src="assets/back.svg" alt="" width="30" height="30" />
      </button>

      <h2 class="complete-heading" id="complete-modal-heading">
        Submit a photo of the completed task
      </h2>

      <div class="modal-summary complete-task-summary">
        <p class="complete-task-time" data-complete-time></p>
        <p class="complete-task-title" data-complete-title></p>
        <p class="complete-task-detail" data-complete-detail></p>
      </div>

      <div class="photo-upload">
        <input
          type="file"
          id="complete-photo-input"
          accept="image/*"
          hidden
        />
        <input
          type="file"
          id="complete-photo-camera-input"
          accept="image/*"
          capture="environment"
          hidden
        />

        <div class="photo-preview-frame" id="complete-photo-stage" hidden>
          <img
            class="photo-preview"
            id="complete-photo-preview"
            alt=""
            hidden
          />
          <video
            class="photo-preview"
            id="complete-photo-video"
            autoplay
            playsinline
            muted
            hidden
          ></video>
        </div>

        <div class="photo-source-actions" id="complete-photo-choices">
          <button
            type="button"
            class="photo-source-btn"
            id="complete-photo-upload"
          >
            Upload a photo
          </button>
          <button
            type="button"
            class="photo-source-btn"
            id="complete-photo-camera-btn"
          >
            Take a photo
          </button>
        </div>

        <div
          class="photo-source-actions"
          id="complete-photo-camera-actions"
          hidden
        >
          <button type="button" class="primary-btn" id="complete-photo-capture">
            Capture photo
          </button>
          <button
            type="button"
            class="photo-source-btn"
            id="complete-photo-camera-cancel"
          >
            Cancel
          </button>
        </div>

        <p class="photo-upload-error" id="complete-photo-error" hidden>
          Please add a photo before sending.
        </p>
        <p class="photo-upload-error" id="complete-photo-camera-error" hidden>
          Camera isn't available. Upload a photo instead.
        </p>
      </div>

      <fieldset class="tag-picker">
        <legend class="complete-note-label">Tag this photo (optional)</legend>
        <div class="tag-options">
          <label class="tag-option">
            <input type="radio" name="complete-tag" value="" checked />
            <span>No tag</span>
          </label>
          <label class="tag-option">
            <input type="radio" name="complete-tag" value="Meal" />
            <span>Meal</span>
          </label>
          <label class="tag-option">
            <input type="radio" name="complete-tag" value="Nap" />
            <span>Nap</span>
          </label>
          <label class="tag-option">
            <input type="radio" name="complete-tag" value="Play" />
            <span>Play</span>
          </label>
          <label class="tag-option">
            <input type="radio" name="complete-tag" value="Outing" />
            <span>Outing</span>
          </label>
          <label class="tag-option">
            <input type="radio" name="complete-tag" value="Milestone" />
            <span>Milestone</span>
          </label>
          <label class="tag-option">
            <input type="radio" name="complete-tag" value="Other" />
            <span>Other</span>
          </label>
        </div>
      </fieldset>

      <label class="complete-note-label" for="complete-note">
        Add a note to the parent:
      </label>
      <textarea
        class="complete-note"
        id="complete-note"
        rows="3"
        placeholder=""
      ></textarea>

      <button type="button" class="primary-btn" id="complete-send-btn">
        Send
      </button>
    </div>
  </div>
`;

  // Adds the dialogs (and the polite status line js/app.js announces into) once per page.
  function ensure() {
    if (!document.getElementById("activity-modal")) {
      document.body.insertAdjacentHTML("beforeend", MARKUP);
    }
    if (!document.getElementById("app-status")) {
      document.body.insertAdjacentHTML(
        "beforeend",
        '<p class="visually-hidden" id="app-status" aria-live="polite"></p>'
      );
    }
  }

  window.CareNestTaskModals = { ensure };
})();
