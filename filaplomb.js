/* ============================================================
   FILAPLOMB — filaplomb.js
   Capteur d'orientation, calibrage « horizontal », fil à plomb et mire.

   API : window.Filaplomb
     start()                      → Promise<boolean>  écoute les capteurs + boucle ressort
     stop()                       → arrête l'écoute (le calibrage est conservé)
     calibrate()                  → Promise<boolean>  mémorise l'horizontale actuelle
     isCalibrated()               → boolean
     on(event, fn)                → 'calibrated'
     getPlumb(maxLen)             → { dx, dy, len }   fil à plomb en pixels (len = longueur)
     getLevel(R, {maxLen, seuil}) → { calibrated, ok, len, r, state }
                                     r = rayon du petit cercle (0,38 × R)
                                     ok = fil à plomb contenu dans le petit cercle (len <= seuil × r)
                                     state = 'off' | 'green' | 'red'
     drawMire(ctx, cx, cy, R, color)
     drawFilaplomb(ctx, cx, cy, color, maxLen)
   ============================================================ */

(function () {
  "use strict";

  const S = {
    calibrated: false,
    orientationOK: false,   // permission obtenue (ou inutile)
    listening: false,
    hasData: false,
    running: false,
    rafId: 0,
    lastT: 0,
    qRef: { w: 1, x: 0, y: 0, z: 0 },
    qCur: { w: 1, x: 0, y: 0, z: 0 },
    spring: { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 }
  };
  const handlers = {};

  function on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); }
  function emit(ev) { (handlers[ev] || []).forEach(fn => { try { fn(); } catch (e) { console.warn(e); } }); }

  // ---------- Quaternions ----------
  function qMultiply(a, b) {
    return {
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
      x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w
    };
  }
  const qConjugate = q => ({ w: q.w, x: -q.x, y: -q.y, z: -q.z });
  function qNormalize(q) {
    const n = Math.hypot(q.w, q.x, q.y, q.z) || 1;
    return { w: q.w / n, x: q.x / n, y: q.y / n, z: q.z / n };
  }
  function qFromEuler(beta, gamma, alpha) {
    const cx = Math.cos(beta / 2),  sx = Math.sin(beta / 2);
    const cy = Math.cos(gamma / 2), sy = Math.sin(gamma / 2);
    const cz = Math.cos(alpha / 2), sz = Math.sin(alpha / 2);
    return qNormalize({
      w: cx * cy * cz - sx * sy * sz,
      x: sx * cy * cz + cx * sy * sz,
      y: cx * sy * cz - sx * cy * sz,
      z: cx * cy * sz + sx * sy * cz
    });
  }
  function qSlerp(a, b, t) {
    let dot = a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z;
    if (dot < 0) { b = { w: -b.w, x: -b.x, y: -b.y, z: -b.z }; dot = -dot; }
    if (dot > 0.9995) {
      return qNormalize({
        w: a.w + t * (b.w - a.w), x: a.x + t * (b.x - a.x),
        y: a.y + t * (b.y - a.y), z: a.z + t * (b.z - a.z)
      });
    }
    const th0 = Math.acos(dot), th = th0 * t, sin0 = Math.sin(th0);
    const s0 = Math.sin(th0 - th) / sin0, s1 = Math.sin(th) / sin0;
    return { w: a.w * s0 + b.w * s1, x: a.x * s0 + b.x * s1, y: a.y * s0 + b.y * s1, z: a.z * s0 + b.z * s1 };
  }

  // ---------- Capteurs ----------
  function onOrientation(ev) {
    if (ev.beta == null || ev.gamma == null) return;
    const q = qFromEuler(ev.beta * Math.PI / 180, ev.gamma * Math.PI / 180, (ev.alpha ?? 0) * Math.PI / 180);
    if (!S.hasData) { S.qCur = q; S.hasData = true; }
    S.qCur = qSlerp(S.qCur, q, 0.25);
  }
  function attach() {
    if (S.listening) return;
    window.addEventListener("deviceorientation", onOrientation, true);
    S.listening = true;
  }
  function detach() {
    if (!S.listening) return;
    window.removeEventListener("deviceorientation", onOrientation, true);
    S.listening = false;
    S.hasData = false;
  }
  const needsPermission = () =>
    typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function";

  async function ensurePermission() {
    if (S.orientationOK) return true;
    if (typeof DeviceOrientationEvent === "undefined") return false;
    if (needsPermission()) {
      try {
        if ((await DeviceOrientationEvent.requestPermission()) !== "granted") return false;
      } catch (e) { console.warn("requestPermission :", e); return false; }
    }
    S.orientationOK = true;
    return true;
  }

  async function calibrate() {
    if (!(await ensurePermission())) return false;
    attach();
    if (!S.hasData) {
      await new Promise((resolve) => {
        const t0 = performance.now();
        const iv = setInterval(() => {
          if (S.hasData || performance.now() - t0 > 1500) { clearInterval(iv); resolve(); }
        }, 50);
      });
    }
    if (!S.hasData) return false;
    S.qRef = { ...S.qCur };
    S.calibrated = true;
    Object.assign(S.spring, { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 });
    emit("calibrated");
    return true;
  }

  // ---------- Écart angulaire + ressort ----------
  function computeTilt() {
    const q = qMultiply(S.qCur, qConjugate(S.qRef));
    return { vx: 2 * (q.x * q.z + q.w * q.y), vy: 2 * (q.y * q.z - q.w * q.x) };
  }

  function tick(now) {
    if (!S.running) return;
    const dt = Math.min((now - S.lastT) / 1000, 0.05);
    S.lastT = now;
    const sp = S.spring;
    if (S.calibrated && S.hasData) {
      let { vx, vy } = computeTilt();
      const mag = Math.hypot(vx, vy);
      if (mag > 1) { vx /= mag; vy /= mag; }
      sp.tx = vx; sp.ty = vy;
    } else { sp.tx = 0; sp.ty = 0; }
    const k = 60, c = 9;
    sp.vx += (-k * (sp.x - sp.tx) - c * sp.vx) * dt;
    sp.vy += (-k * (sp.y - sp.ty) - c * sp.vy) * dt;
    sp.x += sp.vx * dt;
    sp.y += sp.vy * dt;
    S.rafId = requestAnimationFrame(tick);
  }

  async function start() {
    if (S.running) return true;
    // Android / bureau : pas de permission à demander → on écoute tout de suite.
    if (!needsPermission() && typeof DeviceOrientationEvent !== "undefined") S.orientationOK = true;
    if (S.orientationOK) attach();
    S.running = true;
    S.lastT = performance.now();
    S.rafId = requestAnimationFrame(tick);
    return true;
  }

  function stop() {
    S.running = false;
    cancelAnimationFrame(S.rafId);
    S.rafId = 0;
    detach();
    Object.assign(S.spring, { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 });
  }

  // ---------- Fil à plomb / niveau ----------
  function getPlumb(maxLen) {
    const { x, y } = S.spring;
    const mag = Math.hypot(x, y);
    if (mag < 0.004) return { dx: 0, dy: 0, len: 0 };
    const len = maxLen * Math.min(1, mag * 1.6);
    return { dx: (x / mag) * len, dy: (y / mag) * len, len };
  }

  function getLevel(R, opts = {}) {
    const maxLen = opts.maxLen || Math.min(window.innerWidth, window.innerHeight) * 0.42;
    const seuil = opts.seuil || 1;
    const r = R * 0.38;
    if (!S.calibrated) return { calibrated: false, ok: false, len: 0, r, state: "off" };
    const { len } = getPlumb(maxLen);
    const ok = len <= r * seuil;
    return { calibrated: true, ok, len, r, state: ok ? "green" : "red" };
  }

  // ---------- Dessin ----------
  function drawMire(ctx, cx, cy, R, strokeColor) {
    const r = R * 0.38, L = R * 1.35;
    ctx.save();
    ctx.translate(cx, cy);
    const cross = () => {
      ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-L, 0); ctx.lineTo(-r, 0);
      ctx.moveTo(r, 0);  ctx.lineTo(L, 0);
      ctx.moveTo(0, -L); ctx.lineTo(0, -r);
      ctx.moveTo(0, r);  ctx.lineTo(0, L);
      ctx.stroke();
    };
    ctx.strokeStyle = "rgba(0,0,0,0.45)"; ctx.lineWidth = 5; cross();
    ctx.strokeStyle = strokeColor;        ctx.lineWidth = 2.5; cross();
    ctx.fillStyle = strokeColor;
    ctx.beginPath(); ctx.arc(0, 0, 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawFilaplomb(ctx, ax, ay, strokeColor, maxLen) {
    const { dx, dy, len } = getPlumb(maxLen || Math.min(window.innerWidth, window.innerHeight) * 0.42);
    if (len <= 0) return;
    const ex = ax + dx, ey = ay + dy;
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(0,0,0,0.4)"; ctx.lineWidth = 9;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.strokeStyle = strokeColor; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.fillStyle = "#ef4444";
    ctx.beginPath(); ctx.arc(ex, ey, 7, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();
  }

  window.Filaplomb = { start, stop, calibrate, isCalibrated: () => S.calibrated, on, getPlumb, getLevel, drawMire, drawFilaplomb };
})();
