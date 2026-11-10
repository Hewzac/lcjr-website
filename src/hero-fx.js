/* ==========================================================================
   Homepage hero texture — Lewis-Clark Junk Removal

   A canvas behind the headline that gives the first screen some life and
   reacts to the cursor. Treatments, chosen by data-fx on .hero:

     yard   The dot field and the junk toss together (default).
     toss   Junk you can grab and throw into the back of a pickup. When the
            last piece is in, the truck drives off and comes back empty for
            another load. On a phone, tapping a piece lobs it at the truck —
            no dragging, so the page still scrolls normally.
     field  A quiet dot texture. A slow cursor barely stirs it; a fast one
            leaves a green glow that fades.
     drift  Junk outlines floating slowly, shifting with the cursor.
     none   Off.

   Purely decorative: the canvas is aria-hidden, nothing here is needed to
   use the page, the headline and buttons sit on top and stay clickable, and
   it pauses whenever the hero is off screen or the tab is hidden. Under
   prefers-reduced-motion it draws a single still frame and never animates.
   ========================================================================== */

(function () {
  "use strict";

  var hero = document.querySelector(".hero[data-fx]");
  var stage = hero && hero.querySelector(".hero-main");
  if (!stage || !window.HTMLCanvasElement || !window.Path2D) return;

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var canvas = document.createElement("canvas");
  canvas.className = "hero-fx";
  canvas.setAttribute("aria-hidden", "true");
  stage.insertBefore(canvas, stage.firstChild);
  var ctx = canvas.getContext("2d");

  var W = 0, H = 0, DPR = 1;
  // Assume touch on a touchscreen until a mouse says otherwise, so the hint
  // reads "Tap the junk" before anyone has touched anything.
  var pointer = {
    x: -9999, y: -9999, lx: -9999, ly: -9999, inside: false,
    vx: 0, vy: 0, speed: 0, energy: 0,
    type: window.matchMedia("(pointer: coarse)").matches ? "touch" : "mouse",
  };
  var mode = null;
  var raf = 0;
  var onScreen = true;

  var css = getComputedStyle(document.documentElement);
  var COLOR = {
    brand: (css.getPropertyValue("--brand-hi") || "#2bc06c").trim(),
    ink: (css.getPropertyValue("--ink") || "#f5f5f7").trim(),
    grey: "rgba(161, 161, 166, 0.62)",
    font: (css.getPropertyValue("--font-body") || "system-ui").trim(),
  };

  function rand(a, b) { return a + Math.random() * (b - a); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /* Junk, as 24-unit outline icons in the site's drawing style. Closed
     shapes get a faint fill so each piece reads as a solid object. */
  var JUNK = [
    // cardboard box, taped
    "M3 8l9-4.5L21 8v9l-9 4.5L3 17z M3 8l9 4.5L21 8 M12 12.5v9 M7.5 5.75l9 4.5",
    // couch
    "M5.5 11.5V8.5A2.5 2.5 0 0 1 8 6h8a2.5 2.5 0 0 1 2.5 2.5v3 M2 13a2 2 0 0 1 4 0v2.5h12V13a2 2 0 0 1 4 0v5.5H2z M12 6v9.5 M4.5 18.5v2M19.5 18.5v2",
    // tire
    "M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18z M12 8a4 4 0 1 1 0 8a4 4 0 1 1 0-8z M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7",
    // office chair
    "M8 2.5h8a1 1 0 0 1 1 1V11H7V3.5a1 1 0 0 1 1-1z M5 11h14v2.5H5z M12 13.5v4 M6.5 21l5.5-3.5 5.5 3.5 M12 17.5V21",
    // floor lamp
    "M8 2.5h8l3 7H5z M12 9.5v9.5 M8.5 21.5a3.5 2.5 0 0 1 7 0z M15.5 9.5v3",
    // old tv
    "M3 8h18v12.5H3z M8 3.5l4 4.5 4-4.5 M5.5 10.5h10v7.5h-10z M18.5 12v.01M18.5 15v.01",
    // mattress
    "M3 8.5h18a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V9.5a1 1 0 0 1 1-1z M6.5 12.25v.01M12 12.25v.01M17.5 12.25v.01 M4.5 16v3M19.5 16v3",
    // trash bag, tied
    "M7.5 9.5C5 12 4.5 15.5 5.5 18.5 6.2 20.5 8.5 21.5 12 21.5s5.8-1 6.5-3c1-3 .5-6.5-2-9z M7.5 9.5h9 M10 9.5 8.5 4.5l3.5 2 3.5-2-1.5 5",
    // fridge
    "M6 2.5h12v19H6z M6 9.5h12 M9 5v2.5 M9 12v4 M7.5 21.5v1M16.5 21.5v1",
    // washer
    "M4 2.5h16v19H4z M4 6.5h16 M6.75 4.5v.01M9.5 4.5v.01 M12 9.5a4.75 4.75 0 1 1 0 9.5a4.75 4.75 0 1 1 0-9.5z M9.5 15a2.5 2.5 0 0 0 3.5 1.5",
    // dresser
    "M4 3h16v15.5H4z M4 8.2h16M4 13.4h16 M11 5.6h2M11 10.8h2M11 16h2 M6 18.5v2.5M18 18.5v2.5",
    // pallet
    "M2 7h20v3H2z M2 14h20v3H2z M4 10v4M12 10v4M20 10v4 M4 17v2.5M12 17v2.5M20 17v2.5",
  ].map(function (d) { return new Path2D(d); });

  function drawIcon(path, x, y, size, angle, stroke, alpha, fill, squash) {
    var k = size / 24;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    if (squash) ctx.scale(1 + squash * 0.18, 1 - squash * 0.16);
    ctx.rotate(angle);
    ctx.scale(k, k);
    ctx.translate(-12, -12);
    if (fill) { ctx.fillStyle = fill; ctx.fill(path, "evenodd"); }
    ctx.lineWidth = 1.8 / k;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = stroke;
    ctx.stroke(path);
    ctx.restore();
  }

  /* ------------------------------------------------------------ Field -- */

  // A grid of faint dots. The cursor's speed sets how much it disturbs
  // them: at rest or moving slowly, a gentle ripple; moving fast, the dots
  // scatter and light up green, and the glow lingers as a wake.
  function Field() {
    var dots = [];

    function build() {
      dots = [];
      var gap = W < 640 ? 22 : 28;
      for (var y = gap / 2; y < H; y += gap) {
        for (var x = gap / 2; x < W; x += gap) {
          dots.push({ bx: x, by: y, ox: 0, oy: 0, vx: 0, vy: 0, glow: 0 });
        }
      }
    }

    return {
      init: build,
      resize: build,
      // movers: fast-moving things (thrown junk) that stir the field too.
      step: function (t, movers) {
        var I = pointer.energy;
        var R = 95 + 85 * I;
        var on = pointer.inside;
        var n = movers ? movers.length : 0;
        for (var i = 0; i < dots.length; i++) {
          var d = dots[i];
          var tx = Math.sin(t * 0.0005 + d.by * 0.018) * 0.5;
          var ty = Math.cos(t * 0.0004 + d.bx * 0.015) * 0.5;
          var target = 0;
          if (on) {
            var dx = d.bx - pointer.x, dy = d.by - pointer.y;
            if (dx < R && dx > -R && dy < R && dy > -R) {
              var dist = Math.sqrt(dx * dx + dy * dy) || 1;
              if (dist < R) {
                var f = 1 - dist / R;
                var push = f * f * (2 + 12 * I);
                tx += (dx / dist) * push;
                ty += (dy / dist) * push;
                // The wake: dots get dragged a little along the stroke.
                d.vx += pointer.vx * f * 0.03 * I;
                d.vy += pointer.vy * f * 0.03 * I;
                target = f * (0.1 + 0.9 * I);
              }
            }
          }
          for (var m = 0; m < n; m++) {
            var mv = movers[m];
            var ex = d.bx - mv.x, ey = d.by - mv.y;
            if (ex > 80 || ex < -80 || ey > 80 || ey < -80) continue;
            var ed = Math.sqrt(ex * ex + ey * ey) || 1;
            if (ed < 80) {
              var g = 1 - ed / 80;
              tx += (ex / ed) * g * g * 8 * mv.k;
              ty += (ey / ed) * g * g * 8 * mv.k;
              if (g * 0.7 * mv.k > target) target = g * 0.7 * mv.k;
            }
          }
          // Heavily damped: dots ease to where they belong without bouncing.
          d.vx += (tx - d.ox) * 0.06;
          d.vy += (ty - d.oy) * 0.06;
          d.vx *= 0.62;
          d.vy *= 0.62;
          d.ox += d.vx;
          d.oy += d.vy;
          // Light up quickly, fade slowly.
          d.glow += (target - d.glow) * (target > d.glow ? 0.3 : 0.035);
        }
      },
      draw: function () {
        var rest = "rgba(255, 255, 255, 0.085)";
        for (var i = 0; i < dots.length; i++) {
          var d = dots[i];
          ctx.fillStyle = d.glow > 0.03
            ? "rgba(43, 192, 108, " + (0.12 + d.glow * 0.75).toFixed(3) + ")"
            : rest;
          ctx.beginPath();
          ctx.arc(d.bx + d.ox, d.by + d.oy, 1.05 + d.glow * 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      },
    };
  }

  /* ------------------------------------------------------------- Toss -- */

  function Toss() {
    var items = [];
    var loaded = [];      // junk sitting in the bed
    var sparks = [];      // particles and "+1" pops
    var held = null;
    var hovered = null;
    var hauled = 0;
    var touched = false;
    var waitUntil = 0;
    var G = 0.42, AIR = 0.995, FLOOR_FRICTION = 0.86;

    // The pickup. Drawn facing right, bed open toward the junk on the left.
    // Geometry is in units (u across from the tailgate, v up from the
    // ground) scaled by T.s.
    var T = { s: 1, x: 0, home: 0, v: 0, by: 0, bv: 0, wa: 0, state: "park" };
    var TW = 273;
    var BED_L = 10, BED_R = 143, RIM = 80;   // bed opening, in units

    function X(u) { return T.x + u * T.s; }
    function Y(v) { return H - v * T.s + T.by; }

    function layout() {
      T.s = W < 480 ? 0.5 : W < 760 ? 0.66 : W < 1100 ? 0.86 : 1;
      T.home = W - TW * T.s - Math.max(14, W * 0.045);
      if (T.state === "park") T.x = T.home;
    }

    function spawn(staticPile) {
      var n = W < 640 ? 7 : W < 1000 ? 10 : 13;
      var scale = W < 640 ? 0.8 : 1;
      var left = Math.max(60, T.home - 20);
      for (var i = 0; i < n; i++) {
        var size = rand(40, 60) * scale;
        items.push({
          path: JUNK[(i + hauled) % JUNK.length],
          s: size,
          r: size * 0.46,
          x: rand(size, Math.max(size + 1, left - size)),
          y: staticPile ? H - size * 0.46 : -rand(40, 560),
          vx: rand(-1.2, 1.2),
          vy: rand(0, 2),
          a: rand(-0.5, 0.5),
          va: rand(-0.04, 0.04),
          green: i % 4 === 1,
          hs: 0, sq: 0, cd: 0,
          gone: 0,
        });
      }
    }

    function puff(x, y, n, color, power) {
      for (var i = 0; i < n; i++) {
        sparks.push({
          x: x, y: y,
          vx: rand(-1, 1) * power, vy: -rand(0.4, 1.2) * power,
          life: 1, decay: rand(0.03, 0.05), r: rand(1.2, 2.6), color: color,
        });
      }
    }

    function haul(it) {
      if (it.gone) return;
      if (held === it) held = null;
      it.gone = 1;
      hauled += 1;
      touched = true;
      // Where it settles in the bed: four across, heaping up.
      var n = loaded.length + items.filter(function (o) { return o.gone; }).length - 1;
      var col = n % 4, row = Math.min(3, Math.floor(n / 4));
      it.slot = {
        ox: (BED_L + 4 + (col + 0.5) * 31 + rand(-5, 5)) * T.s,
        oy: (RIM - 14 + row * 10) * T.s,
        a: rand(-0.5, 0.5),
        s: Math.min(it.s * 0.78, 40 * T.s),
      };
      T.bv += 2.4 * T.s;
      puff(it.x, Y(RIM), 9, COLOR.brand, 2.6);
      sparks.push({ text: "+1", x: X(76), y: Y(RIM) - 18, vy: -0.9, life: 1, decay: 0.022 });
    }

    function hit(x, y) {
      var best = null, bestD = Infinity;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.gone) continue;
        var dx = x - it.x, dy = y - it.y;
        var d2 = dx * dx + dy * dy;
        var reach = it.r * 1.35;
        if (d2 < reach * reach && d2 < bestD) { best = it; bestD = d2; }
      }
      return best;
    }

    // Height of the cab's top edge at screen x, or null if x is off the cab.
    function cabTop(x) {
      var u = (x - T.x) / T.s;
      if (u < 147 || u > 273) return null;
      // Roof, then the windshield, then the long hood, then the bumper.
      var v = u <= 196 ? 122 : u <= 200 ? 122 - (u - 196) * 0.75 : u <= 222 ? 119 - (u - 200) * (30 / 22) :
        u <= 262 ? 89 - (u - 222) * 0.09 : 85;
      return Y(v);
    }

    function collideTruck(it) {
      var bedL = X(BED_L), bedR = X(BED_R), rim = Y(RIM);
      // Into the bed through the top.
      if (it.x > bedL + it.r * 0.25 && it.x < bedR - it.r * 0.25 && it.y + it.r * 0.3 > rim && it.vy > -2) {
        haul(it);
        return;
      }
      // The tailgate: a wall below the rim, a corner at it.
      var gate = X(4);
      if (it.x < bedL && it.x + it.r > gate) {
        if (it.y > rim) { it.x = gate - it.r; it.vx = -Math.abs(it.vx) * 0.4; }
        else {
          var cx = it.x - gate, cy = it.y - rim, cd = Math.sqrt(cx * cx + cy * cy) || 1;
          if (cd < it.r) {
            it.x = gate + (cx / cd) * it.r; it.y = rim + (cy / cd) * it.r;
            var dot = it.vx * (cx / cd) + it.vy * (cy / cd);
            if (dot < 0) { it.vx -= 1.5 * dot * (cx / cd); it.vy -= 1.5 * dot * (cy / cd); }
          }
        }
      }
      // The cab: land on the roof or hood and roll back toward the bed.
      var top = cabTop(it.x);
      if (top !== null && it.y + it.r > top) {
        if (it.y < top) {
          it.y = top - it.r;
          it.vy = -Math.abs(it.vy) * 0.25;
          it.vx -= 0.7;
          it.va = it.vx / it.r;
        } else if (it.x > X(262)) {
          it.x = X(273) + it.r; it.vx = Math.abs(it.vx) * 0.4;
        }
      }
    }

    function step(t) {
      var live = 0, flying = 0;
      var batting = pointer.inside && pointer.type === "mouse" && !held && pointer.speed > 16;

      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.gone) {
          // Settling into its place in the bed.
          it.gone += 1;
          flying++;
          var sx = T.x + it.slot.ox, sy = H + T.by - it.slot.oy;
          it.x += (sx - it.x) * 0.3;
          it.y += (sy - it.y) * 0.3;
          it.a += (it.slot.a - it.a) * 0.3;
          it.s += (it.slot.s - it.s) * 0.3;
          if (it.gone > 14) loaded.push({ path: it.path, ox: it.slot.ox, oy: it.slot.oy, a: it.slot.a, s: it.slot.s, green: it.green });
          continue;
        }
        live++;
        if (it.cd) it.cd--;

        if (it === held) {
          // A firm spring to the grab point, with a little swing.
          var tx = pointer.x + it.gx - it.x, ty = pointer.y + it.gy - it.y;
          it.vx = tx * 0.45;
          it.vy = ty * 0.45;
          it.x += it.vx;
          it.y += it.vy;
          it.a += (clamp(it.vx * 0.04, -0.6, 0.6) - it.a) * 0.15;
        } else {
          it.vy += G;
          it.vx *= AIR;
          it.vy *= AIR;

          // A fast swipe bats things along; a slow approach never pushes,
          // so a piece always stays where you're reaching for it.
          if (batting && !it.cd) {
            var bx = it.x - pointer.x, by = it.y - pointer.y;
            if (bx * bx + by * by < (it.r + 12) * (it.r + 12)) {
              it.vx = clamp(it.vx + pointer.vx * 0.55, -30, 30);
              it.vy = clamp(it.vy + pointer.vy * 0.55 - 3, -30, 30);
              it.va = pointer.vx * 0.012;
              it.cd = 12;
            }
          }

          it.x += it.vx;
          it.y += it.vy;
          it.a += it.va;
          it.va *= 0.985;
        }

        // Walls and floor.
        if (it.x < it.r) { it.x = it.r; it.vx = Math.abs(it.vx) * 0.5; }
        if (it.x > W - it.r) { it.x = W - it.r; it.vx = -Math.abs(it.vx) * 0.5; }
        if (it.y > H - it.r) {
          var impact = it.vy;
          it.y = H - it.r;
          it.vy = Math.abs(it.vy) > 1.6 ? -it.vy * 0.32 : 0;
          it.vx *= FLOOR_FRICTION;
          if (it !== held) it.va = it.vx / it.r;
          if (impact > 4) it.sq = Math.min(1, impact / 14);
          if (impact > 7) puff(it.x, H - 2, 4, "rgba(161,161,166,.7)", 1.6);
        }
        if (it.y < -600) it.y = -600;
        it.sq *= 0.8;

        if (it !== held && T.state !== "gone") collideTruck(it);
        it.hs += ((it === hovered ? 1 : 0) - it.hs) * 0.25;
      }

      // Items push each other apart.
      for (var a = 0; a < items.length; a++) {
        var p = items[a];
        if (p.gone) continue;
        for (var b = a + 1; b < items.length; b++) {
          var q = items[b];
          if (q.gone) continue;
          var ddx = q.x - p.x, ddy = q.y - p.y;
          var min = p.r + q.r;
          var dist2 = ddx * ddx + ddy * ddy;
          if (dist2 >= min * min || dist2 === 0) continue;
          var dist = Math.sqrt(dist2);
          var nx = ddx / dist, ny = ddy / dist;
          var overlap = (min - dist) / 2;
          if (p !== held) { p.x -= nx * overlap; p.y -= ny * overlap; }
          if (q !== held) { q.x += nx * overlap; q.y += ny * overlap; }
          var rel = (q.vx - p.vx) * nx + (q.vy - p.vy) * ny;
          if (rel < 0) {
            var j = -rel * 0.65;
            if (p !== held) { p.vx -= j * nx; p.vy -= j * ny; }
            if (q !== held) { q.vx += j * nx; q.vy += j * ny; }
          }
        }
      }

      items = items.filter(function (it) { return !it.gone || it.gone <= 14; });

      // Particles.
      for (var s = 0; s < sparks.length; s++) {
        var sp = sparks[s];
        if (!sp.text) { sp.vy += 0.12; sp.x += sp.vx; }
        sp.y += sp.vy;
        sp.life -= sp.decay;
      }
      sparks = sparks.filter(function (sp) { return sp.life > 0; });

      // The truck: a springy bed, and the drive off and back.
      T.bv += -T.by * 0.22;
      T.bv *= 0.78;
      T.by += T.bv;
      if (T.state === "park" && live === 0 && flying === 0 && loaded.length) {
        if (!waitUntil) waitUntil = t + 650;
        else if (t > waitUntil) { waitUntil = 0; T.state = "leaving"; T.v = 0; }
      } else if (T.state === "leaving") {
        T.v = Math.min(T.v + 0.35, 16);
        T.x += T.v;
        if (Math.random() < 0.5) puff(X(28), H - 4, 1, "rgba(161,161,166,.6)", 1.2);
        if (T.x > W + 30) { T.state = "gone"; loaded = []; waitUntil = t + 500; }
      } else if (T.state === "gone" && t > waitUntil) {
        T.state = "arriving";
        waitUntil = 0;
        T.x = W + 30;
      } else if (T.state === "arriving") {
        // Backing in, easing to a stop.
        var gap = T.x - T.home;
        T.v = -Math.max(0.6, gap * 0.07);
        T.x += T.v;
        if (gap < 0.8) { T.x = T.home; T.v = 0; T.state = "park"; T.bv += 1.5; spawn(false); }
      } else {
        T.v = 0;
      }
      T.wa += T.v / (WHEEL_R * T.s);

      hovered = held ? held : (pointer.inside && pointer.type === "mouse" ? hit(pointer.x, pointer.y) : null);
      stage.style.cursor = held ? "grabbing" : hovered ? "grab" : "";
    }

    var WHEELS = [54, 212], WHEEL_R = 21, ARCH_R = 26, SILL = 30;

    function drawWheel(u) {
      var cx = X(u), cy = H - WHEEL_R * T.s, r = WHEEL_R * T.s;
      var k, a;
      ctx.save();
      // Tire, with tread marks that turn with the wheel.
      ctx.fillStyle = "#070807";
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(161, 161, 166, .6)";
      ctx.stroke();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = "rgba(161, 161, 166, .26)";
      ctx.beginPath();
      for (k = 0; k < 18; k++) {
        a = T.wa + k * Math.PI * 2 / 18;
        ctx.moveTo(cx + Math.cos(a) * r * 0.8, cy + Math.sin(a) * r * 0.8);
        ctx.lineTo(cx + Math.cos(a) * r * 0.95, cy + Math.sin(a) * r * 0.95);
      }
      ctx.stroke();
      // Rim and six spokes.
      ctx.fillStyle = "rgba(43, 192, 108, .1)";
      ctx.strokeStyle = COLOR.brand;
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      for (k = 0; k < 6; k++) {
        a = T.wa + k * Math.PI / 3;
        ctx.moveTo(cx + Math.cos(a) * r * 0.18, cy + Math.sin(a) * r * 0.18);
        ctx.lineTo(cx + Math.cos(a) * r * 0.56, cy + Math.sin(a) * r * 0.56);
      }
      ctx.stroke();
      ctx.fillStyle = COLOR.brand;
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.13, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // A full-size pickup in profile: short tailgate, long bed, a cab with a
    // raked windshield, a long hood and an upright grille, on big wheels
    // under flared arches. Drawn in the site's outline style.
    function bodyPath() {
      var drop = SILL - WHEEL_R;
      var a = Math.asin(drop / ARCH_R);
      var reach = Math.sqrt(ARCH_R * ARCH_R - drop * drop);
      var axle = H - WHEEL_R * T.s + T.by;
      ctx.beginPath();
      ctx.moveTo(X(6), Y(RIM));
      ctx.lineTo(X(4), Y(76));
      ctx.lineTo(X(4), Y(36));
      ctx.quadraticCurveTo(X(4), Y(SILL), X(10), Y(SILL));
      WHEELS.forEach(function (u) {
        ctx.lineTo(X(u - reach), Y(SILL));
        ctx.arc(X(u), axle, ARCH_R * T.s, -Math.PI + a, -a);
      });
      ctx.lineTo(X(262), Y(SILL));
      ctx.quadraticCurveTo(X(268), Y(SILL), X(268), Y(36));
      ctx.lineTo(X(268), Y(79));
      ctx.quadraticCurveTo(X(268), Y(85), X(262), Y(85.5));
      ctx.lineTo(X(222), Y(89));
      ctx.lineTo(X(200), Y(119));
      ctx.quadraticCurveTo(X(197), Y(122), X(192), Y(122));
      ctx.lineTo(X(156), Y(122));
      ctx.quadraticCurveTo(X(150), Y(122), X(149), Y(116));
      ctx.lineTo(X(147), Y(RIM));
    }

    function line(u1, v1, u2, v2) { ctx.moveTo(X(u1), Y(v1)); ctx.lineTo(X(u2), Y(v2)); }

    function drawTruck() {
      // A faint green pool on the ground under the truck.
      ctx.save();
      var gx = X(136), gy = H - 2;
      var pool = ctx.createRadialGradient(gx, gy, 0, gx, gy, 150 * T.s);
      pool.addColorStop(0, "rgba(43, 192, 108, .16)");
      pool.addColorStop(1, "rgba(43, 192, 108, 0)");
      ctx.fillStyle = pool;
      ctx.fillRect(gx - 160 * T.s, gy - 30 * T.s, 320 * T.s, 32 * T.s);
      ctx.restore();

      // Junk already in the bed sits behind the bed wall, so only the top
      // of the heap shows.
      for (var i = 0; i < loaded.length; i++) {
        var l = loaded[i];
        drawIcon(l.path, T.x + l.ox, H + T.by - l.oy, l.s, l.a, l.green ? COLOR.brand : COLOR.grey, 1,
          l.green ? "rgba(43,192,108,.12)" : "rgba(255,255,255,.05)");
      }

      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      // Body: dark green, a touch lighter at the top, with a bright outline.
      bodyPath();
      var shade = ctx.createLinearGradient(0, Y(122), 0, Y(SILL));
      shade.addColorStop(0, "rgba(22, 46, 31, .97)");
      shade.addColorStop(1, "rgba(5, 11, 8, .98)");
      ctx.fillStyle = shade;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = COLOR.brand;
      ctx.stroke();

      // Flared arches over the wheels.
      var drop = SILL - WHEEL_R, a = Math.asin(drop / ARCH_R) + 0.12;
      ctx.lineWidth = 3.2;
      ctx.strokeStyle = "rgba(43, 192, 108, .55)";
      WHEELS.forEach(function (u) {
        ctx.beginPath();
        ctx.arc(X(u), H - WHEEL_R * T.s + T.by, (ARCH_R + 2.2) * T.s, -Math.PI + a, -a);
        ctx.stroke();
      });

      // Windows: a small rear one and the door glass, with a glint.
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = COLOR.brand;
      [[[155, 115], [167, 115], [167, 93], [154, 93]],
       [[173, 115], [198, 115], [213, 94], [173, 94]]].forEach(function (pts) {
        ctx.beginPath();
        ctx.moveTo(X(pts[0][0]), Y(pts[0][1]));
        for (var p = 1; p < pts.length; p++) ctx.lineTo(X(pts[p][0]), Y(pts[p][1]));
        ctx.closePath();
        var glass = ctx.createLinearGradient(0, Y(115), 0, Y(93));
        glass.addColorStop(0, "rgba(43, 192, 108, .26)");
        glass.addColorStop(1, "rgba(43, 192, 108, .06)");
        ctx.fillStyle = glass;
        ctx.fill();
        ctx.stroke();
      });
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = COLOR.ink;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      line(182, 112, 188, 97);
      line(187, 112, 191, 102);
      ctx.stroke();
      ctx.restore();

      // Panel lines: the door seams, a body crease, the bed rail.
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = COLOR.brand;
      ctx.beginPath();
      line(170, 92, 170, 36);
      line(222, 88, 222, 50);
      if (T.s >= 0.8) line(10, 60, 262, 60);
      line(147, 80, 147, 36);
      ctx.stroke();
      ctx.restore();
      ctx.beginPath();
      ctx.lineWidth = 3;
      ctx.strokeStyle = COLOR.brand;
      line(6, RIM, 18, RIM);
      line(135, RIM, 147, RIM);
      ctx.stroke();

      // Door handle and mirror.
      ctx.lineWidth = 2;
      ctx.beginPath();
      line(176, 84, 184, 84);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(X(213), Y(93));
      ctx.lineTo(X(222), Y(93));
      ctx.lineTo(X(222), Y(86));
      ctx.lineTo(X(215), Y(86));
      ctx.closePath();
      ctx.fillStyle = "rgba(6, 12, 9, .98)";
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.stroke();

      // Bumpers.
      ctx.fillStyle = "rgba(10, 18, 13, .98)";
      ctx.strokeStyle = "rgba(43, 192, 108, .7)";
      ctx.lineWidth = 1.6;
      [[1, 31, 8, 6], [264, 31, 8, 9]].forEach(function (b) {
        var bx = X(b[0]), by = Y(b[1] + b[3]), bw = b[2] * T.s, bh = b[3] * T.s, br = 2.5 * T.s;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, br); else ctx.rect(bx, by, bw, bh);
        ctx.fill();
        ctx.stroke();
      });

      // Headlight with a soft glow, and the taillight.
      ctx.save();
      ctx.shadowColor = "rgba(245, 245, 247, .7)";
      ctx.shadowBlur = 10;
      ctx.fillStyle = COLOR.ink;
      ctx.fillRect(X(259), Y(81), 8 * T.s, 6 * T.s);
      ctx.restore();
      ctx.fillStyle = "rgba(255, 94, 94, .9)";
      ctx.fillRect(X(4), Y(74), 4 * T.s, 13 * T.s);
      ctx.restore();

      drawWheel(WHEELS[0]);
      drawWheel(WHEELS[1]);

      // Hint above the truck.
      var label;
      if (T.state === "leaving" || T.state === "gone") label = "Off to the dump";
      else if (T.state === "arriving") label = "Back for more";
      else if (hauled) label = hauled + " hauled";
      else label = pointer.type === "touch" ? "Tap the junk" : "Toss the junk in the truck";
      ctx.save();
      ctx.textAlign = "center";
      ctx.fillStyle = hauled ? COLOR.brand : "rgba(161, 161, 166, " + (touched ? 0.5 : 0.85) + ")";
      if (T.s < 0.8) {
        // Small screens: painted on the side of the bed, clear of the copy.
        ctx.font = "600 10px " + COLOR.font;
        ctx.fillText(label, X(92), Y(52));
      } else {
        ctx.font = "600 14px " + COLOR.font;
        var half = ctx.measureText(label).width / 2;
        ctx.fillText(label, clamp(X(136), half + 10, W - half - 10), Y(122) - 18);
      }
      ctx.restore();
    }

    function draw() {
      drawTruck();
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var hot = it === hovered;
        var stroke = hot ? COLOR.ink : it.green ? COLOR.brand : COLOR.grey;
        var fill = it.green ? "rgba(43,192,108,.12)" : hot ? "rgba(255,255,255,.09)" : "rgba(255,255,255,.045)";
        var size = it.s * (1 + it.hs * 0.1);
        // A faint trail behind anything moving fast.
        var sp = Math.abs(it.vx) + Math.abs(it.vy);
        if (!it.gone && it !== held && sp > 12) {
          drawIcon(it.path, it.x - it.vx * 1.2, it.y - it.vy * 1.2, size, it.a - it.va * 2, stroke, 0.16);
          drawIcon(it.path, it.x - it.vx * 2.4, it.y - it.vy * 2.4, size, it.a - it.va * 4, stroke, 0.07);
        }
        drawIcon(it.path, it.x, it.y, size, it.a, stroke, 1, fill, it.sq);
      }
      for (var s = 0; s < sparks.length; s++) {
        var p = sparks[s];
        ctx.globalAlpha = Math.max(0, p.life);
        if (p.text) {
          ctx.font = "700 15px " + COLOR.font;
          ctx.textAlign = "center";
          ctx.fillStyle = COLOR.brand;
          ctx.fillText(p.text, p.x, p.y);
        } else {
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    return {
      init: function (still) { T.state = "park"; layout(); items = []; loaded = []; sparks = []; spawn(still); },
      resize: function () {
        layout();
        items.forEach(function (it) { it.x = Math.min(it.x, W - it.r); it.y = Math.min(it.y, H - it.r); });
      },
      step: step,
      draw: draw,
      // Things moving fast enough to stir the dot field.
      movers: function () {
        var out = [];
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (it.gone) continue;
          var sp = Math.abs(it.vx) + Math.abs(it.vy);
          if (sp > 5) out.push({ x: it.x, y: it.y, k: Math.min(1, (sp - 5) / 15) });
        }
        return out;
      },
      down: function (e) {
        var it = hit(pointer.x, pointer.y);
        if (!it) return;
        touched = true;
        if (pointer.type === "touch") {
          // A tap lobs the piece at the truck bed (not always perfectly).
          // No dragging, so the page still scrolls under a thumb.
          if (T.state === "park") {
            var tx = X(76) + rand(-32, 32) * T.s;
            var ty = Y(96);
            var f = rand(38, 50);
            it.vx = (tx - it.x) / f;
            it.vy = (ty - it.y - 0.5 * G * f * f) / f;
          } else {
            it.vy = -rand(10, 14);
            it.vx += rand(-3, 3);
          }
          it.va = rand(-0.25, 0.25);
          return;
        }
        held = it;
        it.gx = it.x - pointer.x;
        it.gy = it.y - pointer.y;
        e.preventDefault();
      },
      up: function () {
        if (!held) return;
        // Throw with the hand's recent speed.
        held.vx = clamp(pointer.vx * 1.1, -32, 32);
        held.vy = clamp(pointer.vy * 1.1, -32, 32);
        held.va = held.vx * 0.012;
        held = null;
      },
    };
  }

  /* ------------------------------------------------------------- Yard -- */

  // The field behind, the toss on top; thrown junk stirs the dots.
  function Yard() {
    var field = Field(), toss = Toss();
    return {
      init: function (still) { field.init(); toss.init(still); },
      resize: function () { field.resize(); toss.resize(); },
      step: function (t) { toss.step(t); field.step(t, toss.movers()); },
      draw: function () { field.draw(); toss.draw(); },
      down: toss.down,
      up: toss.up,
    };
  }

  /* ------------------------------------------------------------ Drift -- */

  function Drift() {
    var items = [];
    var px = 0, py = 0;

    return {
      init: function () {
        items = [];
        var n = W < 640 ? 8 : 16;
        for (var i = 0; i < n; i++) {
          items.push({
            path: JUNK[i % JUNK.length],
            x: rand(0, W), y: rand(0, H),
            depth: rand(0.3, 1),
            s: rand(30, 64),
            a: rand(-0.6, 0.6), va: rand(-0.002, 0.002),
            vx: rand(-0.12, 0.12), vy: rand(-0.1, 0.1),
            green: i % 5 === 2,
          });
        }
      },
      resize: function () {},
      step: function () {
        var tx = pointer.inside ? (pointer.x - W / 2) : 0;
        var ty = pointer.inside ? (pointer.y - H / 2) : 0;
        px += (tx - px) * 0.05;
        py += (ty - py) * 0.05;
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          it.x += it.vx * it.depth;
          it.y += it.vy * it.depth;
          it.a += it.va;
          if (it.x < -80) it.x = W + 80;
          if (it.x > W + 80) it.x = -80;
          if (it.y < -80) it.y = H + 80;
          if (it.y > H + 80) it.y = -80;
        }
      },
      draw: function () {
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          var ox = -px * 0.06 * it.depth, oy = -py * 0.06 * it.depth;
          drawIcon(it.path, it.x + ox, it.y + oy, it.s * (0.7 + it.depth * 0.4), it.a,
            it.green ? COLOR.brand : COLOR.grey, 0.12 + it.depth * 0.25);
        }
      },
    };
  }

  var MODES = { yard: Yard, toss: Toss, field: Field, drift: Drift };

  /* ------------------------------------------------------------- Loop -- */

  // How fast the cursor is moving, measured once per frame. `energy` rises
  // quickly with speed and falls back slowly, so a fast swipe has a tail.
  function trackPointer() {
    if (pointer.inside && pointer.lx > -9000) {
      var dx = pointer.x - pointer.lx, dy = pointer.y - pointer.ly;
      pointer.vx = pointer.vx * 0.4 + dx * 0.6;
      pointer.vy = pointer.vy * 0.4 + dy * 0.6;
    } else {
      pointer.vx *= 0.8;
      pointer.vy *= 0.8;
    }
    pointer.lx = pointer.inside ? pointer.x : -9999;
    pointer.ly = pointer.inside ? pointer.y : -9999;
    pointer.speed = Math.sqrt(pointer.vx * pointer.vx + pointer.vy * pointer.vy);
    var target = clamp((pointer.speed - 4) / 26, 0, 1);
    pointer.energy += (target - pointer.energy) * (target > pointer.energy ? 0.3 : 0.04);
  }

  function frame(t) {
    raf = 0;
    if (!mode) return;
    trackPointer();
    ctx.clearRect(0, 0, W, H);
    mode.step(t);
    mode.draw();
    schedule();
  }

  function schedule() {
    if (!raf && mode && !reduced && onScreen && !document.hidden) raf = requestAnimationFrame(frame);
  }

  function still() {
    ctx.clearRect(0, 0, W, H);
    if (!mode) return;
    // A settled frame: let a toss pile land, then draw it once.
    if (mode.step) for (var i = 0; i < 240; i++) mode.step(i * 16);
    mode.draw();
  }

  function size() {
    var r = stage.getBoundingClientRect();
    W = r.width;
    H = r.height;
    DPR = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  function setMode(name) {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    stage.style.cursor = "";
    var Make = MODES[name];
    hero.setAttribute("data-fx", Make ? name : "none");
    mode = Make ? Make() : null;
    ctx.clearRect(0, 0, W, H);
    if (!mode) return;
    mode.init(reduced);
    if (reduced) still();
    else schedule();
  }

  /* ----------------------------------------------------------- Events -- */

  function locate(e) {
    var r = canvas.getBoundingClientRect();
    pointer.x = e.clientX - r.left;
    pointer.y = e.clientY - r.top;
    pointer.type = e.pointerType || "mouse";
  }

  if (!reduced) {
    stage.addEventListener("pointermove", function (e) { locate(e); pointer.inside = true; });
    stage.addEventListener("pointerdown", function (e) {
      if (e.target.closest("a, button")) return;
      locate(e);
      pointer.inside = true;
      if (mode && mode.down) mode.down(e);
    });
    window.addEventListener("pointerup", function () { if (mode && mode.up) mode.up(); });
    window.addEventListener("pointercancel", function () { if (mode && mode.up) mode.up(); });
    stage.addEventListener("pointerleave", function () {
      pointer.inside = false;
      if (pointer.type === "touch") pointer.x = pointer.y = -9999;
    });
    document.addEventListener("visibilitychange", schedule);

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        onScreen = entries[0].isIntersecting;
        schedule();
      }).observe(stage);
    }
  }

  var resizeTimer = 0;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      size();
      if (mode && mode.resize) mode.resize();
      if (reduced) still();
    }, 120);
  });

  size();
  setMode(hero.getAttribute("data-fx"));
})();
