/*!
 * app.v1.js - シーンメーカー (UI)
 *
 * The work is one plain object, `state` (see model.v1.js). Undo, autosave and project files are
 * all copies of it. Image bytes are not in it: they are Blobs in IndexedDB, keyed by image id.
 *
 *   change something  ->  touch()   redraw, save a little later
 *   finished changing ->  commit()  one step of undo (typing commits on `change`, not on every key)
 *
 * The ids scenes get in CCFOLIA (scene.ccfId) and state.orderBase are not part of undo: they must
 * stay what the last exported zip had, or "overwrite" would miss the scenes already imported.
 *
 * What CCFOLIA does with the zip is in roomdata.v1.js and model.v1.js (CCFOLIA 1.37.4, 2026-10-02;
 * the same in 1.37.6, checked 2026-10-30).
 *
 * Every text shown goes through t() (i18n.v1.js; the Japanese text is the key). Numbers and names
 * are filled in as {n} / {name}, never glued on, since word order differs between languages.
 * Sentences that are joined end with a space in the English and Korean dictionaries.
 */
(function () {
  "use strict";

  const R = window.CcfRoomData, M = window.SceneModel;
  const $ = sel => document.querySelector(sel);
  const t = (text, vars) => (window.I18n ? window.I18n.t(text, vars) : text);
  const listOf = parts => parts.join(t("、"));

  const SAVE_KEY = "ccf-scene-maker.state";
  const APP_ID = "ccf-scene-maker";
  const MAX_IMAGE = M.MAX_IMAGE;
  const MAX_HISTORY = 150;

  let state = M.defaultState();
  let selected = null;     // scene id
  let pendingPick = null;  // called with the ids of the files chosen through #imageFile
  const random = n => crypto.getRandomValues(new Uint8Array(n));

  function status(message, isError) {
    const el = $("#status");
    el.textContent = message;
    el.classList.toggle("error", !!isError);
  }
  function exportStatus(message, isError) {
    const el = $("#exportStatus");
    el.textContent = message;
    el.classList.toggle("error", !!isError);
  }

  // ---------------------------------------------------------------- undo and autosave

  let history = [], future = [];
  function syncUndo() {
    $("#undo").disabled = history.length < 2;
    $("#redo").disabled = future.length === 0;
  }
  function commit() {
    const snap = JSON.stringify(state);
    if (history[history.length - 1] === snap) return;
    history.push(snap);
    if (history.length > MAX_HISTORY + 1) history.shift();
    future = [];
    syncUndo();
  }
  function restore(snap) {
    const ccf = new Map(state.scenes.map(s => [s.id, s.ccfId]));
    const orderBase = state.orderBase;
    state = M.normalize(JSON.parse(snap));
    for (const s of state.scenes) if (ccf.has(s.id)) s.ccfId = ccf.get(s.id);
    state.orderBase = orderBase;
    ensureCcfIds();
    keepBlobsStored();
    touch();
  }
  function undo() {
    if (history.length < 2) return;
    future.push(history.pop());
    restore(history[history.length - 1]);
    syncUndo();
    status(t("元に戻しました。"));
  }
  function redo() {
    if (!future.length) return;
    const snap = future.pop();
    history.push(snap);
    restore(snap);
    syncUndo();
    status(t("やり直しました。"));
  }

  let saveTimer = 0;
  function saveNow() {
    clearTimeout(saveTimer);
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    } catch (err) {
      status(t("ブラウザに自動保存できませんでした。「プロジェクトを保存」でファイルに残してください。"), true);
    }
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }
  function loadSaved() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) state = M.normalize(JSON.parse(raw));
    } catch (err) { /* private mode or broken data: start fresh */ }
  }

  function ensureCcfIds() {
    const seen = new Set();
    for (const s of state.scenes) {
      if (!/^[A-Za-z0-9]{20}$/.test(s.ccfId) || seen.has(s.ccfId)) s.ccfId = R.newId(random);
      seen.add(s.ccfId);
    }
  }

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  function stamp() {
    const d = new Date(), p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }
  const safeName = s => String(s || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "_").trim() || t("画像");

  // ---------------------------------------------------------------- image bytes

  const DB_NAME = "ccf-scene-maker", DB_STORE = "images";
  const blobs = new Map();  // image id -> Blob (kept while the page is open, even after the image is removed, for undo)
  const srcs = new Map();   // image id -> object URL
  const stored = new Set(); // image ids whose Blob is in IndexedDB
  const shrunk = new Map(); // image id -> { blob, type, w, h } (the smaller copy made for export)
  let db = null;            // null when IndexedDB is unavailable: images then live only in memory

  function openDb() {
    return new Promise(resolve => {
      // file:// pages in some browsers never answer; give up rather than hang on "loading".
      const timer = setTimeout(() => resolve(null), 1500);
      const done = v => { clearTimeout(timer); resolve(v); };
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
        req.onsuccess = () => done(req.result);
        req.onerror = req.onblocked = () => done(null);
      } catch (err) { done(null); }
    });
  }
  function dbRun(mode, fn) {
    return new Promise((resolve, reject) => {
      if (!db) { reject(new Error("no IndexedDB")); return; }
      const tx = db.transaction(DB_STORE, mode);
      const req = fn(tx.objectStore(DB_STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("IndexedDB"));
    });
  }
  const warnNotStored = () => status(t("画像をブラウザに保存できませんでした。このページを閉じると消えるので、「プロジェクトを保存」でファイルに残してください。"), true);
  function storeBlob(id, blob) {
    if (!db) return Promise.resolve();
    return dbRun("readwrite", s => s.put(blob, id)).then(() => { stored.add(id); }).catch(warnNotStored);
  }
  function unstoreBlob(id) {
    stored.delete(id);
    if (db) dbRun("readwrite", s => s.delete(id)).catch(() => {});
  }
  function holdBlob(id, blob) {
    if (srcs.has(id)) URL.revokeObjectURL(srcs.get(id));
    blobs.set(id, blob);
    srcs.set(id, URL.createObjectURL(blob));
  }
  // After undo / redo / opening a project: IndexedDB should hold exactly the shelf's images.
  function keepBlobsStored() {
    const ids = new Set(state.images.map(im => im.id));
    for (const id of ids) if (!stored.has(id) && blobs.has(id)) storeBlob(id, blobs.get(id));
    for (const id of [...stored]) if (!ids.has(id)) unstoreBlob(id);
  }
  async function loadBlobs() {
    if (!db) return;
    const ids = new Set(state.images.map(im => im.id));
    let keys = [];
    try { keys = await dbRun("readonly", s => s.getAllKeys()); } catch (err) { return; }
    for (const key of keys) {
      if (!ids.has(key)) { dbRun("readwrite", s => s.delete(key)).catch(() => {}); continue; } // left over from a removed image
      try {
        const blob = await dbRun("readonly", s => s.get(key));
        if (blob) { holdBlob(key, blob); stored.add(key); }
      } catch (err) { /* shown as missing on the shelf */ }
    }
  }

  const u32 = (b, i) => (b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) >>> 0;
  const tag = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
  // Animated images lose their motion on a canvas, so they are never shrunk.
  function isMoving(type, b) {
    if (type === "image/gif") return true; // not worth telling a one-frame gif apart
    if (type === "image/png") {            // APNG: an acTL chunk before the first IDAT
      for (let p = 8; p + 8 <= b.length;) {
        const chunk = tag(b, p + 4);
        if (chunk === "acTL") return true;
        if (chunk === "IDAT") return false;
        p += 12 + u32(b, p);
      }
      return false;
    }
    if (type === "image/webp") return b.length > 21 && tag(b, 12) === "VP8X" && (b[20] & 0x02) !== 0;
    return false;
  }

  async function sizeOf(blob) {
    try {
      const bmp = await createImageBitmap(blob);
      const out = { w: bmp.width, h: bmp.height };
      bmp.close();
      return out;
    } catch (err) {
      return new Promise(resolve => {
        const img = new Image(), url = URL.createObjectURL(blob);
        img.onload = () => { URL.revokeObjectURL(url); resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
        img.onerror = () => { URL.revokeObjectURL(url); resolve({ w: 0, h: 0 }); };
        img.src = url;
      });
    }
  }

  // The file name without its extension becomes the image's name (state: kept as typed, never translated).
  const baseName = n => String(n || "").replace(/\.[^.]+$/, "") || t("画像");
  const blobToDataUrl = blob => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  function dataUrlBlob(dataUrl) {
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl || "");
    if (!m) throw new Error("bad data url");
    const raw = atob(m[2]), bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new Blob([bytes], { type: m[1] });
  }

  // Put files on the shelf. -> their ids, in order (a file already there gives the existing id).
  async function addFiles(files) {
    const ids = [];
    let bad = 0, big = 0, bigMoving = 0, same = 0;
    for (const file of Array.from(files || [])) {
      if (!R.EXT[file.type]) { bad++; continue; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = R.hex(await crypto.subtle.digest("SHA-256", bytes));
      const had = state.images.find(im => im.hash === hash && blobs.has(im.id));
      if (had) { ids.push(had.id); same++; continue; }
      const { w, h } = await sizeOf(file);
      if (!w || !h) { bad++; continue; }
      const im = { id: M.uid("i"), name: baseName(file.name), type: file.type, size: file.size, hash, w, h, moving: isMoving(file.type, bytes) };
      holdBlob(im.id, file);
      state.images.push(im);
      ids.push(im.id);
      if (file.size > MAX_IMAGE) { if (im.moving) bigMoving++; else big++; }
      await storeBlob(im.id, file);
    }
    const added = ids.length - same;
    const parts = [];
    if (added) parts.push(t("画像を {n} 枚、置き場に入れました。", { n: added }));
    if (added && !db) parts.push(t("ただし、このブラウザでは画像を保存できないので、閉じる前に「プロジェクトを保存」でファイルに残してください。"));
    if (same) parts.push(t("{n} 枚は置き場にある画像と同じなので、それを使います。", { n: same }));
    if (bad) parts.push(t("{n} 個は使えない形式でした（PNG・JPEG・GIF・WebP が使えます）。", { n: bad }));
    if (big) parts.push(t("{n} 枚は 5MB を超えています。書き出すときに縮小できます。", { n: big }));
    if (bigMoving) parts.push(t("動く画像 {n} 枚が 5MB を超えています。縮小できないので、作ったツールで軽くしてください。", { n: bigMoving }));
    if (parts.length) status(parts.join(""), !!(bad || bigMoving || (added && !db)));
    return ids;
  }

  const imageById = id => id ? state.images.find(im => im.id === id) || null : null;
  const sceneById = id => state.scenes.find(s => s.id === id) || null;
  const srcOf = id => srcs.get(id) || "";
  const sizeText = n => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
  const tooBig = im => !!(im && im.size > MAX_IMAGE);
  const missing = im => !!(im && !blobs.has(im.id));
  const fgOf = scene => imageById(M.fgIdOf(state, scene));
  const bgOf = scene => imageById(scene.bg);

  function usesOf(id) {
    return {
      bg: state.scenes.filter(s => s.bg === id).length,
      fg: state.scenes.filter(s => s.fg === id).length,
      common: state.commonFg === id,
    };
  }
  const isUsed = id => state.scenes.some(s => s.bg === id || M.fgIdOf(state, s) === id);

  // ---------------------------------------------------------------- shrinking for export

  const canvasBlob = (canvas, type, q) => new Promise(resolve => canvas.toBlob(resolve, type, q));

  // A copy of a still image under 5 MB, as close to the original as fits. -> { blob, type, w, h }
  async function shrink(im) {
    if (shrunk.has(im.id)) return shrunk.get(im.id);
    const bmp = await createImageBitmap(blobs.get(im.id));
    const limit = MAX_IMAGE * 0.98;
    const lossy = im.type === "image/jpeg" || im.type === "image/webp";
    const canvas = document.createElement("canvas");
    const encode = async (scale, q) => {
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      // A browser that cannot write the type gives PNG instead; its own type is then what counts.
      return canvasBlob(canvas, lossy ? im.type : "image/png", q);
    };
    try {
      const tries = lossy ? [[1, 0.9], [1, 0.8]] : [];
      // PNG size follows the pixel count roughly; start near the target and step down.
      for (let s = Math.min(0.92, Math.sqrt(limit / im.size)); tries.length < 16; s *= 0.86) tries.push([s, 0.85]);
      for (const [scale, q] of tries) {
        const blob = await encode(scale, q);
        if (blob && blob.size <= limit && R.EXT[blob.type]) {
          const out = { blob, type: blob.type, w: canvas.width, h: canvas.height };
          shrunk.set(im.id, out);
          return out;
        }
      }
      throw new Error(t("「{name}」を 5MB 以下に縮小できませんでした。", { name: im.name }));
    } finally { bmp.close(); }
  }

  // ---------------------------------------------------------------- small builders

  function button(label, extra) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "small" + (extra && extra.danger ? " danger" : "");
    b.textContent = label;
    if (extra && extra.disabled) b.disabled = true;
    if (extra && extra.aria) b.setAttribute("aria-label", extra.aria);
    return b;
  }
  const hasFiles = ev => !!(ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes("Files"));
  // Dropping image files on el puts them on the shelf, then hands the ids to take.
  function dropTarget(el, take) {
    el.addEventListener("dragover", ev => { if (!hasFiles(ev)) return; ev.preventDefault(); el.classList.add("over"); });
    el.addEventListener("dragleave", () => el.classList.remove("over"));
    el.addEventListener("drop", ev => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      el.classList.remove("over");
      addFiles(ev.dataTransfer.files).then(take);
    });
  }
  function pickFile(assign) {
    pendingPick = assign;
    $("#imageFile").click();
  }
  function fillImageSelect(sel, firsts, current) {
    sel.textContent = "";
    for (const [value, label] of firsts) sel.append(new Option(label, value));
    for (const im of state.images) sel.append(new Option(im.name || t("（名前なし）"), im.id));
    sel.value = current;
    if (sel.value !== current) sel.value = firsts[0][0];
  }

  // ---------------------------------------------------------------- scenes

  function addScenes(imageIds) {
    const made = [];
    for (const id of imageIds) {
      const sc = M.newScene(state, imageById(id), R.newId(random));
      state.scenes.push(sc);
      made.push(sc);
    }
    if (made.length) selected = made[0].id;
    return made.length;
  }
  function fitSize(scene) {
    const bg = bgOf(scene) || fgOf(scene);
    if (!bg) return false;
    const size = M.suggestSize(bg.w, bg.h, state.defaults.longSide);
    scene.width = size.width;
    scene.height = size.height;
    scene.sizeAuto = true;
    return true;
  }

  function removeImage(im) {
    const u = usesOf(im.id);
    const uses = [];
    if (u.bg) uses.push(t("背景に使っているシーン {n} 件", { n: u.bg }));
    if (u.fg) uses.push(t("前景に使っているシーン {n} 件", { n: u.fg }));
    if (u.common) uses.push(t("共通の前景"));
    if (uses.length && !confirm(t("「{name}」は次の所で使っています。\n{uses}\n\n削除すると、これらは「画像なし」になります。削除しますか？", { name: im.name, uses: uses.join("\n") }))) return;
    for (const s of state.scenes) {
      if (s.bg === im.id) s.bg = null;
      if (s.fg === im.id) s.fg = "none";
    }
    if (state.commonFg === im.id) state.commonFg = null;
    state.images = state.images.filter(x => x !== im);
    unstoreBlob(im.id); // the Blob stays in memory, so undo can bring the image back
    touch();
    commit();
    status(uses.length ? t("削除しました。使っていた所は「画像なし」になりました。") : t("削除しました。"));
  }

  // ---------------------------------------------------------------- rendering

  function renderGallery() {
    const box = $("#gallery");
    box.textContent = "";
    $("#imageCount").textContent = state.images.length;
    if (!state.images.length) {
      const p = document.createElement("p");
      p.className = "desc";
      p.textContent = t("まだ画像がありません。");
      box.append(p);
      return;
    }
    for (const im of state.images) {
      const cell = document.createElement("div");
      cell.className = "imgcell";
      const src = srcOf(im.id);
      if (src) { const img = document.createElement("img"); img.src = src; img.alt = ""; img.loading = "lazy"; cell.append(img); }
      else { const d = document.createElement("div"); d.className = "noimg"; d.textContent = t("中身なし"); cell.append(d); }
      const name = document.createElement("input");
      name.type = "text";
      name.value = im.name;
      name.setAttribute("aria-label", t("画像の名前"));
      name.addEventListener("input", () => { im.name = name.value; touch({ keepGallery: true, keepEditorFields: true }); });
      name.addEventListener("change", commit);
      const info = document.createElement("span");
      const warn = missing(im) || tooBig(im);
      info.className = "info" + (warn ? " warn" : "");
      const facts = [`${im.w}×${im.h}`, sizeText(im.size)];
      if (im.moving) facts.push(t("動く"));
      info.textContent = missing(im) ? t("中身が見つかりません。入れ直してください")
        : facts.join(t("・")) + (tooBig(im) ? (im.moving ? t("（5MB 超・縮小不可）") : t("（5MB 超）")) : "");
      const btns = document.createElement("div");
      btns.className = "btns";
      const make = button(t("シーンに"), { aria: t("画像「{name}」を背景にしたシーンを足す", { name: im.name }) });
      make.addEventListener("click", () => { addScenes([im.id]); touch(); commit(); status(t("シーンを 1 件足しました。")); });
      const del = button(t("削除"), { danger: true, aria: t("画像「{name}」を削除", { name: im.name }) });
      del.addEventListener("click", () => removeImage(im));
      btns.append(make, del);
      cell.append(name, info, btns);
      box.append(cell);
    }
  }

  function renderCommon() {
    fillImageSelect($("#commonFg"), [["", t("なし")]], state.commonFg || "");
    $("#defLongSide").value = state.defaults.longSide;
    $("#defGrid").checked = state.defaults.displayGrid;
    $("#defGridSize").value = state.defaults.gridSize;
    $("#defFit").value = state.defaults.fit;
    const none = state.scenes.length === 0;
    for (const id of ["allFgCommon", "allSize", "allGrid", "allFit", "namesFromFiles"]) $("#" + id).disabled = none;
  }

  let dragId = null;
  function renderList() {
    const box = $("#sceneList");
    box.textContent = "";
    $("#count").textContent = state.scenes.length;
    if (!state.scenes.length) {
      const d = document.createElement("div");
      d.className = "empty-list";
      d.textContent = t("まだシーンがありません");
      box.append(d);
    }
    state.scenes.forEach((sc, i) => {
      const row = document.createElement("div");
      row.className = "scene";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(sc.id === selected));
      row.tabIndex = 0;
      row.draggable = true;
      const pic = document.createElement("div");
      pic.className = "pic";
      // CCFOLIA shows foregroundUrl || backgroundUrl; with a shared frame every scene would look
      // the same here, so the background is drawn under it.
      const layers = [fgOf(sc), bgOf(sc)].filter(im => im && srcOf(im.id)).map(im => `url("${srcOf(im.id)}")`);
      if (layers.length) pic.style.backgroundImage = layers.join(", ");
      const txt = document.createElement("div");
      txt.className = "txt";
      const ttl = document.createElement("span");
      ttl.className = "ttl";
      ttl.textContent = sc.name || t("新しいシーン"); // what CCFOLIA shows for a scene without a title
      const cap = document.createElement("span");
      cap.className = "cap";
      cap.textContent = "-"; // the BGM name; always none here
      txt.append(ttl, cap);
      const mv = document.createElement("div");
      mv.className = "mv";
      const up = button("↑", { disabled: i === 0, aria: t("{n} 番目を上へ", { n: i + 1 }) });
      const down = button("↓", { disabled: i === state.scenes.length - 1, aria: t("{n} 番目を下へ", { n: i + 1 }) });
      up.className = down.className = "";
      up.addEventListener("click", ev => { ev.stopPropagation(); moveScene(i, i - 1); });
      down.addEventListener("click", ev => { ev.stopPropagation(); moveScene(i, i + 1); });
      mv.append(up, down);
      row.append(pic, txt, mv);
      const pick = () => { selected = sc.id; touch({ keepGallery: true }); };
      row.addEventListener("click", pick);
      row.addEventListener("keydown", ev => { if (ev.target === row && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); pick(); } });
      row.addEventListener("dragstart", ev => { dragId = sc.id; ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", sc.name); });
      row.addEventListener("dragend", () => { dragId = null; });
      row.addEventListener("dragover", ev => { if (!dragId || dragId === sc.id) return; ev.preventDefault(); row.classList.add("over"); });
      row.addEventListener("dragleave", () => row.classList.remove("over"));
      row.addEventListener("drop", ev => {
        if (!dragId) return;
        ev.preventDefault();
        const from = state.scenes.findIndex(s => s.id === dragId);
        dragId = null;
        if (from >= 0) moveScene(from, i);
      });
      box.append(row);
    });
  }

  function moveScene(from, to) {
    if (to < 0 || to >= state.scenes.length || from === to) return;
    const [sc] = state.scenes.splice(from, 1);
    state.scenes.splice(to, 0, sc);
    touch({ keepGallery: true });
    commit();
  }

  function renderBoard() {
    const sc = sceneById(selected);
    const board = $("#board");
    board.textContent = "";
    if (!sc) return;
    const stage = $("#stage");
    const availW = Math.max(40, stage.clientWidth - 24), availH = Math.max(40, stage.clientHeight - 24);
    const scale = Math.min(availW / (sc.width * M.CELL), availH / (sc.height * M.CELL));
    const w = sc.width * M.CELL * scale, h = sc.height * M.CELL * scale;
    board.style.width = w + "px";
    board.style.height = h + "px";
    const bg = bgOf(sc), fg = fgOf(sc);
    // CCFOLIA stacks two imgs of the field's size, both with object-fit = fieldObjectFit.
    for (const im of [bg, fg]) {
      if (!im || !srcOf(im.id)) continue;
      const img = document.createElement("img");
      img.src = srcOf(im.id);
      img.alt = "";
      img.draggable = false;
      img.style.objectFit = sc.fit;
      board.append(img);
    }
    if (!bg && !fg) {
      const d = document.createElement("div");
      d.className = "blank";
      d.textContent = t("画像なし");
      board.append(d);
    }
    if (sc.displayGrid) {
      const g = document.createElement("div");
      g.className = "grid";
      const step = M.CELL * sc.gridSize * scale;
      g.style.backgroundImage = "linear-gradient(rgba(255,255,255,.25) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.25) 1px, transparent 1px)";
      g.style.backgroundSize = `${step}px ${step}px`;
      board.append(g);
    }
    const ratio = im => im && im.w && im.h ? Math.abs(im.w / im.h - sc.width / sc.height) / (sc.width / sc.height) : 0;
    const off = [];
    if (ratio(bg) > 0.05) off.push(t("背景"));
    if (ratio(fg) > 0.05) off.push(t("前景"));
    const parts = off.join(t("・"));
    $("#stageNote").textContent = t("盤面 {w} × {h} マス（{pw} × {ph}px）。", { w: sc.width, h: sc.height, pw: sc.width * M.CELL, ph: sc.height * M.CELL })
      + (!off.length ? "" : sc.fit === "cover" ? t("{parts}の形がフィールドと違うので、はみ出しが切れます。", { parts })
        : t("{parts}の形がフィールドと違うので、伸びて表示されます。", { parts }));
  }

  function renderEditor(keepFields) {
    const sc = sceneById(selected);
    $("#editor").hidden = !sc;
    $("#editorEmpty").hidden = !!sc;
    if (!sc) return;
    if (!keepFields) {
      $("#edName").value = sc.name;
      $("#edText").value = sc.text;
      $("#edWidth").value = sc.width;
      $("#edHeight").value = sc.height;
      $("#edGridSize").value = sc.gridSize;
    }
    $("#edFit").value = sc.fit;
    $("#edGrid").checked = sc.displayGrid;
    fillImageSelect($("#edBg"), [["", t("画像なし")]], sc.bg || "");
    const common = imageById(state.commonFg);
    fillImageSelect($("#edFg"), [["common", t("共通の前景（{name}）", { name: common ? common.name : t("なし") })], ["none", t("前景なし")]], sc.fg);
    const warns = [];
    for (const im of new Set([bgOf(sc), fgOf(sc)])) {
      if (!im) continue;
      const vars = { name: im.name, size: sizeText(im.size) };
      if (missing(im)) warns.push(t("「{name}」の中身が見つかりません。置き場で入れ直してください。", vars));
      else if (tooBig(im)) warns.push(im.moving
        ? t("「{name}」は動く画像で {size}。5MB を超えていて縮小できないので、ココフォリアに上がらないことがあります。", vars)
        : t("「{name}」は {size}。", vars) + (state.exportOpts.shrink ? t("書き出すときに 5MB 以下に縮小します。") : t("5MB を超えているので、ココフォリアに上がらないことがあります。")));
    }
    $("#edWarn").hidden = !warns.length;
    $("#edWarn").textContent = warns.join(" ");
    renderBoard();
  }

  function renderExport() {
    for (const el of document.querySelectorAll('input[name="exportMode"]')) el.checked = el.value === state.exportOpts.mode;
    $("#optShrink").checked = state.exportOpts.shrink;
    const used = state.images.filter(im => isUsed(im.id));
    const big = used.filter(im => tooBig(im) && !im.moving), bigMoving = used.filter(im => tooBig(im) && im.moving);
    const el = $("#exportSummary");
    el.textContent = "";
    const add = (text, cls) => { const s = document.createElement("span"); if (cls) s.className = cls; s.textContent = text; el.append(s); };
    const tooMany = state.scenes.length > M.MAX_SCENES;
    if (!state.scenes.length) add(t("書き出すシーンがまだありません。"));
    else if (tooMany) add(t("シーンが {n} 件あります。ココフォリアは 1 回の読み込みで {max} 件までしか書き込めないことがあるので、1 つの ZIP は {max} 件までにしてください（「プロジェクトを保存」で控えを取ってから、シーンを減らして分けて書き出せます）。", { n: state.scenes.length, max: M.MAX_SCENES }), "warn");
    else {
      add(t("シーン {n} 件・画像 {m} 枚を書き出します。", { n: state.scenes.length, m: used.length }));
      if (big.length) add(state.exportOpts.shrink ? t("5MB を超える静止画 {n} 枚は縮小します。", { n: big.length }) : t("5MB を超える静止画が {n} 枚あります（ココフォリアに上がらないことがあります）。", { n: big.length }), state.exportOpts.shrink ? "" : "warn");
      if (bigMoving.length) add(t("5MB を超える動く画像が {n} 枚あります（{names}）。縮小できないので、ココフォリアに上がらないことがあります。", { n: bigMoving.length, names: listOf(bigMoving.map(im => im.name)) }), "warn");
    }
    $("#exportZip").disabled = state.scenes.length === 0 || tooMany;
    $("#exportAssets").disabled = state.images.length === 0;
  }

  // keepGallery: the shelf did not change. keepEditorFields: the user is typing in the editor.
  function touch(o) {
    if (selected && !sceneById(selected)) selected = null;
    if (!selected && state.scenes.length) selected = state.scenes[0].id;
    if (!(o && o.keepGallery)) renderGallery();
    renderCommon();
    renderList();
    renderEditor(!!(o && o.keepEditorFields));
    renderExport();
    scheduleSave();
  }

  // ---------------------------------------------------------------- export

  // The bytes an image goes out with: the original, or the shrunk copy when asked and needed.
  async function prepared(im, cache) {
    if (cache.has(im.id)) return cache.get(im.id);
    const blob = blobs.get(im.id);
    if (!blob) throw new Error(t("画像「{name}」の中身が見つかりません。置き場で入れ直すか、使っているシーンの画像を変えてください。", { name: im.name }));
    let out = { type: im.type, blob, small: false };
    if (state.exportOpts.shrink && tooBig(im) && !im.moving) {
      const s = await shrink(im);
      out = { type: s.type, blob: s.blob, small: true, w: s.w, h: s.h };
    }
    out.bytes = new Uint8Array(await out.blob.arrayBuffer());
    cache.set(im.id, out);
    return out;
  }

  function canExport() {
    if (!window.JSZip) { exportStatus(t("ZIP を作る部品を読み込めませんでした。ネットにつながった状態で開き直してください。"), true); return false; }
    if (!(window.crypto && crypto.subtle)) { exportStatus(t("このブラウザでは ZIP を作れません（https のページか、新しい Chrome・Edge で開いてください）。"), true); return false; }
    return true;
  }

  async function exportZip() {
    if (!state.scenes.length || state.scenes.length > M.MAX_SCENES || !canExport()) return;
    const btn = $("#exportZip");
    btn.disabled = true;
    exportStatus(t("ZIP を作っています…"));
    try {
      const cache = new Map();
      const file = async im => { if (!im) return null; const p = await prepared(im, cache); return R.image(p.type, p.bytes, im.id); };
      const adding = state.exportOpts.mode !== "overwrite";
      if (adding) {
        // New ids, so this zip adds scenes. They are kept: a later "overwrite" zip replaces these.
        for (const sc of state.scenes) sc.ccfId = R.newId(random);
        state.orderBase = Math.floor(Date.now() / 1000); // seconds since 1970: after the scenes already in the room
      } else {
        ensureCcfIds();
        if (!state.orderBase) state.orderBase = Math.floor(Date.now() / 1000);
      }
      const scenes = {};
      for (let i = 0; i < state.scenes.length; i++) {
        const sc = state.scenes[i];
        scenes[sc.ccfId] = M.toEntity(sc, await file(bgOf(sc)), await file(fgOf(sc)), state.orderBase + i);
      }
      const { zip, files } = await R.build({ scenes }, { JSZip: window.JSZip, subtle: crypto.subtle });
      // Images are already compressed; storing them keeps the export quick.
      const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
      download(blob, `scenes-${stamp()}.zip`);
      saveNow();
      const all = [...cache.values()];
      const small = all.filter(p => p.small).length, over = all.filter(p => p.bytes.length > MAX_IMAGE).length;
      exportStatus(t("書き出しました（シーン {n} 件・画像 {m} 枚・{size}）。", { n: state.scenes.length, m: files.length, size: sizeText(blob.size) })
        + (adding ? t("ココフォリアのルーム設定からインポートすると、シーン一覧の最後に追加されます。") : t("インポートすると、前に入れたシーンが置き換わります。"))
        + (small ? t("{n} 枚は 5MB 以下に縮小しました。", { n: small }) : "")
        + (over ? t("5MB を超える画像が {n} 枚あり、ココフォリアに上がらないことがあります。", { n: over }) : ""), over > 0);
    } catch (err) {
      console.error(err);
      exportStatus(t("ZIP を作れませんでした: {error}", { error: err.message }), true);
    } finally {
      btn.disabled = state.scenes.length === 0 || state.scenes.length > M.MAX_SCENES;
    }
  }

  // The images as plain files with readable names, to drop into CCFOLIA's own image picker.
  async function exportAssets() {
    if (!state.images.length || !canExport()) return;
    const btn = $("#exportAssets");
    btn.disabled = true;
    exportStatus(t("素材の ZIP を作っています…"));
    try {
      const cache = new Map();
      const zip = new window.JSZip();
      const taken = new Set();
      let count = 0;
      const put = async (dir, im) => {
        const p = await prepared(im, cache);
        const ext = R.EXT[p.type] === "jpeg" ? "jpg" : R.EXT[p.type];
        let name = `${dir}/${safeName(im.name)}.${ext}`;
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${dir}/${safeName(im.name)} (${n}).${ext}`;
        taken.add(name.toLowerCase());
        zip.file(name, p.bytes);
        count++;
      };
      let skipped = 0;
      for (const im of state.images) {
        if (missing(im)) { skipped++; continue; }
        const asBg = state.scenes.some(s => s.bg === im.id), asFg = state.scenes.some(s => M.fgIdOf(state, s) === im.id);
        // Folder names in the language of the page, like the rest of what the user reads.
        if (asBg) await put(t("背景"), im);
        if (asFg) await put(t("前景"), im);
        if (!asBg && !asFg) await put(t("そのほか"), im);
      }
      const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
      download(blob, `scenes-assets-${stamp()}.zip`);
      const small = [...cache.values()].filter(p => p.small).length;
      exportStatus(t("素材を書き出しました（{n} 枚・{size}）。展開して、ココフォリアの画像選択の画面にドロップすると、自分の素材に入ります。", { n: count, size: sizeText(blob.size) })
        + (small ? t("{n} 枚は縮小後の画像です。", { n: small }) : "") + (skipped ? t("中身の見つからない画像 {n} 枚は入っていません。", { n: skipped }) : ""), skipped > 0);
    } catch (err) {
      console.error(err);
      exportStatus(t("素材の ZIP を作れませんでした: {error}", { error: err.message }), true);
    } finally {
      btn.disabled = state.images.length === 0;
    }
  }

  // ---------------------------------------------------------------- project files

  async function projectData() {
    const assets = {};
    for (const im of state.images) {
      const blob = blobs.get(im.id);
      if (blob) assets[im.id] = await blobToDataUrl(blob);
    }
    return { app: APP_ID, version: 1, state, assets };
  }

  async function openProject(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch (err) { status(t("プロジェクトファイルを読めませんでした。"), true); return; }
    if (!data || data.app !== APP_ID) { status(t("このツールのプロジェクトファイルではありません。"), true); return; }
    const next = M.normalize(data.state);
    for (const im of next.images) {
      const url = data.assets && data.assets[im.id];
      if (!url) continue;
      try { holdBlob(im.id, dataUrlBlob(url)); stored.delete(im.id); } catch (err) { /* shown as missing */ }
    }
    state = next;
    ensureCcfIds();
    keepBlobsStored();
    selected = null;
    touch();
    commit();
    saveNow();
    status(t("プロジェクトを開きました（シーン {n} 件・画像 {m} 枚）。", { n: state.scenes.length, m: state.images.length }));
  }

  // ---------------------------------------------------------------- wiring

  const numberOf = (el, d) => M.clampInt(el.value, 1, M.MAX_CELLS, d);

  function wireShelf() {
    const zone = (dropSel, inputSel, take) => {
      const drop = $(dropSel), input = $(inputSel);
      drop.addEventListener("click", () => input.click());
      drop.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); input.click(); } });
      dropTarget(drop, take);
      input.addEventListener("change", () => { const files = Array.from(input.files); input.value = ""; addFiles(files).then(take); });
    };
    zone("#dropScenes", "#sceneFiles", ids => {
      if (!ids.length) return;
      const n = addScenes(ids);
      touch();
      commit();
      if (!$("#status").classList.contains("error")) status($("#status").textContent + t("シーンを {n} 件作りました。", { n }));
    });
    zone("#dropShelf", "#shelfFiles", ids => {
      if (!ids.length) return;
      // The first frame dropped becomes the shared foreground if there is none yet.
      if (!state.commonFg) { state.commonFg = ids[0]; status($("#status").textContent + t("共通の前景にしました。"), $("#status").classList.contains("error")); }
      touch();
      commit();
    });
    $("#imageFile").addEventListener("change", ev => {
      const files = Array.from(ev.target.files), take = pendingPick;
      ev.target.value = "";
      pendingPick = null;
      addFiles(files).then(ids => { if (take && ids.length) take(ids); touch(); commit(); });
    });
    // A file dropped outside a drop area would make the browser leave the page to show it.
    window.addEventListener("dragover", ev => { if (hasFiles(ev)) ev.preventDefault(); });
    window.addEventListener("drop", ev => { if (hasFiles(ev) && !ev.defaultPrevented) { ev.preventDefault(); status(t("画像は「1. 背景の画像を入れる」の枠にドロップしてください。"), true); } });
  }

  function wireCommon() {
    const each = fn => { state.scenes.forEach(fn); touch({ keepGallery: true }); commit(); };
    $("#commonFg").addEventListener("change", ev => { state.commonFg = ev.target.value || null; touch({ keepGallery: true }); commit(); });
    $("#commonFgAdd").addEventListener("click", () => pickFile(ids => { state.commonFg = ids[0]; }));
    $("#allFgCommon").addEventListener("click", () => { each(s => { s.fg = "common"; }); status(t("全シーンの前景を「共通の前景」にしました。")); });
    $("#defLongSide").addEventListener("change", ev => { state.defaults.longSide = numberOf(ev.target, 48); touch({ keepGallery: true }); commit(); });
    $("#allSize").addEventListener("click", () => {
      let n = 0;
      each(s => { if (fitSize(s)) n++; });
      status(t("{n} 件のシーンを、背景の形に合わせました（長い辺 {side} マス）。", { n, side: state.defaults.longSide }));
    });
    $("#defGrid").addEventListener("change", ev => { state.defaults.displayGrid = ev.target.checked; touch({ keepGallery: true }); commit(); });
    $("#defGridSize").addEventListener("change", ev => { state.defaults.gridSize = numberOf(ev.target, 1); touch({ keepGallery: true }); commit(); });
    $("#allGrid").addEventListener("click", () => {
      each(s => { s.displayGrid = state.defaults.displayGrid; s.gridSize = state.defaults.gridSize; });
      status(state.defaults.displayGrid ? t("全シーンのグリッドを表示にしました（間隔 {n} マス）。", { n: state.defaults.gridSize }) : t("全シーンのグリッドを消しました。"));
    });
    $("#defFit").addEventListener("change", ev => { state.defaults.fit = ev.target.value; touch({ keepGallery: true }); commit(); });
    $("#allFit").addEventListener("click", () => { each(s => { s.fit = state.defaults.fit; }); status(t("全シーンの画像のはめ方をそろえました。")); });
    $("#namesFromFiles").addEventListener("click", () => {
      each(s => { const bg = bgOf(s); if (bg) s.name = bg.name; });
      status(t("シーンタイトルを、背景の画像の名前にそろえました。"));
    });
    $("#addEmpty").addEventListener("click", () => {
      const sc = M.newScene(state, null, R.newId(random));
      state.scenes.push(sc);
      selected = sc.id;
      touch({ keepGallery: true });
      commit();
    });
  }

  function wireEditor() {
    const cur = () => sceneById(selected);
    const typing = (sel, set) => {
      $(sel).addEventListener("input", ev => { const s = cur(); if (!s) return; set(s, ev.target.value); touch({ keepGallery: true, keepEditorFields: true }); });
      $(sel).addEventListener("change", commit);
    };
    const chosen = (sel, set) => $(sel).addEventListener("change", ev => { const s = cur(); if (!s) return; set(s, ev.target); touch({ keepGallery: true }); commit(); });
    typing("#edName", (s, v) => { s.name = v; });
    typing("#edText", (s, v) => { s.text = v; });
    // Numbers only on change: "108" should not pass through "1" on the way.
    chosen("#edWidth", (s, el) => { s.width = numberOf(el, s.width); s.sizeAuto = false; });
    chosen("#edHeight", (s, el) => { s.height = numberOf(el, s.height); s.sizeAuto = false; });
    chosen("#edGridSize", (s, el) => { s.gridSize = numberOf(el, s.gridSize); });
    chosen("#edGrid", (s, el) => { s.displayGrid = el.checked; });
    chosen("#edFit", (s, el) => { s.fit = el.value; });
    const setBg = (s, id) => { s.bg = id; if (s.sizeAuto) fitSize(s); };
    chosen("#edBg", (s, el) => setBg(s, el.value || null));
    chosen("#edFg", (s, el) => { s.fg = el.value; });
    $("#edBgAdd").addEventListener("click", () => { const s = cur(); if (s) pickFile(ids => setBg(s, ids[0])); });
    $("#edFgAdd").addEventListener("click", () => { const s = cur(); if (s) pickFile(ids => { s.fg = ids[0]; }); });
    $("#edSizeAuto").addEventListener("click", () => {
      const s = cur();
      if (!s) return;
      if (!fitSize(s)) { status(t("背景の画像がないので、合わせられません。"), true); return; }
      touch({ keepGallery: true });
      commit();
    });
    $("#edDup").addEventListener("click", () => {
      const s = cur();
      if (!s) return;
      const copy = Object.assign({}, s, { id: M.uid("s"), ccfId: R.newId(random), name: s.name ? t("{name} のコピー", { name: s.name }) : "" });
      state.scenes.splice(state.scenes.indexOf(s) + 1, 0, copy);
      selected = copy.id;
      touch({ keepGallery: true });
      commit();
    });
    $("#edDelete").addEventListener("click", () => {
      const s = cur();
      if (!s) return;
      const i = state.scenes.indexOf(s);
      state.scenes.splice(i, 1);
      selected = (state.scenes[i] || state.scenes[i - 1] || {}).id || null;
      touch({ keepGallery: true });
      commit();
      status(t("シーンを削除しました（置き場の画像は残ります）。「元に戻す」で戻せます。"));
    });
    dropTarget($("#stage"), ids => { const s = cur(); if (s && ids.length) { setBg(s, ids[0]); touch(); commit(); } });
  }

  function wireRest() {
    for (const el of document.querySelectorAll('input[name="exportMode"]')) {
      el.addEventListener("change", () => { if (el.checked) { state.exportOpts.mode = el.value; touch({ keepGallery: true }); commit(); } });
    }
    $("#optShrink").addEventListener("change", ev => { state.exportOpts.shrink = ev.target.checked; touch({ keepGallery: true }); commit(); });
    $("#exportZip").addEventListener("click", exportZip);
    $("#exportAssets").addEventListener("click", exportAssets);

    $("#undo").addEventListener("click", undo);
    $("#redo").addEventListener("click", redo);
    window.addEventListener("keydown", ev => {
      if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
      const k = ev.key.toLowerCase();
      if (k !== "z" && k !== "y") return;
      // Text and number fields keep the browser's own undo.
      const target = ev.target;
      if (target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && /^(text|number|url|search)$/.test(target.type))) return;
      ev.preventDefault();
      if (k === "y" || ev.shiftKey) redo(); else undo();
    });

    $("#saveProject").addEventListener("click", async () => {
      try {
        download(new Blob([JSON.stringify(await projectData())], { type: "application/json" }), `scenes-${stamp()}.scene.json`);
        status(t("プロジェクトを保存しました（置き場の画像も入っています）。"));
      } catch (err) {
        status(t("プロジェクトを保存できませんでした: {error}", { error: err.message }), true);
      }
    });
    $("#loadProject").addEventListener("click", () => $("#projectFile").click());
    $("#projectFile").addEventListener("change", ev => {
      const file = ev.target.files[0];
      ev.target.value = "";
      if (file) openProject(file);
    });
    $("#resetAll").addEventListener("click", () => {
      if (!confirm(t("いまの作業内容を消して、最初の状態に戻します。よろしいですか？"))) return;
      state = M.defaultState();
      selected = null;
      keepBlobsStored();
      touch();
      commit();
      status(t("最初の状態に戻しました。「元に戻す」で戻せます。"));
    });
    let resizeTimer = 0;
    window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderBoard, 100); });
  }

  async function init() {
    loadSaved();
    ensureCcfIds();
    wireShelf();
    wireCommon();
    wireEditor();
    wireRest();
    touch();
    db = await openDb();
    await loadBlobs();
    if (!db) status(t("このブラウザでは画像を保存できません。画像を入れたら「プロジェクトを保存」でファイルに残してください。"), true);
    touch();
    commit();
  }

  init();
})();
