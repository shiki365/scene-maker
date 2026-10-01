/*!
 * model.v1.js - シーンメーカー: the state, its defaults, repair of old data, and state -> CCFOLIA scenes (no UI)
 *
 * state = { images, scenes, commonFg, defaults, exportOpts, orderBase }
 *   images:   the image shelf: [{ id, name, type, size, hash, w, h, moving }]
 *             Only what an image is lives in state; its bytes are a Blob in IndexedDB.
 *   scenes:   [{ id, ccfId, name, text, bg, fg, width, height, sizeAuto, displayGrid, gridSize, fit }]
 *             bg: an image id or null.  fg: "common" (state.commonFg) | "none" | an image id.
 *             ccfId: the id the scene gets in CCFOLIA when exporting in "overwrite" mode.
 *             sizeAuto: the field size follows the background's shape until typed by hand.
 *   defaults: what a new scene starts with, and what the "全シーンに" buttons copy.
 *
 * The shape of a scene is read from CCFOLIA 1.37.4 (main.09686af1.js, 2026-10-02):
 *   fieldWidth / fieldHeight are in cells, one cell is 24 px; the screen takes 0-1000.
 *   gridSize is how many cells between grid lines (1-1000). fieldObjectFit is "fill" or "cover".
 *   The list is ordered by `order`; a scene without it does not show.
 *   The media / sound fields are left as a new scene has them: audio cannot travel in the zip.
 */
(function (root) {
  "use strict";

  const CELL = 24;       // px per cell on CCFOLIA's board
  const MAX_CELLS = 1000;
  const FITS = ["fill", "cover"];
  const MAX_IMAGE = 5 * 1024 * 1024; // CCFOLIA's upload limit for images

  const uid = p => p + Math.random().toString(36).slice(2, 10);
  const clampInt = (v, min, max, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

  const defaultDefaults = () => ({ longSide: 48, displayGrid: false, gridSize: 1, fit: "fill" });
  const defaultExportOpts = () => ({ mode: "add", shrink: true });
  const defaultState = () => ({ images: [], scenes: [], commonFg: null, defaults: defaultDefaults(), exportOpts: defaultExportOpts(), orderBase: 0 });

  // Field size in cells for an image of w x h px: keep its shape, long side = longSide cells.
  function suggestSize(w, h, longSide) {
    const L = clampInt(longSide, 1, MAX_CELLS, 48);
    if (!(w > 0 && h > 0)) return { width: 40, height: 30 }; // CCFOLIA's own default
    return w >= h ? { width: L, height: Math.max(1, Math.round(L * h / w)) } : { width: Math.max(1, Math.round(L * w / h)), height: L };
  }

  function newScene(state, image, ccfId) {
    const d = state.defaults;
    const size = image ? suggestSize(image.w, image.h, d.longSide) : { width: 40, height: 30 };
    return {
      id: uid("s"), ccfId, name: image ? image.name : "", text: "", bg: image ? image.id : null, fg: "common",
      width: size.width, height: size.height, sizeAuto: true, displayGrid: d.displayGrid, gridSize: d.gridSize, fit: d.fit,
    };
  }

  function normalize(s) {
    const d = defaultState();
    if (!s || typeof s !== "object") return d;
    const images = Array.isArray(s.images) ? s.images.filter(im => im && im.id).map(im => ({
      id: String(im.id), name: String(im.name || ""), type: String(im.type || ""), size: Number(im.size) || 0, hash: String(im.hash || ""),
      w: Number(im.w) || 0, h: Number(im.h) || 0, moving: !!im.moving,
    })) : [];
    const has = id => images.some(im => im.id === id);
    const dd = Object.assign(defaultDefaults(), s.defaults && typeof s.defaults === "object" ? s.defaults : {});
    const defaults = {
      longSide: clampInt(dd.longSide, 1, MAX_CELLS, 48), displayGrid: !!dd.displayGrid,
      gridSize: clampInt(dd.gridSize, 1, MAX_CELLS, 1), fit: FITS.includes(dd.fit) ? dd.fit : "fill",
    };
    const scenes = Array.isArray(s.scenes) ? s.scenes.filter(x => x && typeof x === "object").map(x => ({
      id: String(x.id || uid("s")), ccfId: String(x.ccfId || ""), name: String(x.name || ""), text: String(x.text || ""),
      bg: has(x.bg) ? String(x.bg) : null,
      fg: x.fg === "none" || has(x.fg) ? String(x.fg) : "common",
      width: clampInt(x.width, 1, MAX_CELLS, 40), height: clampInt(x.height, 1, MAX_CELLS, 30), sizeAuto: !!x.sizeAuto,
      displayGrid: !!x.displayGrid, gridSize: clampInt(x.gridSize, 1, MAX_CELLS, 1), fit: FITS.includes(x.fit) ? x.fit : "fill",
    })) : [];
    const eo = Object.assign(defaultExportOpts(), s.exportOpts && typeof s.exportOpts === "object" ? s.exportOpts : {});
    return {
      images, scenes, commonFg: has(s.commonFg) ? String(s.commonFg) : null, defaults,
      exportOpts: { mode: eo.mode === "overwrite" ? "overwrite" : "add", shrink: !!eo.shrink },
      orderBase: Number(s.orderBase) || 0,
    };
  }

  // The image id a scene shows in front, or null.
  const fgIdOf = (state, scene) => scene.fg === "common" ? state.commonFg : scene.fg === "none" ? null : scene.fg;

  // One scene as CCFOLIA stores it. background / foreground: a URL, a file to pack, or null.
  function toEntity(scene, background, foreground, order) {
    return {
      name: scene.name, text: scene.text, backgroundUrl: background || null, foregroundUrl: foreground || null,
      fieldObjectFit: scene.fit, fieldWidth: scene.width, fieldHeight: scene.height,
      displayGrid: scene.displayGrid, gridSize: scene.gridSize, markers: {},
      mediaName: "", mediaUrl: null, mediaRef: null, mediaType: "", mediaRepeat: true, mediaVolume: 0.5,
      soundName: "", soundUrl: null, soundRef: null, soundRepeat: false, soundVolume: 0.5,
      locked: false, order,
    };
  }

  root.SceneModel = { CELL, MAX_CELLS, FITS, MAX_IMAGE, uid, clampInt, defaultState, normalize, suggestSize, newScene, fgIdOf, toEntity };
})(typeof window !== "undefined" ? window : globalThis);
