/* Evol7 — compact + zoom/pan multi-touch + diagnostic */

(function () {
  "use strict";

  const DEFAULT_CFG = {
    jackTol: 40,
    ballTol: 20,
    ballRatio: 2.5,
    offset: 60,
    coverage: 50
  };

  const cfg = { ...DEFAULT_CFG };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const jackOptions = (expectedR) => ({
    expectedR,
    minRatio: 1 - cfg.jackTol / 100,
    maxRatio: 1 + cfg.jackTol / 100,
    maxOffsetFactor: Math.max(0.8, cfg.offset / 100),
    minCoverage: Math.max(0.2, cfg.coverage / 100 - 0.1)
  });

  const ballOptions = (expectedR) => ({
    expectedR,
    minRatio: 1 - cfg.ballTol / 100,
    maxRatio: 1 + cfg.ballTol / 100,
    maxOffsetFactor: cfg.offset / 100,
    minCoverage: cfg.coverage / 100
  });

  const JACK_RADIUS_MM = 1.5;

  const filesInput = document.getElementById("files");
  const gallery = document.getElementById("gallery");
  const openCvStatus = document.getElementById("opencv-status");
  const workflowStatus = document.getElementById("workflow-status");
  const calibBtn = document.getElementById("calib-btn");
  const calibStatus = document.getElementById("calib-status");
  const apnBtn = document.getElementById("apn-btn");

  // --- Sidebar ---
  const hamburgerBtn = document.getElementById("hamburger-btn");
  const sidebar = document.getElementById("sidebar");
  const sidebarOverlay = document.getElementById("sidebar-overlay");

  function toggleSidebar(open) {
    sidebar.classList.toggle("open", open);
    sidebarOverlay.classList.toggle("open", open);
    hamburgerBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  hamburgerBtn.addEventListener("click", () => toggleSidebar(true));
  sidebarOverlay.addEventListener("click", () => toggleSidebar(false));

  document.addEventListener("pointerdown", (e) => {
    if (!sidebar.classList.contains("open")) return;
    if (sidebar.contains(e.target) || hamburgerBtn.contains(e.target)) return;
    toggleSidebar(false);
  }, true);

  // --- Curseurs ---
  const fmt = {
    jackTol: v => `± ${v} %`,
    ballTol: v => `± ${v} %`,
    ballRatio: v => `× ${Number(v).toFixed(2)}`,
    offset: v => `${v} % du rayon`,
    coverage: v => `${v} %`
  };

  function bindTuning(key) {
    const input = document.getElementById("cfg-" + key);
    const out = document.getElementById("out-" + key);
    const sync = () => { out.textContent = fmt[key](input.value); };
    input.addEventListener("input", () => {
      cfg[key] = parseFloat(input.value);
      sync();
    });
    input.value = cfg[key];
    sync();
    return () => {
      input.value = DEFAULT_CFG[key];
      cfg[key] = DEFAULT_CFG[key];
      sync();
    };
  }

  const resetters = Object.keys(DEFAULT_CFG).map(bindTuning);
  document.getElementById("cfg-reset").addEventListener("click", () => {
    resetters.forEach(f => f());
  });

  // --- Statut OpenCV ---
  FilaplombCV.ready().then((ok) => {
    if (ok) {
      openCvStatus.textContent = "Moteur de reconnaissance prêt.";
      openCvStatus.classList.add("ready");
    } else {
      openCvStatus.textContent = "Le moteur OpenCV ne s’est pas chargé.";
      openCvStatus.classList.add("error");
    }
  });

  // --- Calibration fil à plomb ---
  function refreshCalibStatus() {
    if (!window.Filaplomb) {
      calibStatus.textContent = "Fil à plomb indisponible.";
      return;
    }
    calibStatus.textContent = Filaplomb.isCalibrated()
      ? "Fil à plomb : calibré."
      : "Fil à plomb : non calibré.";
  }

  calibBtn.addEventListener("click", async () => {
    if (!window.Filaplomb) {
      calibStatus.textContent = "Module filaplomb.js non chargé.";
      return;
    }
    calibBtn.disabled = true;
    calibBtn.innerHTML = '<span class="spinner"></span>Calibration…';
    const ok = await Filaplomb.calibrate();
    calibBtn.disabled = false;
    calibBtn.textContent = "📍 Recalibrer le fil à plomb";
    refreshCalibStatus();
    if (!ok) calibStatus.textContent = "Capteur d’orientation indisponible.";
  });

  if (window.Filaplomb) Filaplomb.on("calibrated", refreshCalibStatus);
  refreshCalibStatus();

  apnBtn.addEventListener("click", () => {
    toggleSidebar(false);
    if (window.APN && window.APN.open) window.APN.open();
  });

  // --- Chargement fichier ---
  filesInput.addEventListener("change", (event) => {
    const files = Array.from(event.target.files || [])
      .filter(f => f.type.startsWith("image/"));
    if (!files.length) return;
    toggleSidebar(false);
    addPhoto(files[files.length - 1]);
    filesInput.value = "";
  });

  let currentCard = null;
  let currentObjectURL = null;

  function releaseCurrent() {
    if (currentObjectURL) {
      URL.revokeObjectURL(currentObjectURL);
      currentObjectURL = null;
    }
    if (currentCard) {
      currentCard.remove();
      currentCard = null;
    }
    gallery.replaceChildren();
  }

  function showPlaceholder() {
    const box = document.createElement("section");
    box.className = "card placeholder";

    const img = document.createElement("img");
    img.src = "photos/Pasdephoto.png";
    img.alt = "Pas de photo";
    img.onerror = () => {
      img.remove();
      box.append("Pas de photo : prenez-en une ou choisissez-en dans le volet.");
    };
    box.append(img);

    const footer = document.querySelector(".app-footer");
    if (footer) box.append(footer);

    gallery.replaceChildren(box);
  }

  function addPhoto(file) {
    releaseCurrent();
    workflowStatus.textContent = "Photo chargée. Attente analyse.";

    const card = createPhotoCard(file);
    const footer = document.querySelector(".app-footer");
    if (footer) card.append(footer);

    gallery.append(card);
    currentCard = card;
  }

  window.PhotoWorkflow = { addPhoto };
  showPlaceholder();

  // =========================================================================
  // CARD
  // =========================================================================
  function createPhotoCard(file) {
    const card = document.createElement("section");
    card.className = "card";

    const actions = document.createElement("div");
    actions.className = "actions";

    const mainBtn = document.createElement("button");
    mainBtn.type = "button";
    mainBtn.className = "action-button";
    mainBtn.textContent = "Valider le cochonnet";

    const acceptBtn = document.createElement("button");
    acceptBtn.type = "button";
    acceptBtn.className = "action-button success";
    acceptBtn.textContent = "✓ Boule correcte";
    acceptBtn.hidden = true;
    acceptBtn.disabled = true;

    const refineBtn = document.createElement("button");
    refineBtn.type = "button";
    refineBtn.className = "action-button";
    refineBtn.textContent = "🎯 Ajuster";
    refineBtn.style.backgroundColor = "#ffae35";
    refineBtn.style.color = "#000";
    refineBtn.style.fontWeight = "600";
    refineBtn.hidden = true;
    refineBtn.disabled = true;

    const judgeBtn = document.createElement("button");
    judgeBtn.type = "button";
    judgeBtn.className = "action-button secondary";
    judgeBtn.textContent = "⚖️ Juger";
    judgeBtn.hidden = true;
    judgeBtn.disabled = true;
    judgeBtn.style.backgroundColor = "#FF00FF";
    judgeBtn.style.color = "#fff";
    judgeBtn.style.fontWeight = "600";

    actions.append(mainBtn, acceptBtn, refineBtn, judgeBtn);

    let mireHint = null;
    if (window.matchMedia &&
        window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      mireHint = document.createElement("p");
      mireHint.className = "mire-hint";
      mireHint.textContent =
        "Molette : taille de la mire. Souris : S = zoom, G = glisser.";
    }

    const stage = document.createElement("div");
    stage.className = "stage";

    const photo = document.createElement("img");
    photo.className = "photo";
    photo.alt = "Photo à analyser";
    photo.draggable = false;

    const candidateLayer = document.createElement("canvas");
    candidateLayer.className = "candidate-layer";
    candidateLayer.setAttribute("aria-hidden", "true");

    const mireCanvas = document.createElement("canvas");
    mireCanvas.className = "mire-canvas";
    mireCanvas.setAttribute("aria-hidden", "true");

    const mireZoom = document.createElement("input");
    mireZoom.type = "range";
    mireZoom.className = "mire-zoom";
    mireZoom.min = "5";
    mireZoom.max = "120";
    mireZoom.step = "1";
    mireZoom.value = "50";
    mireZoom.setAttribute("aria-label", "Taille de la mire");

    const mireInstruction = document.createElement("p");
    mireInstruction.className = "mire-instruction";
    mireInstruction.textContent =
      "Soigner le réglage boule et cochonnet petit et grand cercle puis laisser la mire centrée sur le cochonnet";

    const status = document.createElement("p");
    status.className = "status";
    status.textContent = "En attente de l’analyse.";

    // Bandeau de diagnostic zoom/pan
    const keyIndicator = document.createElement("p");
    keyIndicator.className = "key-indicator";
    keyIndicator.textContent = "";
    keyIndicator.hidden = true;
    card.append(keyIndicator);

stage.append(photo, candidateLayer, mireCanvas);
card.append(actions);
if (mireHint) card.append(mireHint);
card.append(stage, mireInstruction, status);
card.append(mireZoom);   // ← slider en overlay sur la card, hors stage
    const objectUrl = URL.createObjectURL(file);
    currentObjectURL = objectUrl;

    // --- État local ---
    let candidate = null;
    let ballCandidates = [];
    let validatedBalls = [];
    let currentBallIndex = -1;
    let judged = false;
    let analyzing = false;

    // =======================================================================
    // ZOOM / PAN — état
    // =======================================================================
    const pointers = new Map();
    let pinch = null;
    let tx = 0, ty = 0, scale = 1;
    const MIN_SCALE = 1, MAX_SCALE = 6;
    let multiTouchActive = false;
    card._multiTouch = false;

    function applyTransform() {
      stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
      console.log(`[zoom] transform → translate(${tx.toFixed(1)}, ${ty.toFixed(1)}) scale(${scale.toFixed(2)})`);
    }

    function setMultiTouch(active) {
      multiTouchActive = active;
      card._multiTouch = active;
      if (active) {
        stage.classList.add("panning");
        mireController.setLocked(true);
      } else {
        stage.classList.remove("panning");
        if (!candidate || judged) mireController.setLocked(!!candidate);
        else mireController.setLocked(false);
      }
    }

  // ---- Tactile (pinch 2 doigts) — ancré sur le premier doigt posé ----
function onPointerDown(e) {
  if (e.pointerType === "mouse") return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  console.log(`[zoom] pointerdown tactile id=${e.pointerId}, size=${pointers.size}`);

  if (pointers.size === 2) {
    // Le PREMIER doigt posé est la première entrée insérée dans la Map
    const entries = [...pointers.entries()];
    const firstId = entries[0][0];
    const first = entries[0][1];     // le premier doigt (ancre)
    const second = entries[1][1];

    const dx = first.x - second.x;
    const dy = first.y - second.y;
    const dist0 = Math.hypot(dx, dy) || 1;
    const mid0 = {
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2
    };

    // Ancre en coordonnées CLIENT = position du premier doigt
    const r = stage.getBoundingClientRect();
    // Position de l'ancre dans le repère du stage AVANT transform (px, py)
    const px = first.x - r.left;
    const py = first.y - r.top;

    pinch = {
      firstId,
      anchorClient: { x: first.x, y: first.y },
      anchorStage: { x: px, y: py },   // point sous le doigt, en coords stage
      dist0,
      mid0,
      scale0: scale,
      tx0: tx, ty0: ty
    };

    setMultiTouch(true);
    keyIndicator.textContent = "✌️ Zoom/Pan tactile";
    keyIndicator.className = "key-indicator";
    keyIndicator.hidden = false;
  }
}

function onPointerMove(e) {
  if (e.pointerType === "mouse") return;
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size < 2 || !pinch) return;

  const pts = [...pointers.values()];
  const first = pts[0];
  const second = pts[1];
  const dx = first.x - second.x;
  const dy = first.y - second.y;
  const dist = Math.hypot(dx, dy);
  const mid = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };

  const factor = dist / pinch.dist0;
  const newScale = clamp(pinch.scale0 * factor, MIN_SCALE, MAX_SCALE);

  // L'ancre (position du premier doigt) doit rester fixe à l'écran :
  //   anchorClient = rectLeft + anchorStage * newScale + tx
  // => tx = anchorClient - rectLeft - anchorStage * newScale
  const r = stage.getBoundingClientRect();
  const ax = pinch.anchorStage.x;
  const ay = pinch.anchorStage.y;

  let newTx = (pinch.anchorClient.x - r.left) - ax * newScale;
  let newTy = (pinch.anchorClient.y - r.top) - ay * newScale;

  // Pan : déplacement du milieu des doigts par rapport au milieu initial
  newTx += mid.x - pinch.mid0.x;
  newTy += mid.y - pinch.mid0.y;

  tx = newTx;
  ty = newTy;
  scale = newScale;
  applyTransform();
}

function onPointerUp(e) {
  if (e.pointerType === "mouse") return;
  pointers.delete(e.pointerId);
  console.log(`[zoom] pointerup tactile id=${e.pointerId}, size=${pointers.size}`);
  if (pointers.size < 2) {
    pinch = null;
    if (pointers.size === 0) {
      setMultiTouch(false);
      keyIndicator.hidden = true;
    }
  }
}    
    stage.addEventListener("pointerdown", onPointerDown, true);
    stage.addEventListener("pointermove", onPointerMove, true);
    stage.addEventListener("pointerup", onPointerUp, true);
    stage.addEventListener("pointercancel", onPointerUp, true);

    // ---- Souris + S / G ----
    let keyMode = null;
    let keyStart = null;

    document.addEventListener("keydown", (e) => {
      const k = e.key.toLowerCase();
      console.log(`[zoom] keydown key="${e.key}" (k="${k}") target=${e.target.tagName}`);
      if (k === "s" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        keyMode = "zoom";
        keyIndicator.textContent = "🔍 ZOOM — maintenez clic gauche et bougez";
        keyIndicator.className = "key-indicator";
        keyIndicator.hidden = false;
        stage.classList.add("mode-zoom");
        console.log("[zoom] keyMode = zoom");
      } else if (k === "g" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        keyMode = "pan";
        keyIndicator.textContent = "✋ GLISSER — maintenez clic gauche et bougez";
        keyIndicator.className = "key-indicator pan";
        keyIndicator.hidden = false;
        stage.classList.add("mode-pan");
        console.log("[zoom] keyMode = pan");
      }
    });

    document.addEventListener("keyup", (e) => {
      const k = e.key.toLowerCase();
      if (k === "s" || k === "g") {
        console.log(`[zoom] keyup key="${e.key}" → reset keyMode`);
        keyMode = null;
        keyStart = null;
        stage.classList.remove("zooming", "panning", "mode-zoom", "mode-pan");
        keyIndicator.hidden = true;
      }
    });

    document.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || !keyMode) return;
      if (!stage.contains(e.target) && e.target !== stage) {
        console.log("[zoom] mousedown hors stage, ignoré");
        return;
      }
      console.log(`[zoom] mousedown ${keyMode} → start`);
      e.preventDefault();
      e.stopPropagation();

      keyStart = { x: e.clientX, y: e.clientY, tx, ty, scale };
      if (keyMode === "zoom") stage.classList.add("zooming");
      else stage.classList.add("panning");
      setMultiTouch(true);

      const move = (ev) => {
        const dx = ev.clientX - keyStart.x;
        const dy = ev.clientY - keyStart.y;
        if (keyMode === "zoom") {
          const factor = Math.max(0.2, 1 + dx / 300);
          scale = clamp(keyStart.scale * factor, MIN_SCALE, MAX_SCALE);
        } else {
          tx = keyStart.tx + dx;
          ty = keyStart.ty + dy;
        }
        applyTransform();
      };
      const up = () => {
        console.log("[zoom] mouseup → end");
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        stage.classList.remove("zooming", "panning");
        setMultiTouch(false);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    }, true);

    // =======================================================================
    // MIRE
    // =======================================================================
    photo.onload = () => {
      syncLayer(photo, candidateLayer);
      syncLayer(photo, mireCanvas);
      mireController.reset();
      mireController.setValidated(false);
      mireController.setLocked(false);
      applyTransform();
      status.textContent =
        "Mire déplaçable. Placez-la sur le cochonnet puis validez.";
    };

    photo.src = objectUrl;

    const CENTER_X = 0.4953;
    const CENTER_Y = 0.4914;

    const mireController = createVectorMire(mireCanvas, stage, status, {
      slider: mireZoom,
      instruction: mireInstruction,
      onDragStart: () => {
        if (!analyzing && !judged && !multiTouchActive) {
          mireController.setValidated(false);
          candidate = null;
          drawBallCandidates(null);
        }
      },
      onDrop: () => {}
    });

    function mireImageCenter() {
      const r = mireController.getRect();
      const pr = photo.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      return {
        x: (r.x + r.w * CENTER_X - s.left) * (photo.naturalWidth / pr.width),
        y: (r.y + r.h * CENTER_Y - s.top) * (photo.naturalHeight / pr.height),
        r: Math.min(r.w, r.h) * 0.45 * 0.38 * (photo.naturalWidth / pr.width)
      };
    }

    // =======================================================================
    // BOUTON PRINCIPAL
    // =======================================================================
    mainBtn.addEventListener("click", async () => {
      if (analyzing) return;

      if (!candidate) {
        analyzing = true;
        mainBtn.disabled = true;
        mainBtn.innerHTML = '<span class="spinner"></span>Validation…';
        try {
          const candidateMire = mireImageCenter();
          if (!candidateMire.r) throw new Error("mire");
          status.textContent = "Recherche du cochonnet…";

          const found = FilaplombCV.bouleProche(
            photo,
            { x: candidateMire.x, y: candidateMire.y },
            jackOptions(candidateMire.r)
          );

          if (found) {
            candidate = { x: found.x, y: found.y, r: found.r };
            status.textContent =
              `Cochonnet recentré (décalage ${Math.round(found.offset)} px).`;
          } else {
            candidate = candidateMire;
            status.textContent =
              "Aucun cercle net détecté : position de la mire conservée.";
          }

          mireController.setLocked(true);
          mireController.setValidated(true);
          validatedBalls = [];
          judged = false;
          judgeBtn.hidden = true;
          workflowStatus.textContent = "Cochonnet validé. Analyse en cours…";
          await searchBalls();
          mainBtn.textContent = "🔄 Recommencer";
        } catch (e) {
          console.error(e);
          status.textContent = "Impossible de lire la mire.";
          candidate = null;
          mireController.setValidated(false);
        } finally {
          analyzing = false;
          mainBtn.disabled = false;
          if (!candidate) mainBtn.textContent = "Valider le cochonnet";
        }
      } else {
        candidate = null;
        validatedBalls = [];
        currentBallIndex = -1;
        judged = false;
        acceptBtn.hidden = true;
        refineBtn.hidden = true;
        judgeBtn.hidden = true;
        drawBallCandidates(null);
        mireController.setLocked(false);
        mireController.setValidated(false);
        mainBtn.textContent = "Valider le cochonnet";
        status.textContent =
          "En attente de l’analyse. Placez la mire sur le cochonnet.";
        workflowStatus.textContent = "Attente photo.";
      }
    });

    async function searchBalls() {
      analyzing = true;
      mainBtn.disabled = true;
      mainBtn.innerHTML = '<span class="spinner"></span>Recherche…';
      const ready = await FilaplombCV.ready();
      if (!ready) {
        status.textContent = "Moteur OpenCV indisponible.";
        analyzing = false;
        mainBtn.disabled = false;
        mainBtn.textContent = candidate
          ? "🔄 Recommencer les recherches"
          : "Valider le cochonnet";
        return;
      }
      try {
        ballCandidates = detectNearbyBalls(photo, candidate);
        validatedBalls = [];
        currentBallIndex = -1;
        if (ballCandidates.length) {
          status.textContent =
            `${ballCandidates.length} candidate(s) trouvée(s).`;
          showNextCandidate();
        } else {
          status.textContent = "Aucune boule trouvée près du cochonnet.";
          drawBallCandidates(null);
          workflowStatus.textContent = "Aucune boule à valider.";
        }
      } finally {
        analyzing = false;
        mainBtn.disabled = false;
        mainBtn.textContent = "🔄 Recommencer les recherches";
      }
    }

    function showNextCandidate() {
      currentBallIndex += 1;
      if (currentBallIndex >= ballCandidates.length) {
        stage.style.cursor = "crosshair";
        acceptBtn.hidden = true;
        refineBtn.hidden = true;
        acceptBtn.disabled = true;
        refineBtn.disabled = true;
        drawBallCandidates(null);
        mireController.setLocked(false);
        status.textContent =
          `Parcours terminé. ${validatedBalls.length} boule(s) validée(s).`;
        workflowStatus.textContent = validatedBalls.length >= 2
          ? "Prêt à juger."
          : "Validez au moins 2 boules pour juger.";
        judgeBtn.hidden = validatedBalls.length < 2;
        judgeBtn.disabled = validatedBalls.length < 2;
        return;
      }

      const ball = ballCandidates[currentBallIndex];
      stage.style.cursor = "grab";
      drawBallCandidates(ball);
      status.textContent =
        `Candidate ${currentBallIndex + 1} / ${ballCandidates.length}. ` +
        `Si le cercle orange n’est pas sur la boule : glissez le disque orange ` +
        `(ou restez appuyé sur « Ajuster » et glissez), puis relâchez. ` +
        `Sinon : « ✓ Boule correcte ».`;
      acceptBtn.hidden = false;
      refineBtn.hidden = false;
      acceptBtn.disabled = false;
      refineBtn.disabled = false;
      workflowStatus.textContent = "Attente validation boule.";
      judgeBtn.hidden = validatedBalls.length < 2;
      judgeBtn.disabled = validatedBalls.length < 2;
    }

    acceptBtn.addEventListener("click", () => {
      if (currentBallIndex < 0 || currentBallIndex >= ballCandidates.length) return;
      const ball = ballCandidates[currentBallIndex];
      const dup = validatedBalls.some(
        b => Math.hypot(b.x - ball.x, b.y - ball.y) <
          Math.min(b.r, ball.r) * 0.8
      );
      if (!dup) {
        validatedBalls.push({
          ...ball,
          label: String.fromCharCode(65 + validatedBalls.length)
        });
      }
      showNextCandidate();
    });

    // =======================================================================
    // AJUSTER
    // =======================================================================
    const ADJUST_TAP_PX = 6;
    let adjust = null;

    refineBtn.style.touchAction = "none";
    refineBtn.addEventListener("contextmenu", e => e.preventDefault());

    const currentBall = () =>
      (!judged && currentBallIndex >= 0 &&
        currentBallIndex < ballCandidates.length)
        ? ballCandidates[currentBallIndex]
        : null;

    function pointerToImage(e) {
      const r = photo.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return {
        x: (e.clientX - r.left) * photo.naturalWidth / r.width,
        y: (e.clientY - r.top) * photo.naturalHeight / r.height
      };
    }

    function startAdjust(e, source, el) {
      if (card._multiTouch) {
        console.log("[zoom] disque : multiTouch actif, drag inhibé");
        return false;
      }
      const ball = currentBall();
      if (!ball || adjust || analyzing) return false;

      adjust = {
        pointerId: e.pointerId,
        source,
        el,
        startX: e.clientX,
        startY: e.clientY,
        origin: { x: ball.x, y: ball.y },
        moved: source === "disc"
      };

      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      acceptBtn.disabled = true;

      if (source === "button") {
        refineBtn.classList.add("dragging");
        status.textContent =
          "Restez appuyé et glissez : le centre du cercle orange suit votre doigt. " +
          "Relâchez pour lancer l’analyse.";
      } else {
        stage.classList.add("adjusting-disc");
        status.textContent =
          "Déplacez le disque orange sur la boule, puis relâchez pour lancer l’analyse.";
      }
      return true;
    }

    function moveAdjust(e) {
      if (!adjust || e.pointerId !== adjust.pointerId) return;
      e.preventDefault();
      if (!adjust.moved &&
          Math.hypot(e.clientX - adjust.startX, e.clientY - adjust.startY) >
            ADJUST_TAP_PX) {
        adjust.moved = true;
      }
      if (!adjust.moved) return;
      const ball = currentBall();
      const p = pointerToImage(e);
      if (!ball || !p) return;
      ball.x = clamp(p.x, 0, photo.naturalWidth);
      ball.y = clamp(p.y, 0, photo.naturalHeight);
      drawBallCandidates(ball);
    }

    function endAdjust(e, cancelled) {
      if (!adjust || e.pointerId !== adjust.pointerId) return;
      const drag = adjust;
      adjust = null;
      try { drag.el.releasePointerCapture(e.pointerId); } catch (_) {}
      refineBtn.classList.remove("dragging");
      stage.classList.remove("adjusting-disc");
      stage.style.cursor = "crosshair";
      acceptBtn.disabled = false;

      const ball = currentBall();
      if (!ball) return;

      if (cancelled) {
        ball.x = drag.origin.x;
        ball.y = drag.origin.y;
        drawBallCandidates(ball);
        status.textContent = "Ajustement annulé.";
        return;
      }

      if (!drag.moved) {
        status.textContent =
          "Restez appuyé sur « Ajuster » puis glissez, ou glissez directement le disque orange.";
        return;
      }

      const found = FilaplombCV.bouleProche(
        photo,
        { x: ball.x, y: ball.y },
        ballOptions(candidate.r * cfg.ballRatio)
      );

      if (found) {
        ballCandidates[currentBallIndex] = {
          x: found.x,
          y: found.y,
          r: found.r,
          distance: Math.hypot(found.x - candidate.x, found.y - candidate.y)
        };
        status.textContent =
          `Cercle recentré (décalage ${Math.round(found.offset)} px, ` +
          `fiabilité ${Math.round(found.quality * 100)} %).`;
      } else {
        status.textContent =
          "Aucun cercle net près de cette position : le disque reste où vous " +
          "l’avez posé.";
      }
      drawBallCandidates(ballCandidates[currentBallIndex]);
    }

    refineBtn.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      startAdjust(e, "button", refineBtn);
    });

    refineBtn.addEventListener("pointermove", moveAdjust);
    refineBtn.addEventListener("pointerup", e => endAdjust(e, false));
    refineBtn.addEventListener("pointercancel", e => endAdjust(e, true));

    stage.addEventListener("pointermove", (e) => {
      if (card._multiTouch || adjust) {
        if (!adjust) stage.style.cursor = "";
        return;
      }
      const ball = currentBall();
      if (!ball || analyzing) { stage.style.cursor = "crosshair"; return; }
      const p = pointerToImage(e);
      if (!p) { stage.style.cursor = "crosshair"; return; }
      const inside = Math.hypot(p.x - ball.x, p.y - ball.y) <= ball.r * 1.15;
      stage.style.cursor = inside ? "pointer" : "crosshair";
    });

    stage.addEventListener("pointerdown", (e) => {
      if (card._multiTouch) {
        console.log("[zoom] disque : multiTouch actif, drag inhibé");
        return;
      }
      if (adjust || (e.pointerType === "mouse" && e.button !== 0)) return;
      const ball = currentBall();
      if (!ball || analyzing) return;
      const p = pointerToImage(e);
      if (!p || Math.hypot(p.x - ball.x, p.y - ball.y) > ball.r * 1.15) return;
      e.preventDefault();
      stage.style.cursor = "grabbing";
      if (startAdjust(e, "disc", stage)) {
        ball.x = clamp(p.x, 0, photo.naturalWidth);
        ball.y = clamp(p.y, 0, photo.naturalHeight);
        drawBallCandidates(ball);
      }
    });
    stage.addEventListener("pointermove", moveAdjust);
    stage.addEventListener("pointerup", e => endAdjust(e, false));
    stage.addEventListener("pointercancel", e => endAdjust(e, true));

    // =======================================================================
    // JUGER
    // =======================================================================
    judgeBtn.addEventListener("click", () => {
      if (validatedBalls.length < 2) return;
      judged = true;
      acceptBtn.hidden = true;
      refineBtn.hidden = true;
      judgeBtn.hidden = true;

      const withDist = validatedBalls.map(b => {
        const dCenter = Math.hypot(b.x - candidate.x, b.y - candidate.y);
        const dSurface = dCenter - candidate.r - b.r;
        const mm = dSurface * (JACK_RADIUS_MM / candidate.r) * 10;
        return { ...b, dCenter, dSurface, mm };
      }).sort((a, b) => a.dSurface - b.dSurface);

      withDist.forEach((b, i) => { b.rank = i + 1; });
      validatedBalls = withDist;
      drawBallCandidates(null);

      status.textContent =
        "Les distances ont été calculées de surface à surface. " +
        "Les diamètres sont ajustés automatiquement.";
      workflowStatus.textContent = "Jugement effectué.";
    });

    // =======================================================================
    // RENDU
    // =======================================================================
    function drawBallCandidates(current) {
      syncLayer(photo, candidateLayer);
      const ctx = candidateLayer.getContext("2d");
      const sx = photo.clientWidth / photo.naturalWidth;
      const sy = photo.clientHeight / photo.naturalHeight;
      ctx.clearRect(0, 0, photo.clientWidth, photo.clientHeight);
      if (!candidate) return;

      ctx.beginPath();
      ctx.arc(candidate.x * sx, candidate.y * sy,
        candidate.r * (sx + sy) / 2, 0, Math.PI * 2);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = "#ff3030";
      ctx.stroke();

      if (judged) {
        validatedBalls.forEach(b => {
          const startX = candidate.x * sx;
          const startY = candidate.y * sy;
          const endX = b.x * sx;
          const endY = b.y * sy;
          ctx.beginPath();
          ctx.moveTo(startX, startY);
          ctx.lineTo(endX, endY);
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = "#facc15";
          ctx.setLineDash([4, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
          const midX = (startX + endX) / 2;
          const midY = (startY + endY) / 2;
          const text = `${b.mm.toFixed(1)} mm`;
          ctx.font = "bold 14px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const textWidth = ctx.measureText(text).width;
          ctx.fillStyle = "#000";
          ctx.fillRect(midX - textWidth / 2 - 5, midY - 10, textWidth + 10, 20);
          ctx.fillStyle = "#facc15";
          ctx.fillText(text, midX, midY);
        });
      }

      validatedBalls.forEach(b => {
        drawBallCircle(ctx, b, sx, sy, "#35d6ff",
          judged ? String(b.rank) : b.label);
      });

      if (current) {
        drawBallCircle(ctx, current, sx, sy, "#ffae35", "✋", true);
      }
    }

    function drawBallCircle(ctx, ball, sx, sy, color, label, adjustable = false) {
      const x = ball.x * sx;
      const y = ball.y * sy;
      const r = ball.r * (sx + sy) / 2;
      let strokeColor = color;
      let fillColor = null;
      if (adjustable) {
        const blink = Math.floor(Date.now() / 500) % 2 === 0;
        strokeColor = blink ? "rgba(0,255,0,0.5)" : "rgba(255,165,0,0.5)";
        fillColor = strokeColor;
      }
      if (fillColor) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = fillColor;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = strokeColor;
      ctx.stroke();
      const fs = Math.max(12, Math.min(r * 1.1, 42));
      ctx.font = `bold ${fs}px Arial`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = Math.max(2, fs * 0.12);
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.strokeText(String(label), x, y);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(String(label), x, y);
    }

    return card;
  }

  // =========================================================================
  // HELPERS
  // =========================================================================
  function syncLayer(photo, canvas) {
    const w = photo.clientWidth;
    const h = photo.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.style.left = `${photo.offsetLeft}px`;
    canvas.style.top = `${photo.offsetTop}px`;
    canvas.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function detectNearbyBalls(photo, jack) {
    const expectedR = jack.r * cfg.ballRatio;
    const found = [];
    const step = Math.max(expectedR * 1.2, 20);
    const maxDist = Math.hypot(photo.naturalWidth, photo.naturalHeight);
    for (let y = 0; y < photo.naturalHeight; y += step) {
      for (let x = 0; x < photo.naturalWidth; x += step) {
        if (Math.hypot(x - jack.x, y - jack.y) > maxDist) continue;
        const hit = FilaplombCV.bouleProche(photo,
          { x, y }, ballOptions(expectedR));
        if (!hit) continue;
        const d = Math.hypot(hit.x - jack.x, hit.y - jack.y);
        if (d < jack.r * 1.5) continue;
        const dup = found.some(
          o => Math.hypot(o.x - hit.x, o.y - hit.y) <
            Math.min(o.r, hit.r) * 0.8
        );
        if (!dup) {
          found.push({ x: hit.x, y: hit.y, r: hit.r, distance: d });
        }
      }
    }
    found.sort((a, b) => a.distance - b.distance);
    return found.slice(0, 8);
  }

  function createVectorMire(canvas, stage, status,
    { onDragStart, onDrop, slider, instruction } = {}) {
    const CENTER_X = 0.4953;
    const CENTER_Y = 0.4914;
    const MIN_ZOOM = 0.1;
    const MAX_ZOOM = 4;

    let xPct = 50;
    let yPct = 50;
    let zoom = 1;
    let dragging = false;
    let activeId = null;
    let startX = 0;
    let startY = 0;
    let offX = 0;
    let offY = 0;
    let isLocked = false;
    let isValidated = false;

    function rect() {
      const c = canvas.getBoundingClientRect();
      return { x: c.left, y: c.top, w: c.width, h: c.height };
    }

    function apply() {
      canvas.style.left = `${xPct}%`;
      canvas.style.top = `${yPct}%`;
      canvas.style.transform =
        `translate(-${CENTER_X * 100}%, -${CENTER_Y * 100}%) scale(${zoom})`;
    }

    function syncValidationControls() {
      const hidden = isValidated;
      if (slider) slider.hidden = hidden;
      if (instruction) instruction.hidden = hidden;
    }

    function setZoom(value) {
      zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
      if (slider) slider.value = String(Math.round(zoom * 100));
      apply();
    }

    function draw() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const R = Math.min(w, h) * 0.45;
      const color = dragging ? "#ff8c00" : "#ffffff";
      drawMireLocal(ctx, w * CENTER_X, h * CENTER_Y, R, color);
    }

    function reset() {
      xPct = 50;
      yPct = 50;
      setZoom(1);
      apply();
      draw();
    }

    if (slider) {
      slider.addEventListener("input", () => {
        if (isValidated) return;
        setZoom(Number(slider.value) / 100);
      });
    }

    canvas.addEventListener("pointerdown", (e) => {
      if (isLocked) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (activeId !== null) return;
      e.preventDefault();
      activeId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      const r = rect();
      offX = e.clientX - (r.x + r.w * CENTER_X);
      offY = e.clientY - (r.y + r.h * CENTER_Y);
      dragging = true;
      if (onDragStart) onDragStart();
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      draw();
    });

    canvas.addEventListener("pointermove", (e) => {
      if (e.pointerId !== activeId || !dragging) return;
      e.preventDefault();
      const s = stage.getBoundingClientRect();
      xPct = ((e.clientX - s.left - offX) / s.width) * 100;
      yPct = ((e.clientY - s.top - offY) / s.height) * 100;
      xPct = Math.max(0, Math.min(100, xPct));
      yPct = Math.max(0, Math.min(100, yPct));
      apply();
    });

    function finish(e) {
      if (e.pointerId !== activeId) return;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      activeId = null;
      dragging = false;
      draw();
      if (onDrop) onDrop();
    }

    canvas.addEventListener("pointerup", finish);
    canvas.addEventListener("pointercancel", finish);

    canvas.addEventListener("wheel", (e) => {
      if (e.deltaY === 0 || isValidated) return;
      e.preventDefault();
      setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });

    apply();
    syncValidationControls();

    return {
      reset,
      getRect: rect,
      isDragging: () => dragging,
      setLocked: (v) => {
        isLocked = v;
        canvas.style.cursor = v ? "default" : "grab";
      },
      setValidated: (v) => {
        isValidated = v;
        syncValidationControls();
      }
    };
  }

  function drawMireLocal(ctx, cx, cy, R, strokeColor) {
    const r = R * 0.38;
    const L = R * 1.35;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 8;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-L, 0); ctx.lineTo(-r, 0);
    ctx.moveTo(r, 0); ctx.lineTo(L, 0);
    ctx.moveTo(0, -L); ctx.lineTo(0, -r);
    ctx.moveTo(0, r); ctx.lineTo(0, L);
    ctx.stroke();
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-L, 0); ctx.lineTo(-r, 0);
    ctx.moveTo(r, 0); ctx.lineTo(L, 0);
    ctx.moveTo(0, -L); ctx.lineTo(0, -r);
    ctx.moveTo(0, r); ctx.lineTo(0, L);
    ctx.stroke();
    ctx.fillStyle = strokeColor;
    ctx.beginPath(); ctx.arc(0, 0, 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

})();
