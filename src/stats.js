/* ==========================================================================
   Live homepage stats: Lewis-Clark Junk Removal

   Reads GET /api/stats from the ops app and swaps the figures into the
   "real numbers" card. The markup ships with the last known values already
   in it, so:

     - no JavaScript            → the HTML numbers stand
     - fetch fails or times out → the HTML numbers stand
     - endpoint answers         → the real numbers replace them

   It never blanks the card and never writes a zero it did not receive.
   A homepage showing "0 lbs" because a Worker was briefly unreachable is
   worse than one showing a figure that is a few days stale.

   When the card scrolls into view the figures count up to their values
   (skipped for visitors who prefer reduced motion).
   ========================================================================== */

(function () {
  "use strict";

  var section = document.querySelector(".stats[data-api-base]");
  if (!section) return;

  var API_BASE = (section.dataset.apiBase || "").replace(/\/$/, "");
  var TIMEOUT_MS = 5000;
  var COUNT_MS = 1400;
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // The unit sits in a smaller span after the number.
  var UNIT = { poundsRemoved: " lbs", signedOffPct: "%" };

  var nodes = Array.prototype.slice.call(section.querySelectorAll("[data-stat]"));

  function render(node, n) {
    var r = Math.round(n);
    // Past 10,000 the full figure would outgrow its column: 12.5k instead.
    node.textContent = r >= 10000
      ? (Math.round(r / 100) / 10).toLocaleString("en-US") + "k"
      : r.toLocaleString("en-US");
    var unit = UNIT[node.dataset.stat];
    if (unit) {
      var u = document.createElement("span");
      u.className = "stat-unit";
      u.textContent = unit;
      node.appendChild(u);
    }
  }

  // Each figure's target, read from what shipped in the HTML.
  nodes.forEach(function (node) {
    var n = parseInt(node.textContent.replace(/[^\d]/g, ""), 10);
    node._target = isFinite(n) ? n : null;
    node._counting = false;
  });

  function countUp() {
    var start = null;
    nodes.forEach(function (node) { if (node._target !== null) node._counting = true; });
    function frame(t) {
      if (start === null) start = t;
      var p = Math.min(1, (t - start) / COUNT_MS);
      var eased = 1 - Math.pow(1 - p, 3);
      nodes.forEach(function (node) {
        if (!node._counting) return;
        // Reads the target every frame, so a live figure that lands mid-count
        // is where the count ends.
        render(node, node._target * eased);
        if (p === 1) node._counting = false;
      });
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  if (!reduced && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting) return;
      io.disconnect();
      countUp();
    }, { threshold: 0.4 });
    io.observe(section);
  }

  function apply(stats) {
    nodes.forEach(function (node) {
      var value = stats[node.dataset.stat];

      // null is meaningful: the server sends it for a percentage that has no
      // denominator yet. Leave the shipped value rather than print "null%".
      if (typeof value !== "number" || !isFinite(value)) return;
      if (value === node._target) return;

      node._target = value;
      if (node._counting) return;
      render(node, value);
      // Brief highlight so a number that changes under the reader is noticed
      // rather than silently swapping.
      node.classList.add("is-fresh");
    });
  }

  if (!API_BASE) return;

  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);

  fetch(API_BASE + "/api/stats", {
    signal: controller.signal,
    headers: { Accept: "application/json" },
  })
    .then(function (res) {
      if (!res.ok) throw new Error("stats " + res.status);
      return res.json();
    })
    .then(function (stats) {
      clearTimeout(timer);
      if (stats && typeof stats === "object") apply(stats);
    })
    .catch(function (err) {
      clearTimeout(timer);
      // Deliberately quiet for the visitor: the fallback numbers are already
      // on screen and correct enough.
      console.warn("[stats] live figures unavailable, showing last known:", err.message);
    });
})();
