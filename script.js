/* ============================================================
   FILAPLOMB — script.js
   Workflow photo : galerie (une seule photo à la fois, règle S9-b),
   mire vectorisée canvas, détection cochonnet/boules via
   FilaplombCV.bouleProche, labels A/B/C… puis 1/2/3… après jugement,
   distances surface à surface (cm + r_c).

   Expose : window.PhotoWorkflow.addPhoto(file)  (utilisé par scriptAPN.js)
   ============================================================ */

(function () {
  "use strict";

  // Réglages de l'analyse (curseurs du volet de droite)
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
  const closeSidebarBtn = document.getElementById("close-sidebar-btn");
  const sidebar = document.getElementById("sidebar");
  const sidebarOverlay = document.getElementById("sidebar-overlay");

  function toggleSidebar(open) {
    sidebar.classList.toggle("open", open);
    sidebarOverlay.classList.toggle("open", open);
    hamburgerBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  hamburgerBtn.addEventListener("click", () => toggleSidebar(true));
 
  sidebarOverlay.addEventListener("click", () => toggleSidebar(false));

  // Un clic ou un toucher hors du volet le replie (souris, doigt ou stylet).
  document.addEventListener("pointerdown", (e) => {
    if (!sidebar.classList.contains("open")) return;
    if (sidebar.contains(e.target) || hamburgerBtn.contains(e.target)) return;
    toggleSidebar(false);
  }, true);

  // --- Curseurs de réglage de l'analyse ---
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

    const sync = () => {
      out.textContent = fmt[key](input.value);
    };

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
      openCvStatus.textContent =
        "Le moteur OpenCV ne s’est pas chargé. Vérifiez la connexion puis rechargez.";
      openCvStatus.classList.add("error");
    }
  });

  // --- Calibration fil à plomb (volet) ---
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

    if (!ok) {
      calibStatus.textContent = "Capteur d’orientation indisponible.";
    }
  });

  if (window.Filaplomb) {
    Filaplomb.on("calibrated", refreshCalibStatus);
  }

  refreshCalibStatus();

  // --- Bouton APN (délégué à scriptAPN.js) ---
  apnBtn.addEventListener("click", () => {
    toggleSidebar(false);
    if (window.APN && window.APN.open) {
      window.APN.open();
    }
  });

  // --- Chargement fichier (une seule photo, règle S9-b) ---
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
      box.append("Pas de photo : prenez-en une ou choisissez-en une dans le volet.");
    };

    box.append(img);
    gallery.replaceChildren(box);
  }

  function addPhoto(file) {
    releaseCurrent();
    workflowStatus.textContent = "Photo chargée. Attente analyse.";

    const card = createPhotoCard(file);
    gallery.append(card);
    currentCard = card;
  }

  window.PhotoWorkflow = { addPhoto };
  showPlaceholder();

  // --- Card ---
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
	judgeBtn.style.backgroundColor = "#FF00FF"; // Fuchsia
judgeBtn.style.color = "#fff";
judgeBtn.style.fontWeight = "600";

    actions.append(mainBtn, acceptBtn, refineBtn, judgeBtn);

    // PC (souris) : la molette règle aussi la taille de la mire.
    let mireHint = null;
    if (
      window.matchMedia &&
      window.matchMedia("(hover: hover) and (pointer: fine)").matches
    ) {
      mireHint = document.createElement("p");
      mireHint.className = "status mire-hint";
      mireHint.textContent =
        "Utiliser la molette centrale de la souris pour régler la taille de la mire";
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

    // Curseur vertical de zoom de la mire.
    const mireZoom = document.createElement("input");
    mireZoom.type = "range";
    mireZoom.className = "mire-zoom";
    mireZoom.min = "10";
    mireZoom.max = "400";
    mireZoom.step = "1";
    mireZoom.value = "100";
    mireZoom.setAttribute("aria-label", "Taille de la mire");

    const mireInstruction = document.createElement("p");
    mireInstruction.className = "status mire-instruction";
    mireInstruction.textContent =
      "Soigner le réglage boule et cochonnet petit et grand cercle puis laisser la mire centrée sur le cochonnet";

    const status = document.createElement("p");
    status.className = "status";
    status.textContent = "En attente de l’analyse.";

    stage.append(photo, candidateLayer, mireCanvas, mireZoom);
    card.append(actions);

    if (mireHint) {
      card.append(mireHint);
    }

    card.append(stage, mireInstruction, status);

    const objectUrl = URL.createObjectURL(file);
    currentObjectURL = objectUrl;

    photo.onload = () => {
      syncLayer(photo, candidateLayer);
      syncLayer(photo, mireCanvas);
      mireController.reset();
      mireController.setValidated(false);
      mireController.setLocked(false);
      status.textContent =
        "Mire déplaçable. Placez-la sur le cochonnet puis validez.";
    };

    photo.src = objectUrl;

    // --- État local ---
    let candidate = null;
    let ballCandidates = [];
    let validatedBalls = [];
    let currentBallIndex = -1;
    let judged = false;
    let analyzing = false;
setInterval(() => {
  if (
    currentBallIndex >= 0 &&
    currentBallIndex < ballCandidates.length &&
    !judged
  ) {
    drawBallCandidates(
      ballCandidates[currentBallIndex]
    );
  }
}, 500);
    // --- Mire vectorisée ---
    const CENTER_X = 0.4953;
    const CENTER_Y = 0.4914;

    const mireController = createVectorMire(mireCanvas, stage, status, {
      slider: mireZoom,
      instruction: mireInstruction,

      onDragStart: () => {
        if (!analyzing && !judged) {
          // Le déplacement de la mire annule la validation précédente.
          mireController.setValidated(false);
          candidate = null;
          drawBallCandidates(null);
        }
      },

      onDrop: () => {}
    });

    function mireImageCenter() {
      const r = mireController.getRect();
      const s = stage.getBoundingClientRect();

      return {
        x: (r.x + r.w * CENTER_X - s.left) *
          (photo.naturalWidth / photo.clientWidth),

        y: (r.y + r.h * CENTER_Y - s.top) *
          (photo.naturalHeight / photo.clientHeight),

        // La mire est dessinée avec R = 0,45 × min(largeur, hauteur) du canvas ;
        // petit cercle = 0,38 × R.
        r: Math.min(r.w, r.h) * 0.45 * 0.38 *
          (photo.naturalWidth / photo.clientWidth)
      };
    }

    // --- Bouton principal ---
    mainBtn.addEventListener("click", async () => {
      if (analyzing) return;

      if (!candidate) {
        // Valider le cochonnet.
        analyzing = true;
        mainBtn.disabled = true;
        mainBtn.innerHTML = '<span class="spinner"></span>Validation…';

        try {
          const candidateMire = mireImageCenter();

          if (!candidateMire.r) {
            throw new Error("mire");
          }

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

          // Une fois le cochonnet validé, le curseur de taille est masqué.
          mireController.setLocked(true);
          mireController.setValidated(true);

          validatedBalls = [];
          judged = false;
          judgeBtn.hidden = true;

          workflowStatus.textContent = "Cochonnet validé. Analyse en cours…";
          await searchBalls();

          mainBtn.textContent = "🔄 Recommencer les recherches";
        } catch (e) {
          console.error(e);
          status.textContent = "Impossible de lire la mire.";
          candidate = null;
          mireController.setValidated(false);
        } finally {
          analyzing = false;
          mainBtn.disabled = false;

          if (!candidate) {
            mainBtn.textContent = "Valider le cochonnet";
          }
        }
      } else {
        // Recommencer les recherches.
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

        // La mire peut être déplacée pour recommencer, mais le curseur de taille
        // reste masqué tant que le cochonnet n'a pas été invalidé.
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
      if (currentBallIndex < 0 || currentBallIndex >= ballCandidates.length) {
        return;
      }

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

    // --- Ajuster ---
    // Deux gestes équivalents :
    // (1) glisser directement le disque orange ;
    // (2) rester appuyé sur « Ajuster » et glisser.
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

      if (!r.width || !r.height) {
        return null;
      }

      return {
        x: (e.clientX - r.left) * photo.naturalWidth / r.width,
        y: (e.clientY - r.top) * photo.naturalHeight / r.height
      };
    }

    function startAdjust(e, source, el) {
      const ball = currentBall();

      if (!ball || adjust || analyzing) {
        return false;
      }

      adjust = {
        pointerId: e.pointerId,
        source,
        el,
        startX: e.clientX,
        startY: e.clientY,
        origin: { x: ball.x, y: ball.y },
        moved: source === "disc"
      };

      try {
        el.setPointerCapture(e.pointerId);
      } catch (_) {}

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
      if (!adjust || e.pointerId !== adjust.pointerId) {
        return;
      }

      e.preventDefault();

      if (
        !adjust.moved &&
        Math.hypot(e.clientX - adjust.startX, e.clientY - adjust.startY) >
          ADJUST_TAP_PX
      ) {
        adjust.moved = true;
      }

      if (!adjust.moved) {
        return;
      }

      const ball = currentBall();
      const p = pointerToImage(e);

      if (!ball || !p) {
        return;
      }

      ball.x = clamp(p.x, 0, photo.naturalWidth);
      ball.y = clamp(p.y, 0, photo.naturalHeight);
      drawBallCandidates(ball);
    }

    function endAdjust(e, cancelled) {
      if (!adjust || e.pointerId !== adjust.pointerId) {
        return;
      }

      const drag = adjust;
      adjust = null;

      try {
        drag.el.releasePointerCapture(e.pointerId);
      } catch (_) {}

      refineBtn.classList.remove("dragging");
      stage.classList.remove("adjusting-disc");
	  stage.style.cursor = "grab";
	  stage.style.cursor = "pointer";
      acceptBtn.disabled = false;

      const ball = currentBall();

      if (!ball) {
        return;
      }

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

      // Recherche d'un cercle concentrique ou très proche,
      // centrée sur le centre du disque orange.
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
          `fiabilité ${Math.round(found.quality * 100)} %). ` +
          `Sinon glissez encore le disque.`;
      } else {
        status.textContent =
          "Aucun cercle net près de cette position : le disque reste où vous " +
          "l’avez posé. Glissez-le pour le replacer (l’analyse repart au relâcher) " +
          "ou ajustez les curseurs du volet.";
      }

      drawBallCandidates(ballCandidates[currentBallIndex]);
    }

    refineBtn.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) {
        return;
      }

      e.preventDefault();
      startAdjust(e, "button", refineBtn);
    });

    refineBtn.addEventListener("pointermove", moveAdjust);
    refineBtn.addEventListener("pointerup", e => endAdjust(e, false));
    refineBtn.addEventListener("pointercancel", e => endAdjust(e, true));
// Curseur main lorsqu'on survole le disque orange
stage.addEventListener("pointermove", (e) => {

  if (adjust) return;

  const ball = currentBall();

  if (!ball || analyzing) {
    stage.style.cursor = "crosshair";
    return;
  }

  const p = pointerToImage(e);

  if (!p) {
    stage.style.cursor = "crosshair";
    return;
  }

  const inside =
    Math.hypot(
      p.x - ball.x,
      p.y - ball.y
    ) <= ball.r * 1.15;

  stage.style.cursor =
    inside ? "grab" : "crosshair";
});

stage.addEventListener("pointermove", (e) => {

  if (adjust) return;

  const ball = currentBall();

  if (!ball || analyzing) {
    stage.style.cursor = "crosshair";
    return;
  }

  const p = pointerToImage(e);

  if (!p) {
    stage.style.cursor = "crosshair";
    return;
  }

  const inside =
    Math.hypot(p.x - ball.x, p.y - ball.y) <= ball.r * 1.15;

  stage.style.cursor = inside ? "pointer" : "crosshair";

});

stage.addEventListener("pointerdown", (e) => {

  if (
    adjust ||
    (e.pointerType === "mouse" && e.button !== 0)
  ) {
    return;
  }

  const ball = currentBall();

  if (!ball || analyzing) {
    return;
  }

  const p = pointerToImage(e);

  if (
    !p ||
    Math.hypot(
      p.x - ball.x,
      p.y - ball.y
    ) > ball.r * 1.15
  ) {
    return;
  }

  e.preventDefault();

  stage.style.cursor = "grabbing";

  if (startAdjust(e, "disc", stage)) {

    ball.x = clamp(
      p.x,
      0,
      photo.naturalWidth
    );

    ball.y = clamp(
      p.y,
      0,
      photo.naturalHeight
    );

    drawBallCandidates(ball);
  }
}); stage.addEventListener("pointermove", moveAdjust);
    stage.addEventListener("pointerup", e => endAdjust(e, false));
    stage.addEventListener("pointercancel", e => endAdjust(e, true));

    // --- Juger ---
    judgeBtn.addEventListener("click", () => {
      if (validatedBalls.length < 2) {
        return;
      }

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

      withDist.forEach((b, i) => {
        b.rank = i + 1;
      });

      validatedBalls = withDist;
      drawBallCandidates(null);

      status.textContent =
        "Les distances ont été calculées de surface à surface. " +
        "Les diamètres sont ajustés automatiquement.";
      workflowStatus.textContent = "Jugement effectué.";
    });

    // --- Rendu candidates / jugement ---
    function drawBallCandidates(current) {
      syncLayer(photo, candidateLayer);

      const ctx = candidateLayer.getContext("2d");
      const sx = photo.clientWidth / photo.naturalWidth;
      const sy = photo.clientHeight / photo.naturalHeight;

      ctx.clearRect(0, 0, photo.clientWidth, photo.clientHeight);

      if (!candidate) {
        return;
      }

      ctx.beginPath();
      ctx.arc(
        candidate.x * sx,
        candidate.y * sy,
        candidate.r * (sx + sy) / 2,
        0,
        Math.PI * 2
      );
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = "#ff3030";
      ctx.stroke();

      if (judged) {
        validatedBalls.forEach(b => {
          const startX = candidate.x * sx;
          const startY = candidate.y * sy;
          const endX = b.x * sx;
          const endY = b.y * sy;

          // Tracé en pointillé jaune.
          ctx.beginPath();
          ctx.moveTo(startX, startY);
          ctx.lineTo(endX, endY);
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = "#facc15";
          ctx.setLineDash([4, 4]);
          ctx.stroke();
          ctx.setLineDash([]);

          // Texte au milieu de la ligne.
          const midX = (startX + endX) / 2;
          const midY = (startY + endY) / 2;
          const text = `${b.mm.toFixed(1)} mm`;

          ctx.font = "bold 14px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";

          const textWidth = ctx.measureText(text).width;
          ctx.fillStyle = "#000";
          ctx.fillRect(
            midX - textWidth / 2 - 5,
            midY - 10,
            textWidth + 10,
            20
          );

          ctx.fillStyle = "#facc15";
          ctx.fillText(text, midX, midY);
        });
      }

      validatedBalls.forEach(b => {
        drawBallCircle(
          ctx,
          b,
          sx,
          sy,
          "#35d6ff",
          judged ? String(b.rank) : b.label
        );
      });

  if (current) {
  drawBallCircle(
    ctx,
    current,
    sx,
    sy,
    "#ffae35",
    "✋",
    true
  );
}
    }

function drawBallCircle(
  ctx,
  ball,
  sx,
  sy,
  color,
  label,
  adjustable = false
) {
  const x = ball.x * sx;
  const y = ball.y * sy;
  const r = ball.r * (sx + sy) / 2;

  let strokeColor = color;
  let fillColor = null;

  // Cas spécial : cercle orange réglable ("?")
  if (adjustable) {
    const blink = Math.floor(Date.now() / 500) % 2 === 0;

    strokeColor = blink
      ? "rgba(0,255,0,0.5)"
      : "rgba(255,165,0,0.5)";

    fillColor = strokeColor;
  }

  // Remplissage du disque
  if (fillColor) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fillColor;
    ctx.fill();
  }

  // Contour
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);

  ctx.lineWidth = 2;
  ctx.strokeStyle = strokeColor;
  ctx.stroke();

  // Taille du texte
  const fs = Math.max(12, Math.min(r * 1.1, 42));

  ctx.font = `bold ${fs}px Arial`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Contour noir du texte
  ctx.lineWidth = Math.max(2, fs * 0.12);
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.strokeText(String(label), x, y);

  // Texte blanc
  ctx.fillStyle = "#ffffff";
  ctx.fillText(String(label), x, y);
}

    return card;
  }

  // --- Canvas helpers ---
  function syncLayer(photo, canvas) {
    const w = photo.clientWidth;
    const h = photo.clientHeight;

    if (!w || !h) {
      return;
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.style.left = `${photo.offsetLeft}px`;
    canvas.style.top = `${photo.offsetTop}px`;
    canvas.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // --- Détection des boules ---
  function detectNearbyBalls(photo, jack) {
    const expectedR = jack.r * cfg.ballRatio;
    const found = [];
    const step = Math.max(expectedR * 1.2, 20);
    const maxDist = Math.hypot(photo.naturalWidth, photo.naturalHeight);

    for (let y = 0; y < photo.naturalHeight; y += step) {
      for (let x = 0; x < photo.naturalWidth; x += step) {
        if (Math.hypot(x - jack.x, y - jack.y) > maxDist) {
          continue;
        }

        const hit = FilaplombCV.bouleProche(
          photo,
          { x, y },
          ballOptions(expectedR)
        );

        if (!hit) {
          continue;
        }

        const d = Math.hypot(hit.x - jack.x, hit.y - jack.y);

        if (d < jack.r * 1.5) {
          continue;
        }

        const dup = found.some(
          o => Math.hypot(o.x - hit.x, o.y - hit.y) <
            Math.min(o.r, hit.r) * 0.8
        );

        if (!dup) {
          found.push({
            x: hit.x,
            y: hit.y,
            r: hit.r,
            distance: d
          });
        }
      }
    }

    found.sort((a, b) => a.distance - b.distance);
    return found.slice(0, 8);
  }

  // --- Mire vectorisée ---
  function createVectorMire(
    canvas,
    stage,
    status,
    { onDragStart, onDrop, slider, instruction } = {}
  ) {
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

      return {
        x: c.left,
        y: c.top,
        w: c.width,
        h: c.height
      };
    }

    function apply() {
      canvas.style.left = `${xPct}%`;
      canvas.style.top = `${yPct}%`;
      canvas.style.transform =
        `translate(-${CENTER_X * 100}%, -${CENTER_Y * 100}%) scale(${zoom})`;
    }

    function syncValidationControls() {
      const hidden = isValidated;

      if (slider) {
        slider.hidden = hidden;
      }

      if (instruction) {
        instruction.hidden = hidden;
      }
    }

    function setZoom(value) {
      zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));

      if (slider) {
        slider.value = String(Math.round(zoom * 100));
      }

      apply();
    }

    function draw() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;

      if (!w || !h) {
        return;
      }

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
        if (isValidated) {
          return;
        }

        setZoom(Number(slider.value) / 100);
      });
    }

    canvas.addEventListener("pointerdown", (e) => {
      if (isLocked) {
        return;
      }

      if (e.pointerType === "mouse" && e.button !== 0) {
        return;
      }

      if (activeId !== null) {
        return;
      }

      e.preventDefault();
      activeId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;

      const r = rect();
      offX = e.clientX - (r.x + r.w * CENTER_X);
      offY = e.clientY - (r.y + r.h * CENTER_Y);
      dragging = true;

      if (onDragStart) {
        onDragStart();
      }

      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (_) {}

      draw();
    });

    canvas.addEventListener("pointermove", (e) => {
      if (e.pointerId !== activeId || !dragging) {
        return;
      }

      e.preventDefault();

      const s = stage.getBoundingClientRect();

      xPct = ((e.clientX - s.left - offX) / s.width) * 100;
      yPct = ((e.clientY - s.top - offY) / s.height) * 100;

      xPct = Math.max(0, Math.min(100, xPct));
      yPct = Math.max(0, Math.min(100, yPct));

      apply();
    });

    function finish(e) {
      if (e.pointerId !== activeId) {
        return;
      }

      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch (_) {}

      activeId = null;
      dragging = false;
      draw();

      if (onDrop) {
        onDrop();
      }
    }

    canvas.addEventListener("pointerup", finish);
    canvas.addEventListener("pointercancel", finish);

    canvas.addEventListener("wheel", (e) => {
      if (e.deltaY === 0 || isValidated) {
        return;
      }

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

  // --- Rendu local de la mire ---
  function drawMireLocal(ctx, cx, cy, R, strokeColor) {
    const r = R * 0.38;
    const L = R * 1.35;

    ctx.save();
    ctx.translate(cx, cy);

    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 8;

    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(-L, 0);
    ctx.lineTo(-r, 0);
    ctx.moveTo(r, 0);
    ctx.lineTo(L, 0);
    ctx.moveTo(0, -L);
    ctx.lineTo(0, -r);
    ctx.moveTo(0, r);
    ctx.lineTo(0, L);
    ctx.stroke();

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 4;

    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(-L, 0);
    ctx.lineTo(-r, 0);
    ctx.moveTo(r, 0);
    ctx.lineTo(L, 0);
    ctx.moveTo(0, -L);
    ctx.lineTo(0, -r);
    ctx.moveTo(0, r);
    ctx.lineTo(0, L);
    ctx.stroke();

    ctx.fillStyle = strokeColor;
    ctx.beginPath();
    ctx.arc(0, 0, 3.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

})(); 