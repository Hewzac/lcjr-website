/* LC Junk Removal — progressive enhancement only.
   Every page works with JavaScript disabled. */

(function () {
  "use strict";

  /* ------------------------------------------------------- Mobile nav -- */
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.getElementById("primary-nav");

  if (toggle && nav) {
    var setOpen = function (open) {
      toggle.setAttribute("aria-expanded", String(open));
      nav.classList.toggle("is-open", open);
    };

    toggle.addEventListener("click", function () {
      setOpen(toggle.getAttribute("aria-expanded") !== "true");
    });

    // Close after tapping a link, or on Escape.
    nav.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
        setOpen(false);
        toggle.focus();
      }
    });

    // Reset state when the menu stops being a drawer.
    var wide = window.matchMedia("(min-width: 901px)");
    var onWide = function (e) { if (e.matches) setOpen(false); };
    if (wide.addEventListener) wide.addEventListener("change", onWide);
    else if (wide.addListener) wide.addListener(onWide);
  }

  /* --------------------------------------------------- Sticky header -- */
  var header = document.querySelector(".site-header");

  if (header) {
    var syncHeader = function () {
      header.classList.toggle("is-stuck", window.scrollY > 8);
    };
    syncHeader();
    window.addEventListener("scroll", syncHeader, { passive: true });
  }

  /* -------------------------------------------------- Reveal on scroll -- */
  var pending = Array.prototype.slice.call(document.querySelectorAll(".reveal"));
  if (!pending.length) return;

  var show = function (el) { el.classList.add("is-visible"); };

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    pending.forEach(show);
    return;
  }

  // Rect math rather than IntersectionObserver: fewer moving parts, and it
  // cannot leave content stuck at opacity 0 if an observer never fires.
  var sync = function () {
    var limit = window.innerHeight - 60;
    pending = pending.filter(function (el) {
      if (el.getBoundingClientRect().top > limit) return true;
      show(el);
      return false;
    });
    if (!pending.length) {
      window.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
    }
  };

  sync();
  window.addEventListener("scroll", sync, { passive: true });
  window.addEventListener("resize", sync);
  window.addEventListener("load", sync);
})();
