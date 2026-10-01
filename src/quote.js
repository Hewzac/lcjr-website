/* ==========================================================================
   Quote request flow — Lewis-Clark Junk Removal

   Talks to the ops app at app.lcjunk.com. Two endpoints, both defined in the
   integration spec:

     GET  /api/pricing   load fractions, surcharge items, service ZIPs
     POST /api/requests  a job request

   Both are live. If pricing cannot be fetched the calculator is hidden
   entirely and the page falls back to call-and-text, rather than showing
   prices that might disagree with what a supervisor sees.

   Rules this file enforces, from the spec:
     - Money is integer cents everywhere. Formatting happens at display only.
     - Prices and service ZIPs are never hard-coded for production use.
     - The number shown is an ESTIMATE, never a quote.
     - A partial lead (name + phone + ZIP) is submitted with incompleteIntake
       rather than discarded — but only once the visitor has confirmed they
       are 18 or over. No attestation, nothing leaves the browser.
   ========================================================================== */

(function () {
  "use strict";

  var root = document.getElementById("quote-app");
  if (!root) return;

  /*
   * Where the ops app lives. Set `data-api-base` on #quote-app to point at a
   * local worker or a staging deploy without touching this file — e.g.
   * data-api-base="http://localhost:5273" while running the ops repo's
   * `npm run dev`.
   *
   * Whatever origin is used here must also be listed in PUBLIC_SITE_ORIGINS
   * on the ops side, or the browser will refuse to read the response.
   */
  var API_BASE = (root.dataset.apiBase || "https://app.lcjunk.com").replace(/\/$/, "");

  // The sample price list is for local development only — it lets the flow be
  // built and tested before the endpoint ships. It must never drive a live
  // page, because a baked-in price list silently drifts from the database.
  var IS_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  var PRICING_TIMEOUT_MS = 6000;

  /*
   * Cloudflare Turnstile. Empty site key = off, and the form behaves exactly
   * as it did before, so this ships safely before the key exists.
   *
   * It is the one third-party script on the site, which is why it is opt-in
   * rather than always-on: turning it on makes a statement in the privacy
   * policy's "no third-party scripts" section untrue unless that section is
   * updated too. It has been.
   */
  var TURNSTILE_KEY = (root.dataset.turnstileKey || "").trim();
  var TURNSTILE_SRC =
    "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  var turnstileReady = null;

  /* ------------------------------------------------------------- State -- */

  var pricing = null;      // { loadFractions, surcharges, serviceZips }
  var zipIndex = null;     // zip -> { city, state }
  var submitted = false;
  var partialSent = false;

  var state = {
    step: "zip",
    zip: "",
    city: "",
    stateCode: "",
    loadFraction: null,
    surcharges: {},        // key -> quantity
    customerName: "",
    phone: "",
    email: "",
    address: "",
    description: "",
    itemsLocation: "",
    stairsFlights: 0,
    parkingNotes: "",
    accessNotes: "",
    preferredTimeframe: "",
    isCommercial: false,
    /**
     * The visitor's own confirmation that they are 18 or over. Nothing is
     * submitted without it — not a finished request, and not a partial lead.
     */
    isAdult: false,
    /** Honeypot. A real person never fills this in; it is off-screen. */
    company: "",
    /** Turnstile token, when Turnstile is switched on. */
    turnstileToken: "",
  };

  /* --------------------------------------------------------- Turnstile -- */

  /** Loads the widget script once. Resolves immediately when it is off. */
  function loadTurnstile() {
    if (!TURNSTILE_KEY) return Promise.resolve(false);
    if (turnstileReady) return turnstileReady;

    turnstileReady = new Promise(function (resolve) {
      if (window.turnstile) return resolve(true);
      var s = document.createElement("script");
      s.src = TURNSTILE_SRC;
      s.async = true;
      s.defer = true;
      s.onload = function () { resolve(true); };
      // A blocked or failed script must not strand the form. The server still
      // has the age gate, the honeypot and the rate limit.
      s.onerror = function () {
        console.warn("[quote] Turnstile failed to load; continuing without it");
        resolve(false);
      };
      document.head.appendChild(s);
    });
    return turnstileReady;
  }

  /** Id of the mounted widget, so a spent token can be replaced. */
  var turnstileWidget = null;

  /** Renders the widget into a container, storing the token on success. */
  function mountTurnstile(container) {
    if (!TURNSTILE_KEY) return;
    loadTurnstile().then(function (ok) {
      if (!ok || !window.turnstile || !container.isConnected) return;
      state.turnstileToken = "";
      turnstileWidget = window.turnstile.render(container, {
        sitekey: TURNSTILE_KEY,
        theme: "dark",
        callback: function (token) { state.turnstileToken = token; },
        "expired-callback": function () { state.turnstileToken = ""; },
        "error-callback": function () { state.turnstileToken = ""; },
      });
    });
  }

  /*
   * A Turnstile token is good for one verification. The server checks it
   * before it validates the rest of the body, so a submission rejected for a
   * bad phone number has already spent its token — without this, correcting
   * the number and pressing send again would fail the bot check instead.
   */
  function resetTurnstile() {
    state.turnstileToken = "";
    if (!TURNSTILE_KEY || !window.turnstile || turnstileWidget === null) return;
    try { window.turnstile.reset(turnstileWidget); } catch (e) { /* widget gone */ }
  }

  /* ------------------------------------------------------------- Money -- */

  function formatCents(cents) {
    var sign = cents < 0 ? "-" : "";
    var abs = Math.abs(Math.round(cents));
    var dollars = Math.floor(abs / 100);
    var rest = String(abs % 100).padStart(2, "0");
    return sign + "$" + dollars.toLocaleString("en-US") + "." + rest;
  }

  function estimateCents() {
    if (!state.loadFraction) return 0;
    var total = state.loadFraction.priceCents;
    Object.keys(state.surcharges).forEach(function (key) {
      var qty = state.surcharges[key];
      if (!qty) return;
      var item = findSurcharge(key);
      if (item) total += item.priceCents * qty;
    });
    return total;
  }

  function findSurcharge(key) {
    for (var i = 0; i < pricing.surcharges.length; i++) {
      if (pricing.surcharges[i].key === key) return pricing.surcharges[i];
    }
    return null;
  }

  /* ----------------------------------------------------------- Pricing -- */

  function normalizePricing(raw) {
    // Accept a couple of plausible shapes so a naming difference on the ops
    // side is a one-line fix here rather than a redesign.
    var fractions = raw.loadFractions || raw.load_fractions || [];
    var surcharges = raw.surcharges || raw.surchargeItems || raw.surcharge_items || [];
    var zips = raw.serviceZips || raw.service_zips || raw.serviceAreaZips || [];

    return {
      loadFractions: fractions.map(function (f) {
        return {
          key: f.key,
          label: f.label,
          fraction: Number(f.fraction),
          priceCents: Number(f.priceCents != null ? f.priceCents : f.price_cents),
          estMinutes: Number(f.estMinutes != null ? f.estMinutes : f.est_minutes),
        };
      }),
      surcharges: surcharges.map(function (s) {
        return {
          key: s.key,
          label: s.label,
          priceCents: Number(s.priceCents != null ? s.priceCents : s.price_cents),
          // e.g. "Per tire, rims add $5" — worth showing, it answers the
          // question the customer was about to phone about.
          note: s.note || "",
        };
      }),
      serviceZips: zips.map(function (z) {
        if (typeof z === "string") return { zip: z, city: "", state: "" };
        return { zip: String(z.zip), city: z.city || "", state: z.state || "" };
      }),
    };
  }

  function fetchPricing() {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, PRICING_TIMEOUT_MS);

    return fetch(API_BASE + "/api/pricing", {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
      .then(function (res) {
        if (!res.ok) throw new Error("pricing " + res.status);
        return res.json();
      })
      .then(function (json) {
        clearTimeout(timer);
        return normalizePricing(json);
      })
      .catch(function (err) {
        clearTimeout(timer);
        if (!IS_LOCAL) throw err;
        // Local development only.
        console.warn("[quote] live pricing unavailable, using sample:", err.message);
        return fetch("/src/pricing.sample.json")
          .then(function (r) { return r.json(); })
          .then(normalizePricing);
      });
  }

  /* ------------------------------------------------------------ Markup -- */

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "class") node.className = attrs[k];
      else if (k === "text") node.textContent = attrs[k];
      else if (k === "html") node.innerHTML = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  // Side-view truck whose bed fills bottom-up in proportion to the load.
  // Reads far better than "0.375".
  function truckSvg(fraction) {
    var boxY = 10, boxH = 24, boxX = 6, boxW = 56;
    var fillH = Math.max(1.5, boxH * fraction);
    var fillY = boxY + (boxH - fillH);
    return (
      '<svg class="truck" viewBox="0 0 96 50" role="img" aria-hidden="true">' +
        '<rect class="truck-fill" x="' + boxX + '" y="' + fillY.toFixed(2) +
          '" width="' + boxW + '" height="' + fillH.toFixed(2) + '" rx="1.5"/>' +
        '<rect class="truck-box" x="4" y="8" width="60" height="28" rx="2.5"/>' +
        '<path class="truck-cab" d="M64 36V16h11l8 9v11z"/>' +
        '<path class="truck-line" d="M2 40h92"/>' +
        '<circle class="truck-wheel" cx="22" cy="40" r="5"/>' +
        '<circle class="truck-wheel" cx="76" cy="40" r="5"/>' +
      "</svg>"
    );
  }

  /* -------------------------------------------------------------- Steps -- */

  var STEPS = [
    { id: "zip", label: "Coverage" },
    { id: "load", label: "Load size" },
    { id: "details", label: "Your details" },
  ];

  function renderProgress() {
    if (state.step === "done" || state.step === "outside") return null;
    var list = el("ol", { class: "wiz-steps" });
    STEPS.forEach(function (s, i) {
      var idx = STEPS.findIndex(function (x) { return x.id === state.step; });
      var cls = "wiz-step";
      if (i < idx) cls += " is-done";
      if (i === idx) cls += " is-current";
      var li = el("li", { class: cls });
      li.appendChild(el("span", { class: "wiz-step-num", text: i < idx ? "✓" : String(i + 1) }));
      li.appendChild(el("span", { class: "wiz-step-label", text: s.label }));
      if (i === idx) li.setAttribute("aria-current", "step");
      list.appendChild(li);
    });
    return list;
  }

  /* --- Step 1: coverage ---------------------------------------------- */

  function renderZipStep() {
    var wrap = el("div", { class: "wiz-panel" });
    wrap.appendChild(el("h2", { text: "Do we come to you?" }));
    wrap.appendChild(el("p", {
      class: "lead",
      text: "Start with your ZIP code. No point filling in a form for an area we can't reach.",
    }));

    var form = el("form", { class: "zip-form", novalidate: "novalidate" });
    var field = el("div", { class: "field" });
    field.appendChild(el("label", { for: "zip", text: "ZIP code" }));
    var input = el("input", {
      id: "zip", name: "zip", type: "text", inputmode: "numeric",
      autocomplete: "postal-code", maxlength: "5", placeholder: "83501",
      "aria-describedby": "zip-error",
    });
    input.value = state.zip;
    field.appendChild(input);
    field.appendChild(el("p", { id: "zip-error", class: "field-error", role: "alert" }));
    form.appendChild(field);
    form.appendChild(el("button", { class: "btn btn--primary", type: "submit", text: "Check My ZIP" }));
    wrap.appendChild(form);

    var served = el("div", { class: "zip-served" });
    served.appendChild(el("h4", { text: "Where we haul" }));
    var byState = {};
    pricing.serviceZips.forEach(function (z) {
      (byState[z.state] = byState[z.state] || []).push(z);
    });
    Object.keys(byState).sort().forEach(function (st) {
      var row = el("p", { class: "zip-served-row" });
      row.appendChild(el("strong", { text: st ? st + ": " : "" }));
      row.appendChild(document.createTextNode(
        byState[st].map(function (z) { return z.city ? z.city + " " + z.zip : z.zip; }).join(" · ")
      ));
      served.appendChild(row);
    });
    wrap.appendChild(served);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var value = input.value.trim();
      var err = form.querySelector("#zip-error");

      if (!/^\d{5}$/.test(value)) {
        err.textContent = "Enter a 5-digit ZIP code.";
        input.focus();
        return;
      }
      err.textContent = "";
      state.zip = value;

      var match = zipIndex[value];
      if (match) {
        state.city = match.city;
        state.stateCode = match.state;
        go("load");
      } else {
        go("outside");
      }
    });

    return wrap;
  }

  /* --- Out of area ---------------------------------------------------- */

  function renderOutsideStep() {
    var wrap = el("div", { class: "wiz-panel" });
    wrap.appendChild(el("h2", { text: "That one's outside our usual run" }));
    wrap.appendChild(el("p", {
      class: "lead",
      html: "We don't have <strong>" + escapeHtml(state.zip) + "</strong> on our regular route. " +
        "That isn't always a no — leave a number and we'll tell you straight whether we can get there.",
    }));

    var form = el("form", { class: "outside-form", novalidate: "novalidate" });
    form.innerHTML =
      '<div class="field-row">' +
        '<div class="field"><label for="o-name">Your name</label>' +
        '<input id="o-name" name="customerName" type="text" autocomplete="name"></div>' +
        '<div class="field"><label for="o-phone">Phone</label>' +
        '<input id="o-phone" name="phone" type="tel" autocomplete="tel"></div>' +
      "</div>" +
      '<div class="hp" aria-hidden="true">' +
        '<label for="o-company">Company</label>' +
        '<input id="o-company" type="text" tabindex="-1" autocomplete="off">' +
      "</div>" +
      '<div class="turnstile-slot" id="o-turnstile"></div>' +
      '<label class="check check--gate"><input id="o-adult" type="checkbox" required>' +
        '<span>I am 18 or older, and I agree to the ' +
        '<a href="/terms.html" target="_blank" rel="noopener">Terms of Service</a> and ' +
        '<a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>' +
      '<p id="outside-error" class="field-error" role="alert"></p>';
    var actions = el("div", { class: "btn-row" });
    actions.appendChild(el("button", { class: "btn btn--primary", type: "submit", text: "Ask Us Anyway" }));
    var back = el("button", { class: "btn btn--ghost", type: "button", text: "Try Another ZIP" });
    back.addEventListener("click", function () { go("zip"); });
    actions.appendChild(back);
    form.appendChild(actions);
    wrap.appendChild(form);
    mountTurnstile(form.querySelector("#o-turnstile"));

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var name = form.querySelector("#o-name").value.trim();
      var phone = form.querySelector("#o-phone").value.trim();
      var err = form.querySelector("#outside-error");
      if (!name || !phone) {
        err.textContent = "We need a name and a phone number to call you back.";
        return;
      }
      if (!form.querySelector("#o-adult").checked) {
        err.textContent = "Please confirm you are 18 or older before sending this.";
        form.querySelector("#o-adult").focus();
        return;
      }
      err.textContent = "";
      state.customerName = name;
      state.phone = phone;
      state.isAdult = true;
      state.company = form.querySelector("#o-company").value;
      send({ incompleteIntake: true, outOfArea: true }, form.querySelector("button"));
    });

    return wrap;
  }

  /* --- Step 2: load size ---------------------------------------------- */

  function renderLoadStep() {
    var wrap = el("div", { class: "wiz-panel" });
    wrap.appendChild(el("h2", { text: "How much is there?" }));
    wrap.appendChild(el("p", {
      class: "lead",
      text: "Pick the closest match. Nobody expects you to measure it — a rough call is fine, and we confirm on site.",
    }));

    var group = el("fieldset", { class: "load-group" });
    group.appendChild(el("legend", { class: "sr-only", text: "Load size" }));

    pricing.loadFractions.forEach(function (f) {
      var id = "load-" + f.key;
      var label = el("label", { class: "load-card", for: id });
      var input = el("input", { type: "radio", name: "loadFraction", id: id, value: f.key, class: "sr-only" });
      if (state.loadFraction && state.loadFraction.key === f.key) input.checked = true;
      label.appendChild(input);
      label.insertAdjacentHTML("beforeend", truckSvg(f.fraction));
      label.appendChild(el("span", { class: "load-name", text: f.label }));
      label.appendChild(el("span", { class: "load-price", text: formatCents(f.priceCents) }));
      label.appendChild(el("span", { class: "load-time", text: "about " + f.estMinutes + " min on site" }));
      if (input.checked) label.classList.add("is-selected");
      input.addEventListener("change", function () {
        state.loadFraction = f;
        // Class mirrors :checked so the selection is still visible where
        // CSS :has() is unsupported.
        group.querySelectorAll(".load-card").forEach(function (c) {
          c.classList.remove("is-selected");
        });
        label.classList.add("is-selected");
        syncEstimate();
      });
      group.appendChild(label);
    });
    wrap.appendChild(group);

    // Surcharges
    var sur = el("div", { class: "surcharge-block" });
    sur.appendChild(el("h3", { text: "Anything on this list?" }));
    sur.appendChild(el("p", {
      class: "surcharge-note",
      text: "These cost extra to dispose of, so they're priced separately. Leave them at zero if you have none.",
    }));

    var grid = el("div", { class: "surcharge-grid" });
    pricing.surcharges.forEach(function (s) {
      var row = el("div", { class: "surcharge-row" });
      var labelId = "sur-" + s.key;
      var labelWrap = el("div", { class: "surcharge-text" });
      labelWrap.appendChild(el("span", { class: "surcharge-label", id: labelId + "-label", text: s.label }));
      if (s.note) labelWrap.appendChild(el("span", { class: "surcharge-note-inline", text: s.note }));
      row.appendChild(labelWrap);
      row.appendChild(el("span", { class: "surcharge-each", text: formatCents(s.priceCents) + " each" }));

      var stepper = el("div", { class: "stepper" });
      var minus = el("button", { type: "button", class: "stepper-btn", "aria-label": "Remove one " + s.label, text: "−" });
      var qty = el("input", {
        type: "number", min: "0", max: "99", step: "1", value: String(state.surcharges[s.key] || 0),
        class: "stepper-value", id: labelId, "aria-labelledby": labelId + "-label",
      });
      var plus = el("button", { type: "button", class: "stepper-btn", "aria-label": "Add one " + s.label, text: "+" });

      function setQty(n) {
        n = Math.max(0, Math.min(99, n | 0));
        state.surcharges[s.key] = n;
        qty.value = String(n);
        row.classList.toggle("is-active", n > 0);
        syncEstimate();
      }
      minus.addEventListener("click", function () { setQty((parseInt(qty.value, 10) || 0) - 1); });
      plus.addEventListener("click", function () { setQty((parseInt(qty.value, 10) || 0) + 1); });
      qty.addEventListener("change", function () { setQty(parseInt(qty.value, 10) || 0); });
      if (state.surcharges[s.key]) row.classList.add("is-active");

      stepper.appendChild(minus);
      stepper.appendChild(qty);
      stepper.appendChild(plus);
      row.appendChild(stepper);
      grid.appendChild(row);
    });
    sur.appendChild(grid);
    wrap.appendChild(sur);

    wrap.appendChild(estimateBar());

    var actions = el("div", { class: "btn-row wiz-actions" });
    var next = el("button", { class: "btn btn--primary", type: "button", text: "Continue" });
    next.addEventListener("click", function () {
      if (!state.loadFraction) {
        var bar = root.querySelector(".estimate-bar");
        if (bar) bar.classList.add("is-nudge");
        var first = root.querySelector(".load-card input");
        if (first) first.focus();
        return;
      }
      go("details");
    });
    var back = el("button", { class: "btn btn--ghost", type: "button", text: "Back" });
    back.addEventListener("click", function () { go("zip"); });
    actions.appendChild(next);
    actions.appendChild(back);
    wrap.appendChild(actions);

    return wrap;
  }

  function estimateBar() {
    var bar = el("div", { class: "estimate-bar" });
    var left = el("div");
    left.appendChild(el("span", { class: "estimate-label", text: "Your estimate" }));
    left.appendChild(el("span", { class: "estimate-value", id: "estimate-value", "aria-live": "polite", text: "—" }));
    bar.appendChild(left);
    bar.appendChild(el("p", {
      class: "estimate-disclaimer",
      html: "<strong>This is an estimate, not a quote.</strong> A supervisor confirms the real price " +
        "after seeing the job, and it can come out higher or lower. Nothing is owed until then.",
    }));
    return bar;
  }

  function syncEstimate() {
    var node = document.getElementById("estimate-value");
    if (!node) return;
    node.textContent = state.loadFraction ? formatCents(estimateCents()) : "—";
    var bar = root.querySelector(".estimate-bar");
    if (bar) bar.classList.remove("is-nudge");
  }

  /* --- Step 3: details ------------------------------------------------ */

  function renderDetailsStep() {
    var wrap = el("div", { class: "wiz-panel" });
    wrap.appendChild(el("h2", { text: "Where and when" }));
    wrap.appendChild(el("p", {
      class: "lead",
      text: "Name and phone are all we truly need. Everything else saves us a call — fill in what you know.",
    }));

    var form = el("form", { class: "details-form", novalidate: "novalidate" });
    form.innerHTML = [
      '<div class="field-row">',
      '  <div class="field"><label for="d-name">Your name *</label>',
      '    <input id="d-name" type="text" autocomplete="name" required></div>',
      '  <div class="field"><label for="d-phone">Phone *</label>',
      '    <input id="d-phone" type="tel" autocomplete="tel" required></div>',
      "</div>",
      '<div class="field"><label for="d-email">Email <span class="field-optional">(optional)</span></label>',
      '  <input id="d-email" type="email" autocomplete="email"></div>',
      '<div class="field-row">',
      '  <div class="field"><label for="d-address">Street address <span class="field-optional">(optional)</span></label>',
      '    <input id="d-address" type="text" autocomplete="street-address"></div>',
      '  <div class="field"><label for="d-city">City</label>',
      '    <input id="d-city" type="text" autocomplete="address-level2"></div>',
      "</div>",
      '<div class="field"><label for="d-description">What are we hauling?</label>',
      '  <textarea id="d-description" placeholder="A couch, two mattresses and about ten bags of garage stuff."></textarea></div>',
      '<div class="field-row">',
      '  <div class="field"><label for="d-location">Where is it?</label>',
      '    <select id="d-location">',
      '      <option value="">Pick one</option>',
      '      <option value="curbside">Curbside</option>',
      '      <option value="garage">Garage</option>',
      '      <option value="inside">Inside the house</option>',
      '      <option value="upstairs">Upstairs</option>',
      '      <option value="basement">Basement</option>',
      '      <option value="yard">Yard</option>',
      "    </select></div>",
      '  <div class="field"><label for="d-stairs">Flights of stairs</label>',
      '    <input id="d-stairs" type="number" min="0" max="20" step="1" value="0"></div>',
      "</div>",
      '<div class="field"><label for="d-parking">Where can the truck park? <span class="field-optional">(optional)</span></label>',
      '  <input id="d-parking" type="text" placeholder="Alley behind the house, or the driveway"></div>',
      '<div class="field"><label for="d-access">Gate codes, dogs, anything else <span class="field-optional">(optional)</span></label>',
      '  <input id="d-access" type="text" placeholder="Gate code 1234, friendly dog in the yard"></div>',
      '<div class="field"><label for="d-timeframe">When would you like it gone?</label>',
      '  <select id="d-timeframe">',
      '    <option value="">No preference</option>',
      '    <option value="asap">As soon as possible</option>',
      '    <option value="this_week">This week</option>',
      '    <option value="flexible">I\'m flexible</option>',
      "  </select></div>",
      '<label class="check"><input id="d-commercial" type="checkbox">',
      '  <span>This is for a business</span></label>',
      // Off-screen rather than display:none — some bots skip hidden inputs
      // but fill anything focusable. A person never sees or tabs to it.
      '<div class="hp" aria-hidden="true">',
      '  <label for="d-company">Company</label>',
      '  <input id="d-company" type="text" tabindex="-1" autocomplete="off">',
      "</div>",
      '<div class="turnstile-slot" id="d-turnstile"></div>',
      '<label class="check check--gate"><input id="d-adult" type="checkbox" required>',
      '  <span>I am 18 or older, and I agree to the',
      '    <a href="/terms.html" target="_blank" rel="noopener">Terms of Service</a> and',
      '    <a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>',
      '<p id="details-error" class="field-error" role="alert"></p>',
    ].join("\n");

    // Restore anything already entered.
    form.querySelector("#d-name").value = state.customerName;
    form.querySelector("#d-phone").value = state.phone;
    form.querySelector("#d-email").value = state.email;
    form.querySelector("#d-address").value = state.address;
    form.querySelector("#d-city").value = state.city;
    form.querySelector("#d-description").value = state.description;
    form.querySelector("#d-location").value = state.itemsLocation;
    form.querySelector("#d-stairs").value = String(state.stairsFlights);
    form.querySelector("#d-parking").value = state.parkingNotes;
    form.querySelector("#d-access").value = state.accessNotes;
    form.querySelector("#d-timeframe").value = state.preferredTimeframe;
    form.querySelector("#d-commercial").checked = state.isCommercial;
    form.querySelector("#d-adult").checked = state.isAdult;
    form.querySelector("#d-company").value = state.company;

    form.addEventListener("input", captureDetails);
    form.addEventListener("change", captureDetails);

    function captureDetails() {
      state.customerName = form.querySelector("#d-name").value.trim();
      state.phone = form.querySelector("#d-phone").value.trim();
      state.email = form.querySelector("#d-email").value.trim();
      state.address = form.querySelector("#d-address").value.trim();
      state.city = form.querySelector("#d-city").value.trim();
      state.description = form.querySelector("#d-description").value.trim();
      state.itemsLocation = form.querySelector("#d-location").value;
      state.stairsFlights = parseInt(form.querySelector("#d-stairs").value, 10) || 0;
      state.parkingNotes = form.querySelector("#d-parking").value.trim();
      state.accessNotes = form.querySelector("#d-access").value.trim();
      state.preferredTimeframe = form.querySelector("#d-timeframe").value;
      state.isCommercial = form.querySelector("#d-commercial").checked;
      state.isAdult = form.querySelector("#d-adult").checked;
      state.company = form.querySelector("#d-company").value;
    }

    mountTurnstile(form.querySelector("#d-turnstile"));

    wrap.appendChild(form);

    // Recap of what they picked, so the estimate is visible at the point of
    // submission rather than a step behind them.
    var recap = el("div", { class: "recap" });
    recap.appendChild(el("h4", { text: "What you selected" }));
    var ul = el("ul", { class: "recap-list" });
    ul.appendChild(recapRow(state.loadFraction.label, formatCents(state.loadFraction.priceCents)));
    Object.keys(state.surcharges).forEach(function (key) {
      var qty = state.surcharges[key];
      if (!qty) return;
      var item = findSurcharge(key);
      if (item) ul.appendChild(recapRow(item.label + " × " + qty, formatCents(item.priceCents * qty)));
    });
    recap.appendChild(ul);
    var total = el("p", { class: "recap-total" });
    total.appendChild(el("span", { text: "Estimate" }));
    total.appendChild(el("strong", { text: formatCents(estimateCents()) }));
    recap.appendChild(total);
    recap.appendChild(el("p", {
      class: "estimate-disclaimer",
      html: "<strong>An estimate, not a quote.</strong> The price is set by a supervisor once " +
        "they've seen the job. We don't take payment through this form.",
    }));
    wrap.appendChild(recap);

    var actions = el("div", { class: "btn-row wiz-actions" });
    var submit = el("button", { class: "btn btn--primary", type: "button", text: "Send My Request" });
    submit.addEventListener("click", function () {
      captureDetails();
      var err = form.querySelector("#details-error");
      if (!state.customerName || !state.phone) {
        err.textContent = "We need a name and a phone number — that’s how we get back to you.";
        form.querySelector(state.customerName ? "#d-phone" : "#d-name").focus();
        return;
      }
      if (!state.isAdult) {
        err.textContent = "Please confirm you are 18 or older before sending this.";
        form.querySelector("#d-adult").focus();
        return;
      }
      err.textContent = "";
      send({ incompleteIntake: false }, submit);
    });
    var back = el("button", { class: "btn btn--ghost", type: "button", text: "Back" });
    back.addEventListener("click", function () { captureDetails(); go("load"); });
    actions.appendChild(submit);
    actions.appendChild(back);
    wrap.appendChild(actions);

    return wrap;
  }

  function recapRow(label, value) {
    var li = el("li");
    li.appendChild(el("span", { text: label }));
    li.appendChild(el("span", { text: value }));
    return li;
  }

  /* ------------------------------------------------------------ Submit -- */

  function buildPayload(opts) {
    var surcharges = [];
    Object.keys(state.surcharges).forEach(function (key) {
      var qty = state.surcharges[key];
      if (!qty) return;
      var item = findSurcharge(key);
      if (item) surcharges.push({ key: key, quantity: qty, unitPriceCents: item.priceCents });
    });

    return {
      customerName: state.customerName,
      phone: state.phone,
      zip: state.zip,
      state: state.stateCode || null,
      loadFraction: state.loadFraction ? state.loadFraction.key : null,
      calculatorEstimateCents: state.loadFraction ? estimateCents() : null,

      email: state.email || null,
      address: state.address || null,
      city: state.city || null,
      description: state.description || null,
      surcharges: surcharges,
      estMinutes: state.loadFraction ? state.loadFraction.estMinutes : null,
      itemsLocation: state.itemsLocation || null,
      stairsFlights: state.stairsFlights || 0,
      parkingNotes: state.parkingNotes || null,
      preferredTimeframe: state.preferredTimeframe || null,
      accessNotes: state.accessNotes || null,
      isCommercial: !!state.isCommercial,
      isAdult: !!state.isAdult,
      company: state.company || "",
      turnstileToken: state.turnstileToken || "",

      incompleteIntake: !!opts.incompleteIntake,
      source: "website",
    };
  }

  function send(opts, button) {
    if (submitted) return;
    var original = button ? button.textContent : "";
    if (button) { button.disabled = true; button.textContent = "Sending…"; }

    fetch(API_BASE + "/api/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(buildPayload(opts)),
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          return { ok: res.ok && body.ok !== false, status: res.status, body: body };
        });
      })
      .then(function (result) {
        if (button) { button.disabled = false; button.textContent = original; }
        if (!result.ok) return showSendError(result.body);
        submitted = true;
        go("done", result.body);
      })
      .catch(function () {
        if (button) { button.disabled = false; button.textContent = original; }
        showSendError(null);
      });
  }

  function showSendError(body) {
    resetTurnstile();
    var target = root.querySelector("#details-error") || root.querySelector("#outside-error");
    var message = "We couldn't send that just now. Call or text (208) 503-6307 and we'll take it down directly.";
    if (body && body.errors) {
      var first = Object.keys(body.errors)[0];
      if (first) message = body.errors[first];
    }
    if (target) { target.textContent = message; target.scrollIntoView({ block: "center" }); }
  }

  /* --- Partial lead capture ------------------------------------------- */

  // A form that only submits when perfect loses leads. Once we have enough to
  // call someone back, hand it over even if they walk away mid-flow.
  function sendPartialIfUseful() {
    if (submitted || partialSent) return;
    if (!state.customerName || !state.phone || !state.zip) return;
    // No attestation, no lead. Someone who typed a name and left without
    // confirming their age is exactly the person we must not keep.
    if (!state.isAdult) return;

    // Turnstile, when it is on, only mounts on the two forms that can collect
    // a name and a phone number — so by the time this can fire, the widget has
    // been on screen and a token normally exists. If it does not, the server
    // refuses the partial. That is the right way round: a lead is worth a lot,
    // but not enough to carve a hole a script could post through.
    partialSent = true;
    try {
      fetch(API_BASE + "/api/requests", {
        method: "POST",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload({ incompleteIntake: true })),
      });
    } catch (e) { /* best effort by definition */ }
  }

  window.addEventListener("pagehide", sendPartialIfUseful);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") sendPartialIfUseful();
  });

  /* -------------------------------------------------------------- Done -- */

  function renderDoneStep(result) {
    var wrap = el("div", { class: "wiz-panel wiz-panel--done" });
    wrap.appendChild(el("div", { class: "done-mark", html:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 12.5 5 5L20 6.5"/></svg>' }));
    wrap.appendChild(el("h2", { text: "Got it — that's with us" }));

    var ref = result && (result.reference || result.jobId);
    if (ref) {
      var refBox = el("p", { class: "done-ref" });
      refBox.appendChild(el("span", { text: "Your reference" }));
      refBox.appendChild(el("strong", { text: String(ref) }));
      wrap.appendChild(refBox);
    }

    wrap.appendChild(el("p", {
      class: "lead",
      text: "A supervisor reviews it and calls you back on the number you gave us. They'll confirm the " +
        "real price and sort out a time — nothing is booked or owed until you've spoken to them.",
    }));
    wrap.appendChild(el("p", {
      class: "form-note",
      html: "Need it sooner, or remembered something? Call or text " +
        '<a href="tel:+12085036307"><strong>(208) 503-6307</strong></a>.',
    }));
    return wrap;
  }

  /* ---------------------------------------------------------- Fallback -- */

  // Live pricing unavailable: no calculator rather than a wrong calculator.
  function renderPricingUnavailable() {
    var wrap = el("div", { class: "wiz-panel" });
    wrap.appendChild(el("h2", { text: "Let's do this by phone" }));
    wrap.appendChild(el("p", {
      class: "lead",
      text: "Our estimate tool isn't loading right now, and we'd rather not show you a number we can't " +
        "stand behind. Call or text and we'll price it properly — a photo of the pile does it fastest.",
    }));
    var actions = el("div", { class: "btn-row" });
    actions.appendChild(el("a", { class: "btn btn--primary", href: "tel:+12085036307", text: "Call (208) 503-6307" }));
    actions.appendChild(el("a", { class: "btn btn--ghost", href: "sms:+12085036307", text: "Text a Photo" }));
    wrap.appendChild(actions);
    return wrap;
  }

  /* ------------------------------------------------------------ Render -- */

  function go(step, payload) {
    state.step = step;
    render(payload);
    var heading = root.querySelector("h2");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: true });
    }
    var top = root.getBoundingClientRect().top + window.scrollY - 100;
    window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }

  function render(payload) {
    root.innerHTML = "";
    var progress = renderProgress();
    if (progress) root.appendChild(progress);

    if (state.step === "zip") root.appendChild(renderZipStep());
    else if (state.step === "outside") root.appendChild(renderOutsideStep());
    else if (state.step === "load") root.appendChild(renderLoadStep());
    else if (state.step === "details") root.appendChild(renderDetailsStep());
    else if (state.step === "done") root.appendChild(renderDoneStep(payload));

    if (state.step === "load") syncEstimate();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* -------------------------------------------------------------- Boot -- */

  // The B2B page links here as /quote.html?type=business.
  if (new URLSearchParams(location.search).get("type") === "business") {
    state.isCommercial = true;
  }

  root.innerHTML = '<div class="wiz-loading">Loading the estimate tool…</div>';

  fetchPricing()
    .then(function (data) {
      pricing = data;
      zipIndex = {};
      pricing.serviceZips.forEach(function (z) { zipIndex[z.zip] = z; });

      if (!pricing.loadFractions.length || !pricing.serviceZips.length) {
        throw new Error("pricing payload incomplete");
      }
      render();
    })
    .catch(function (err) {
      console.error("[quote] pricing unavailable:", err);
      root.innerHTML = "";
      root.appendChild(renderPricingUnavailable());
    });
})();
