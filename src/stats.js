/* ==========================================================================
   Live homepage stats — Lewis-Clark Junk Removal

   Reads GET /api/stats from the ops app and swaps the figures into the stats
   band. The markup ships with the last known values already in it, so:

     - no JavaScript            → the HTML numbers stand
     - fetch fails or times out → the HTML numbers stand
     - endpoint answers         → the real numbers replace them

   It never blanks the section and never writes a zero it did not receive.
   A homepage showing "0 lbs" because a Worker was briefly unreachable is
   worse than one showing a figure that is a few days stale.
   ========================================================================== */

(function () {
  "use strict";

  var section = document.querySelector(".stats[data-api-base]");
  if (!section) return;

  var API_BASE = (section.dataset.apiBase || "").replace(/\/$/, "");
  if (!API_BASE) return;

  var TIMEOUT_MS = 5000;

  function formatPounds(n) {
    return n.toLocaleString("en-US") + " lbs";
  }

  var FORMAT = {
    poundsRemoved: formatPounds,
    jobsCompleted: function (n) { return n.toLocaleString("en-US"); },
    signedOffPct: function (n) { return n + "%"; },
  };

  function apply(stats) {
    section.querySelectorAll("[data-stat]").forEach(function (node) {
      var key = node.dataset.stat;
      var value = stats[key];

      // null is meaningful: the server sends it for a percentage that has no
      // denominator yet. Leave the shipped value rather than print "null%".
      if (typeof value !== "number" || !isFinite(value)) return;

      var text = (FORMAT[key] || String)(value);
      if (text === node.textContent.trim()) return;

      node.textContent = text;
      // Brief highlight so a number that changes under the reader is noticed
      // rather than silently swapping.
      node.classList.add("is-fresh");
    });
  }

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
      // Deliberately quiet for the visitor — the fallback numbers are already
      // on screen and correct enough.
      console.warn("[stats] live figures unavailable, showing last known:", err.message);
    });
})();
