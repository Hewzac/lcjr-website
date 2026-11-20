/* ==========================================================================
   Homepage live rates — Lewis-Clark Junk Removal

   Reads GET /api/pricing (the same endpoint the quote tool uses) and fills in
   two things the homepage ships with as last-known values:

     - the ballpark picker's load prices and on-site minutes
     - the "Where we roll" town list

   Same contract as stats.js: the HTML already holds sensible values, so no
   JavaScript, a failed fetch or a missing field all leave the page as it
   shipped. Nothing here is ever blanked or zeroed.

   The picker itself needs no script. The radios drive the truck and the
   readout through :has() in style.css.
   ========================================================================== */

(function () {
  "use strict";

  var picker = document.querySelector(".loadtix[data-api-base]");
  var areas = document.querySelector("[data-areas]");
  if (!picker && !areas) return;

  var API_BASE = ((picker && picker.dataset.apiBase) || "https://app.lcjunk.com").replace(/\/$/, "");
  var TIMEOUT_MS = 5000;

  function dollars(cents) {
    var whole = Math.round(cents) / 100;
    return "$" + (whole % 1 === 0
      ? whole.toLocaleString("en-US")
      : whole.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function applyRates(fractions) {
    if (!picker) return;
    fractions.forEach(function (f) {
      var cents = num(f.priceCents != null ? f.priceCents : f.price_cents);
      var mins = num(f.estMinutes != null ? f.estMinutes : f.est_minutes);
      var price = picker.querySelector('[data-rate="' + f.key + '"]');
      var min = picker.querySelector('[data-rate-min="' + f.key + '"]');
      var label = picker.querySelector('[data-rate-label="' + f.key + '"]');
      if (price && cents !== null && cents > 0) price.textContent = dollars(cents);
      if (min && mins !== null && mins > 0) min.textContent = String(mins);
      if (label && f.label) label.textContent = f.label;
      // The hero’s “from” price is the smallest load.
      if (f.key === "eighth" && cents !== null && cents > 0) {
        document.querySelectorAll("[data-rate-from]").forEach(function (n) { n.textContent = dollars(cents); });
      }
    });
  }

  function applyAreas(zips) {
    if (!areas || !zips.length) return;
    var byState = {};
    zips.forEach(function (z) {
      if (typeof z === "string" || !z.city || !z.state) return;
      (byState[z.state] = byState[z.state] || []).push(z);
    });

    areas.querySelectorAll("[data-areas-state]").forEach(function (list) {
      var rows = byState[list.dataset.areasState];
      // A state the API doesn't mention keeps its shipped list rather than
      // emptying — an empty column reads as "we stopped serving there".
      if (!rows || !rows.length) return;

      // Keep the shipped order (Lewiston and Clarkston lead) for towns already
      // listed; anything new the API adds goes after them, alphabetically.
      var shipped = Array.prototype.map.call(list.querySelectorAll("li > span:first-child"), function (s) {
        return s.textContent.trim();
      });
      rows.sort(function (a, b) {
        var ia = shipped.indexOf(a.city), ib = shipped.indexOf(b.city);
        if (ia === -1) ia = Infinity;
        if (ib === -1) ib = Infinity;
        return ia === ib ? a.city.localeCompare(b.city) : ia - ib;
      });

      list.textContent = "";
      rows.forEach(function (z) {
        var li = document.createElement("li");
        var name = document.createElement("span");
        name.textContent = z.city;
        var zip = document.createElement("span");
        zip.className = "route-zip";
        zip.textContent = String(z.zip);
        li.appendChild(name);
        li.appendChild(zip);
        list.appendChild(li);
      });
    });
  }

  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);

  fetch(API_BASE + "/api/pricing", {
    signal: controller.signal,
    headers: { Accept: "application/json" },
  })
    .then(function (res) {
      if (!res.ok) throw new Error("pricing " + res.status);
      return res.json();
    })
    .then(function (raw) {
      clearTimeout(timer);
      if (!raw || typeof raw !== "object") return;
      applyRates(raw.loadFractions || raw.load_fractions || []);
      applyAreas(raw.serviceZips || raw.service_zips || []);
    })
    .catch(function (err) {
      clearTimeout(timer);
      console.warn("[home] live rates unavailable, showing last known:", err.message);
    });
})();

/* ==========================================================================
   Jobs carousel: one card in front, its neighbours peeking either side.

   Without JavaScript the cards are a row you can scroll sideways. With it,
   the row becomes a stage: arrows, dots, swipe, the arrow keys, or a click
   on a neighbouring card bring that card to the front. It advances on its
   own every few seconds, and stops while the pointer or keyboard focus is
   on it, while it is off screen, or for good once the pause button is
   pressed. Visitors who prefer reduced motion get no autoplay at all.
   ========================================================================== */

(function () {
  "use strict";

  var carousel = document.querySelector("[data-carousel]");
  if (!carousel) return;

  var track = carousel.querySelector(".carousel-track");
  var slides = Array.prototype.slice.call(track.children);
  var n = slides.length;
  if (n < 3) return;

  var prev = carousel.querySelector(".carousel-prev");
  var next = carousel.querySelector(".carousel-next");
  var dotsBox = carousel.querySelector(".carousel-dots");
  var play = carousel.querySelector(".carousel-play");

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var INTERVAL = 4500;

  var active = 0;
  var timer = 0;
  var paused = reduced;     // the visitor's choice (or their motion setting)
  var holding = false;      // pointer or focus is on the carousel
  var onScreen = true;
  var last = [];

  carousel.classList.add("is-stage");
  track.removeAttribute("tabindex");

  var dots = slides.map(function (li, i) {
    li.setAttribute("aria-roledescription", "slide");
    li.setAttribute("aria-label", (i + 1) + " of " + n);
    var title = li.querySelector("h3");
    var b = document.createElement("button");
    b.type = "button";
    b.className = "carousel-dot";
    b.setAttribute("aria-label", "Show " + (title ? title.textContent : "card " + (i + 1)));
    b.addEventListener("click", function () { go(i); });
    if (dotsBox) dotsBox.appendChild(b);
    return b;
  });

  // Where card i sits relative to the front card: 0 in front, -1 to its
  // left, 1 to its right, and so on, wrapping around the ends.
  function offset(i) {
    var d = ((i - active) % n + n) % n;
    return d > n / 2 ? d - n : d;
  }

  function render() {
    slides.forEach(function (li, i) {
      var d = offset(i);
      var a = Math.abs(d);
      // A card wrapping from one end to the other moves while invisible;
      // skip its transition so it doesn't streak across the stage.
      var jump = last[i] !== undefined && Math.abs(d - last[i]) > 1;
      if (jump) li.style.transition = "none";
      li.style.setProperty("--d", d);
      li.style.setProperty("--s", a === 0 ? 1 : a === 1 ? 0.86 : 0.74);
      li.style.setProperty("--o", a === 0 ? 1 : a === 1 ? 0.5 : a === 2 ? 0.14 : 0);
      li.style.setProperty("--z", String(10 - a));
      li.classList.toggle("is-active", d === 0);
      li.classList.toggle("is-far", a > 1);
      li.setAttribute("aria-hidden", d === 0 ? "false" : "true");
      var link = li.querySelector("a");
      if (link) link.tabIndex = d === 0 ? 0 : -1;
      if (jump) { void li.offsetWidth; li.style.transition = ""; }
      last[i] = d;
    });
    dots.forEach(function (b, i) { b.setAttribute("aria-current", i === active ? "true" : "false"); });
  }

  function schedule() {
    clearTimeout(timer);
    if (!paused && !holding && onScreen && !document.hidden) {
      timer = setTimeout(function () { go(active + 1); }, INTERVAL);
    }
  }

  function go(i) {
    active = ((i % n) + n) % n;
    render();
    schedule();
  }

  function setPaused(p) {
    paused = p;
    if (play) {
      play.classList.toggle("is-paused", p);
      play.setAttribute("aria-label", p ? "Play" : "Pause");
    }
    // Announce changes only when the visitor is driving.
    track.setAttribute("aria-live", p ? "polite" : "off");
    schedule();
  }

  if (prev) prev.addEventListener("click", function () { go(active - 1); });
  if (next) next.addEventListener("click", function () { go(active + 1); });
  if (play && !reduced) {
    play.hidden = false;
    play.addEventListener("click", function () { setPaused(!paused); });
  }

  // Clicking a card beside the front one brings it forward instead of
  // following its link. A drag is a swipe, not a click.
  var startX = null, dragged = false;
  track.addEventListener("pointerdown", function (e) { startX = e.clientX; dragged = false; });
  track.addEventListener("pointerup", function (e) {
    if (startX === null) return;
    var dx = e.clientX - startX;
    startX = null;
    if (Math.abs(dx) > 40) { dragged = true; go(active + (dx < 0 ? 1 : -1)); }
  });
  track.addEventListener("pointercancel", function () { startX = null; });
  track.addEventListener("click", function (e) {
    var li = e.target.closest("li");
    if (dragged) { e.preventDefault(); dragged = false; return; }
    if (li && !li.classList.contains("is-active")) {
      e.preventDefault();
      go(slides.indexOf(li));
    }
  });

  carousel.addEventListener("keydown", function (e) {
    if (e.key === "ArrowLeft") { e.preventDefault(); go(active - 1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); go(active + 1); }
  });

  carousel.addEventListener("mouseenter", function () { holding = true; schedule(); });
  carousel.addEventListener("mouseleave", function () { holding = false; schedule(); });
  carousel.addEventListener("focusin", function () { holding = true; schedule(); });
  carousel.addEventListener("focusout", function (e) {
    if (!carousel.contains(e.relatedTarget)) { holding = false; schedule(); }
  });
  document.addEventListener("visibilitychange", schedule);
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      onScreen = entries[0].isIntersecting;
      schedule();
    }, { threshold: 0.35 }).observe(carousel);
  }

  render();
  setPaused(paused);
})();

/* ==========================================================================
   Phone slider: the price tool, the steps and the service area.

   Up to 900px wide those three cards sit side by side and slide across
   one at a time: tap a button above them or swipe. The row eases to the
   new card and its height eases to fit it, so a short card leaves no gap.
   Cards out of view are inert, so the keyboard and screen readers only
   meet the one showing. On a wider screen the wrappers drop away (CSS),
   the cards join the grid, and this stands down.
   ========================================================================== */

(function () {
  "use strict";

  var slider = document.querySelector("[data-slider]");
  if (!slider) return;

  var track = slider.querySelector(".slider-track");
  var tabs = Array.prototype.slice.call(slider.querySelectorAll(".slider-tabs button"));
  var slides = Array.prototype.slice.call(track.children);
  var narrow = window.matchMedia("(max-width: 900px)");
  var current = 0;

  function fit() {
    track.style.height = narrow.matches ? slides[current].offsetHeight + "px" : "";
  }

  function go(i) {
    current = Math.max(0, Math.min(slides.length - 1, i));
    slider.style.setProperty("--i", current);
    tabs.forEach(function (t, k) {
      if (k === current) t.setAttribute("aria-current", "true");
      else t.removeAttribute("aria-current");
    });
    slides.forEach(function (s, k) {
      var off = narrow.matches && k !== current;
      s.classList.toggle("is-off", off);
      if (off) s.setAttribute("inert", "");
      else s.removeAttribute("inert");
    });
    fit();
  }

  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () { go(i); });
  });

  // Swipe: the row follows the finger, then settles on the nearest card.
  // Mostly-vertical drags are left to the page so it still scrolls.
  var startX = 0, startY = 0, dx = 0, dragging = false, decided = false;
  track.addEventListener("pointerdown", function (e) {
    if (!narrow.matches || e.pointerType === "mouse") return;
    startX = e.clientX; startY = e.clientY; dx = 0;
    dragging = true; decided = false;
  });
  track.addEventListener("pointermove", function (e) {
    if (!dragging) return;
    var mx = e.clientX - startX, my = e.clientY - startY;
    if (!decided) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      decided = true;
      if (Math.abs(my) > Math.abs(mx)) { dragging = false; return; }
      track.classList.add("is-dragging");
    }
    // A little resistance past the first and last card.
    var edge = (current === 0 && mx > 0) || (current === slides.length - 1 && mx < 0);
    dx = edge ? mx * 0.3 : mx;
    track.style.setProperty("--drag", dx + "px");
  });
  function release() {
    if (!dragging) return;
    dragging = false;
    track.classList.remove("is-dragging");
    track.style.setProperty("--drag", "0px");
    var w = track.offsetWidth;
    if (dx < -w * 0.18) go(current + 1);
    else if (dx > w * 0.18) go(current - 1);
    dx = 0;
  }
  track.addEventListener("pointerup", release);
  track.addEventListener("pointercancel", release);

  // The nav's "Areas" link lands on the service area card.
  function fromHash() {
    var i = slides.findIndex(function (s) { return s.id && "#" + s.id === location.hash; });
    if (i > -1 && narrow.matches) go(i);
  }
  window.addEventListener("hashchange", fromHash);

  if ("ResizeObserver" in window) {
    var ro = new ResizeObserver(fit);
    slides.forEach(function (s) { ro.observe(s); });
  }
  window.addEventListener("resize", fit);
  if (narrow.addEventListener) narrow.addEventListener("change", function () { go(current); });

  slider.classList.add("is-ready");
  go(0);
  fromHash();
})();
