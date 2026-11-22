/* ============================================================
   FILAPLOMB — scriptAPN.js
   Mode visée : caméra au clic, mire + fil à plomb par-dessus.
   Capture → PhotoWorkflow.addPhoto(file).

   Expose : window.APN.open() / window.APN.close()
   ============================================================ */

(function () {
  "use strict";

  /* ----- Réglages faciles à changer ----------------------------------------
     DECLENCHEUR_LIE_AU_CALIBRAGE
       false : le bouton « Déclencher » est disponible dès que la caméra tourne
               (calibrage et niveau n'interviennent pas).
       true  : bouton visible seulement si calibré, et actif seulement si le fil à plomb
               est dans le petit cercle (stable STABLE_MS).
     SEUIL_NIVEAU : le fil à plomb est « horizontal » si sa longueur <= SEUIL_NIVEAU × rayon
               du petit cercle (1 = pointe du fil dans le petit cercle ; 2 = diamètre).
     ------------------------------------------------------------------------ */
  const DECLENCHEUR_LIE_AU_CALIBRAGE = false;
  const SEUIL_NIVEAU = 1;
  const STABLE_MS = 400;

  const overlay = document.getElementById("apn-overlay");
  const video = document.getElementById("apn-video");
  const canvas = document.getElementById("apn-canvas");
  const triggerBtn = document.getElementById("apn-trigger");
  const closeBtn = document.getElementById("apn-close");
  const calibBtn = document.getElementById("apn-calib");
  const statusEl = document.getElementById("apn-status");
  const counterEl = document.getElementById("apn-counter");
  const flagEl = document.getElementById("apn-flag");
  const scaleInput = document.getElementById("apn-scale");
  const scaleHelp = document.getElementById("apn-scale-help");

  const ctx = canvas.getContext("2d");
  let stream = null;
  let rafId = 0;
  let photoCount = 0;
  let okSince = 0;
  let scaleFactor = parseFloat(scaleInput.value) || 0.10;
  let message = "";          // message temporaire (capture, erreur…)
  let messageUntil = 0;

  function setText(el, text) { if (el.textContent !== text) el.textContent = text; }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function flash(text, ms = 2500) { message = text; messageUntil = performance.now() + ms; }

  async function open() {
    overlay.hidden = false;
    overlay.classList.add("open");
    resize();
    window.addEventListener("resize", resize);
    photoCount = 0;
    okSince = 0;
    setText(counterEl, "");
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } }, audio: false
      });
      video.srcObject = stream;
      await video.play().catch(() => {});
    } catch (e) {
      flash("Caméra indisponible.", 8000);
      console.warn(e);
    }
    if (window.Filaplomb) await Filaplomb.start();
    if (!rafId) rafId = requestAnimationFrame(loop);
  }

  // Fermer : retour à l'application (la dernière photo prise y est affichée pour analyse).
  function close() {
    cancelAnimationFrame(rafId);
    rafId = 0;
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    video.srcObject = null;
    overlay.classList.remove("open");
    overlay.hidden = true;
    window.removeEventListener("resize", resize);
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    if (window.Filaplomb) Filaplomb.stop();      // fil à plomb inactif hors prise de vue
  }

  function mireGeometry() {
    const w = window.innerWidth, h = window.innerHeight;
    return {
      cx: w / 2,
      cy: h * 0.42,
      R: Math.min(w, h) * scaleFactor,
      maxLen: Math.min(w, h) * 0.42
    };
  }

  function loop(now) {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    const { cx, cy, R, maxLen } = mireGeometry();
    const lvl = window.Filaplomb
      ? Filaplomb.getLevel(R, { maxLen, seuil: SEUIL_NIVEAU })
      : { calibrated: false, ok: false, len: 0, r: R * 0.38, state: "off" };

    // --- Dessin : mire, disque vert clignotant (niveau OK), fil à plomb ---
    if (window.Filaplomb) {
      Filaplomb.drawMire(ctx, cx, cy, R, lvl.calibrated ? "#ffffff" : "#888888");
      if (lvl.calibrated && lvl.ok && Math.floor(now / 350) % 2 === 0) {
        ctx.save();
        ctx.fillStyle = "rgba(34,197,94,0.5)";
        ctx.beginPath(); ctx.arc(cx, cy, lvl.r, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      if (lvl.calibrated) {
        Filaplomb.drawFilaplomb(ctx, cx, cy, lvl.ok ? "#22c55e" : "#ef4444", maxLen);
      }
    }

    // --- Messages ---
    if (message && now < messageUntil) {
      setText(statusEl, message);
      statusEl.dataset.state = "off";
    } else if (!lvl.calibrated) {
      setText(statusEl, "Pour faire la photo, votre appareil doit être horizontal");
      statusEl.dataset.state = "off";
    } else if (lvl.ok) {
      setText(statusEl, "Horizontal — prêt à déclencher.");
      statusEl.dataset.state = "green";
    } else {
      setText(statusEl, "Votre appareil n’est plus horizontal");
      statusEl.dataset.state = "red";
    }
    flagEl.hidden = lvl.calibrated;
    setText(calibBtn, lvl.calibrated ? "📍 Recalibrer" : "📍 Calibrer à l’horizontale");

    // --- Déclencheur ---
    const streamLive = video.videoWidth > 0 && video.readyState >= 2;
    if (lvl.calibrated && lvl.ok) { if (!okSince) okSince = now; } else okSince = 0;
    const stable = okSince > 0 && (now - okSince) >= STABLE_MS;

    if (DECLENCHEUR_LIE_AU_CALIBRAGE) {
      triggerBtn.hidden = !lvl.calibrated;
      triggerBtn.disabled = !(streamLive && stable);
    } else {
      triggerBtn.hidden = false;
      triggerBtn.disabled = !streamLive;
    }

    rafId = requestAnimationFrame(loop);
  }

  async function trigger() {
    if (triggerBtn.disabled) return;
    triggerBtn.disabled = true;
    try {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) throw new Error("pas de flux");
      const cnv = document.createElement("canvas");
      cnv.width = vw; cnv.height = vh;
      cnv.getContext("2d").drawImage(video, 0, 0, vw, vh);
      const blob = await new Promise(res => cnv.toBlob(res, "image/jpeg", 0.92));
      cnv.width = 0; cnv.height = 0;
      if (!blob) throw new Error("échec capture");
      const file = new File([blob], `photo_${Date.now()}.jpg`, { type: "image/jpeg" });
      photoCount += 1;
      setText(counterEl, `${photoCount} photo(s) prise(s)`);
      if (window.PhotoWorkflow) window.PhotoWorkflow.addPhoto(file);
      flash("Photo enregistrée. « Fermer » pour l’analyser.");
    } catch (e) {
      console.warn(e);
      flash("Échec de la capture : " + (e && e.message || e), 4000);
    } finally {
      okSince = 0;
    }
  }

  calibBtn.addEventListener("click", async () => {
    calibBtn.disabled = true;
    const ok = window.Filaplomb ? await Filaplomb.calibrate() : false;
    calibBtn.disabled = false;
    if (!ok) flash("Capteur d’orientation indisponible.", 4000);
  });
  triggerBtn.addEventListener("click", trigger);
  closeBtn.addEventListener("click", close);

  // --- Curseur vertical : taille de la mire ---
  scaleInput.addEventListener("input", () => { scaleFactor = parseFloat(scaleInput.value); });
  let helpTimer = 0;
  const showHelp = () => { scaleHelp.hidden = false; clearTimeout(helpTimer); };
  const hideHelp = (delay = 0) => { clearTimeout(helpTimer); helpTimer = setTimeout(() => { scaleHelp.hidden = true; }, delay); };
  scaleInput.addEventListener("mouseenter", showHelp);
  scaleInput.addEventListener("mouseleave", () => hideHelp(0));
  scaleInput.addEventListener("touchstart", showHelp, { passive: true });
  scaleInput.addEventListener("touchend", () => hideHelp(1800));
  scaleInput.addEventListener("pointerdown", showHelp);
  scaleInput.addEventListener("pointerup", () => hideHelp(1800));

  window.APN = { open, close };
})();
