
/* ============================================================
   FILAPLOMB — cv-core.js
   Socle partagé : chargement d'OpenCV + détection de cercle
   (Canny + distanceTransform + analyse radiale) + helpers.

   API exposée : window.FilaplombCV
     ready()        → Promise<boolean>   OpenCV utilisable ?
     bouleProche(photo, center, opts)    → {x,y,r,offset,quality} | null
     toFrame(f, x, y), toScreen(f, c)    → conversions repère écran ↔ image
     clamp(v, lo, hi), dist(a, b)        → helpers purs
   ============================================================ */

(function () {
  "use strict";

  let readyPromise = null;

  function cvIsReady() {
    const c = window.cv;
    return !!(c && c.Mat && c.Canny && c.imread && c.distanceTransform);
  }

  function ready() {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise((resolve) => {
      const started = performance.now();
      let thenHooked = false;
      const timer = setInterval(() => {
        const c = window.cv;
        // Build « Promise » : cv.then livre le module quand prêt.
        if (c && typeof c.then === "function" && !c.Mat && !thenHooked) {
          thenHooked = true;
          c.then((mod) => { window.cv = mod; });
        }
        if (cvIsReady()) {
          clearInterval(timer);
          resolve(true);
        } else if (performance.now() - started > 30000) {
          clearInterval(timer);
          resolve(false);
        }
      }, 100);
    });
    return readyPromise;
  }

  // Conversions repère écran ↔ repère image (le frame capture est à l'échelle fscale).
  const toFrame = (f, x, y) => ({
    x: ((x - f.offX) / f.s) * f.fscale,
    y: ((y - f.offY) / f.s) * f.fscale
  });
  const toScreen = (f, c) => ({
    x: c.x / f.fscale * f.s + f.offX,
    y: c.y / f.fscale * f.s + f.offY,
    r: c.r / f.fscale * f.s,
    quality: c.quality,
    offset: c.offset / f.fscale * f.s
  });

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  /**
   * bouleProche : cherche UN cercle concentrique ou très proche, de rayon
   * voisin du rayon attendu. Méthode : contours (Canny) + distanceTransform,
   * puis test radial (le gradient doit être perpendiculaire au cercle).
   * Rejette lignes droites et textures — bien plus fiable que Hough sur gravier.
   *
   * @param photo    <img> ou <canvas> avec naturalWidth/naturalHeight
   * @param center   {x,y} point de départ, en px image d'origine
   * @param options  expectedR, minRatio, maxRatio, maxOffsetFactor,
   *                 minCoverage, offsetWeight, radiusWeight
   * @returns        {x,y,r,offset,quality} en px image d'origine, ou null
   */
  function bouleProche(photo, center, options) {
    const {
      expectedR, minRatio = 0.7, maxRatio = 1.3, maxOffsetFactor = 1.0,
      minCoverage = 0.45, offsetWeight = 0.08, radiusWeight = 0.08
    } = options;
    if (!cvIsReady() || !photo.naturalWidth || !(expectedR > 0)) return null;

    const half = expectedR * (maxRatio + maxOffsetFactor) + 4;
    const x0 = Math.max(0, Math.floor(center.x - half));
    const y0 = Math.max(0, Math.floor(center.y - half));
    const x1 = Math.min(photo.naturalWidth,  Math.ceil(center.x + half));
    const y1 = Math.min(photo.naturalHeight, Math.ceil(center.y + half));
    const roiW = x1 - x0;
    const roiH = y1 - y0;
    if (roiW < 12 || roiH < 12) return null;

    const scale = Math.min(1, 28 / expectedR);
    const work = document.createElement("canvas");
    work.width  = Math.max(1, Math.round(roiW * scale));
    work.height = Math.max(1, Math.round(roiH * scale));
    work.getContext("2d", { willReadFrequently: true })
      .drawImage(photo, x0, y0, roiW, roiH, 0, 0, work.width, work.height);

    const src      = cv.imread(work);
    const gray     = new cv.Mat();
    const blurred  = new cv.Mat();
    const gx       = new cv.Mat();
    const gy       = new cv.Mat();
    const mag      = new cv.Mat();
    const edges    = new cv.Mat();
    const inverted = new cv.Mat();
    const distMat  = new cv.Mat();
    const ksize    = new cv.Size(5, 5);

    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blurred, ksize, 1.5);
      cv.Sobel(blurred, gx, cv.CV_32F, 1, 0, 3);
      cv.Sobel(blurred, gy, cv.CV_32F, 0, 1, 3);
      cv.magnitude(gx, gy, mag);

      const magData = mag.data32F;
      let magMax = 0;
      for (let i = 0; i < magData.length; i++) if (magData[i] > magMax) magMax = magData[i];
      if (magMax < 40) return null;
      const bins = new Uint32Array(256);
      for (let i = 0; i < magData.length; i++)
        bins[Math.min(255, (magData[i] / magMax * 255) | 0)]++;
      let acc = 0, p85 = magMax;
      for (let b = 0; b < 256; b++) {
        acc += bins[b];
        if (acc >= magData.length * 0.85) { p85 = (b + 1) / 255 * magMax; break; }
      }
      const high = Math.max(40, p85);
      cv.Canny(blurred, edges, high * 0.4, high, 3, true);

      cv.bitwise_not(edges, inverted);
      cv.distanceTransform(inverted, distMat, cv.DIST_L2, 3);

      const W = distMat.cols, H = distMat.rows;
      const distData = distMat.data32F;
      const gxData = gx.data32F, gyData = gy.data32F;

      const rW   = expectedR * scale;
      const minR = Math.max(4, Math.floor(rW * minRatio));
      const maxR = Math.max(minR + 2, Math.ceil(rW * maxRatio));
      const maxOff = rW * maxOffsetFactor;
      const cxW = (center.x - x0) * scale;
      const cyW = (center.y - y0) * scale;
      const stepC = Math.max(1, rW / 20);
      const TOL = 2.5;
      const N = 64;
      const cosT = new Float32Array(N);
      const sinT = new Float32Array(N);
      for (let k = 0; k < N; k++) {
        cosT[k] = Math.cos(2 * Math.PI * k / N);
        sinT[k] = Math.sin(2 * Math.PI * k / N);
      }

      let best = null, bestScore = -Infinity;
      for (let cy = cyW - maxOff; cy <= cyW + maxOff; cy += stepC) {
        for (let cx = cxW - maxOff; cx <= cxW + maxOff; cx += stepC) {
          const offset = Math.hypot(cx - cxW, cy - cyW);
          if (offset > maxOff) continue;
          for (let r = minR; r <= maxR; r++) {
            let sum = 0, inside = 0;
            for (let k = 0; k < N; k++) {
              const xi = (cx + r * cosT[k] + 0.5) | 0;
              const yi = (cy + r * sinT[k] + 0.5) | 0;
              if (xi < 0 || yi < 0 || xi >= W || yi >= H) continue;
              inside++;
              const idx = yi * W + xi;
              const d = distData[idx];
              if (d >= TOL) continue;
              const m = Math.hypot(gxData[idx], gyData[idx]);
              if (m < 1e-3) continue;
              const c = (gxData[idx] * cosT[k] + gyData[idx] * sinT[k]) / m;
              if (c >= 0.6 || c <= -0.6) sum += 1 - d / TOL;
            }
            if (inside < N * 0.7) continue;
            const coverage = sum / inside;
            const score = coverage
              - offsetWeight * (offset / (maxOff || 1))
              - radiusWeight * Math.abs(r - rW) / rW;
            if (score > bestScore) {
              bestScore = score;
              best = { cx, cy, r, coverage, offset };
            }
          }
        }
      }

      if (!best || best.coverage < minCoverage) return null;
      return {
        x: x0 + best.cx / scale,
        y: y0 + best.cy / scale,
        r: best.r / scale,
        offset: best.offset / scale,
        quality: best.coverage
      };
    } finally {
      src.delete(); gray.delete(); blurred.delete(); gx.delete(); gy.delete();
      mag.delete(); edges.delete(); inverted.delete(); distMat.delete();
    }
  }

  window.FilaplombCV = { ready, bouleProche, toFrame, toScreen, clamp, dist };
})();
