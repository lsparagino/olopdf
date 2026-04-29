// ============================================================
// PDF Editor — renderer logic
// ============================================================
const path = require('path');
const fs = require('fs');
const { ipcRenderer, webFrame, shell } = require('electron');

// Lock the renderer's own zoom so Ctrl+wheel / Ctrl+= / pinch never zoom the chrome.
// All zooming below acts on the PDF canvas only.
try {
  webFrame.setZoomFactor(1);
  webFrame.setVisualZoomLevelLimits(1, 1);
} catch (_) {}

const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const { PDFDocument, StandardFonts, rgb, PDFName, PDFString, PDFArray, PDFNumber } = require('pdf-lib');

// pdf.js worker — load worker as a Blob URL so it works in dev and packaged asar
(function setupWorker() {
  try {
    const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.js');
    const code = fs.readFileSync(workerPath, 'utf-8');
    const blob = new Blob([code], { type: 'application/javascript' });
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
  } catch (e) {
    console.error('Failed to set up pdf.js worker', e);
  }
})();

// ============================================================
// State
// ============================================================
const state = {
  filePath: null,
  pdfBytes: null,
  pdfjsDoc: null,
  pageOrder: [],
  bookmarks: [],          // [{ title, pageOriginalIdx, x?, y? }]   x,y in PDF user-space, top-left origin
  textAnnotations: [],    // per-page: [{ pageOriginalIdx, x, y, text, size, color }]
  repeatTexts: [],        // applied to every page: [{ x, y, text, size, color }]
  currentPage: 0,
  zoom: 1.0,
  fitMode: true,
  thumbCache: new Map(),
  renderTask: null,
  textLayerTask: null,
  pendingTextPlacement: null,   // { text, size, color, repeat }
  capturedSelection: null,      // { text, x, y, pageOriginalIdx } | null
  gridMode: false,
  mergeFiles: []
};

// ============================================================
// Helpers
// ============================================================
const $ = (id) => document.getElementById(id);

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
  if (id === 'welcome') renderRecents();
}

function showLoading(text = 'Working...') {
  $('loadingText').textContent = text;
  $('loading').classList.add('open');
}
function hideLoading() { $('loading').classList.remove('open'); }

let toastTimer = null;
function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (kind ? ' ' + kind : '');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); }, 2400);
}

function openModal(id) { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }

function hexToRgb01(hex) {
  const m = /^#?([a-f0-9]{6})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: ((n >> 16) & 0xff) / 255, g: ((n >> 8) & 0xff) / 255, b: (n & 0xff) / 255 };
}

// ============================================================
// Window controls
// ============================================================
$('winMin').addEventListener('click', () => ipcRenderer.send('win:min'));
$('winMax').addEventListener('click', () => ipcRenderer.send('win:max'));
$('winClose').addEventListener('click', () => ipcRenderer.send('win:close'));

// ============================================================
// Welcome
// ============================================================
$('openBtn').addEventListener('click', pickAndOpenPdf);
$('mergeBtn').addEventListener('click', () => {
  state.mergeFiles = [];
  renderMergeList();
  showScreen('merge');
});
$('mergeBackBtn').addEventListener('click', () => showScreen('welcome'));
$('backBtn').addEventListener('click', () => {
  if (state.gridMode) toggleGridMode(false);
  showScreen('welcome');
});

const dropZone = $('dropZone');
['dragenter', 'dragover'].forEach(ev =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); })
);
['dragleave', 'drop'].forEach(ev =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); })
);
dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.pdf'));
  if (files.length === 0) return;
  if (files.length === 1) {
    await openPdfFromPath(files[0].path);
  } else {
    state.mergeFiles = [];
    for (const f of files) {
      const bytes = await fs.promises.readFile(f.path);
      state.mergeFiles.push({
        name: f.name,
        bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      });
    }
    renderMergeList();
    showScreen('merge');
  }
});

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ============================================================
// Open PDF
// ============================================================
async function pickAndOpenPdf() {
  const r = await ipcRenderer.invoke('dialog:open', {
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (r.canceled || r.filePaths.length === 0) return;
  await openPdfFromPath(r.filePaths[0]);
}

async function openPdfFromPath(filePath) {
  try {
    showLoading('Opening PDF...');
    const buf = await fs.promises.readFile(filePath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    await loadPdfBytes(ab, filePath);
    showScreen('editor');
    try { await ipcRenderer.invoke('recents:add', filePath); } catch {}
  } catch (err) {
    console.error(err);
    toast('Failed to open PDF: ' + err.message, 'error');
  } finally {
    hideLoading();
  }
}

// ============================================================
// Recents
// ============================================================
async function renderRecents() {
  let list = [];
  try { list = await ipcRenderer.invoke('recents:get'); } catch {}
  // Filter to only files that still exist on disk
  const existing = [];
  for (const p of list) {
    try { await fs.promises.access(p, fs.constants.F_OK); existing.push(p); } catch {}
  }
  const recentsEl = $('recents');
  const listEl = $('recentsList');
  listEl.innerHTML = '';
  if (existing.length === 0) {
    recentsEl.style.display = 'none';
    return;
  }
  recentsEl.style.display = '';
  for (const p of existing) {
    const item = document.createElement('button');
    item.className = 'recent-item';
    item.title = p;

    const icon = document.createElement('span');
    icon.className = 'recent-icon';
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

    const info = document.createElement('span');
    info.className = 'recent-info';
    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = path.basename(p);
    const dir = document.createElement('span');
    dir.className = 'recent-dir';
    dir.textContent = path.dirname(p);
    info.append(name, dir);

    const remove = document.createElement('span');
    remove.className = 'recent-remove';
    remove.textContent = '×';
    remove.title = 'Remove from recents';
    remove.addEventListener('click', async (e) => {
      e.stopPropagation();
      try { await ipcRenderer.invoke('recents:remove', p); } catch {}
      renderRecents();
    });

    item.append(icon, info, remove);
    item.addEventListener('click', () => openPdfFromPath(p));
    listEl.appendChild(item);
  }
}

async function loadPdfBytes(arrayBuffer, filePath) {
  const pdfjsCopy = arrayBuffer.slice(0);
  state.pdfBytes = arrayBuffer;
  state.filePath = filePath;
  state.pdfjsDoc = await pdfjsLib.getDocument({ data: pdfjsCopy }).promise;
  state.pageOrder = Array.from({ length: state.pdfjsDoc.numPages }, (_, i) => i);
  state.bookmarks = [];
  state.textAnnotations = [];
  state.repeatTexts = [];
  state.currentPage = 0;
  state.zoom = 1.0;
  state.fitMode = true;
  state.thumbCache.clear();
  state.gridMode = false;
  toggleGridMode(false);

  $('filename').textContent = filePath ? path.basename(filePath) : 'untitled.pdf';
  $('totalPages').textContent = state.pageOrder.length;
  $('pageCount').textContent = state.pageOrder.length;
  await renderThumbnails();
  await renderCurrentPage();
  renderBookmarks();
}

// ============================================================
// Page render + text layer
// ============================================================
async function renderCurrentPage() {
  if (!state.pdfjsDoc || state.pageOrder.length === 0) return;
  if (state.currentPage >= state.pageOrder.length) state.currentPage = state.pageOrder.length - 1;
  if (state.currentPage < 0) state.currentPage = 0;

  const origIdx = state.pageOrder[state.currentPage];
  const page = await state.pdfjsDoc.getPage(origIdx + 1);

  const wrap = $('canvasWrap');
  const baseViewport = page.getViewport({ scale: 1 });
  let scale = state.zoom;
  if (state.fitMode) {
    const padding = 48;
    const aw = wrap.clientWidth - padding;
    const ah = wrap.clientHeight - padding;
    scale = Math.min(aw / baseViewport.width, ah / baseViewport.height);
    if (!isFinite(scale) || scale <= 0) scale = 1.0;
    state.zoom = scale;
  }

  const viewport = page.getViewport({ scale });
  const canvas = $('pdfCanvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = viewport.width + 'px';
  canvas.style.height = viewport.height + 'px';

  const stage = $('canvasStage');
  stage.style.width = viewport.width + 'px';
  stage.style.height = viewport.height + 'px';

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (state.renderTask) {
    try { state.renderTask.cancel(); } catch (_) {}
  }
  state.renderTask = page.render({ canvasContext: ctx, viewport });
  try { await state.renderTask.promise; } catch (_) {}
  state.renderTask = null;

  $('curPage').textContent = state.currentPage + 1;
  $('zoomLabel').textContent = Math.round(state.zoom * 100) + '%';

  // Render text layer (selectable text) and overlay annotations
  await renderTextLayer(page, viewport);
  drawTextOverlays(viewport, scale);
  highlightActiveThumb();
}

// Manual text layer rendering. Each text run becomes an absolutely-positioned span.
// We control all styling so user-select can never be blocked by upstream CSS.
async function renderTextLayer(page, viewport) {
  const layer = $('textLayer');
  layer.innerHTML = '';
  layer.style.width = viewport.width + 'px';
  layer.style.height = viewport.height + 'px';
  try {
    const textContent = await page.getTextContent();
    const styles = textContent.styles || {};
    const fragment = document.createDocumentFragment();
    for (const item of textContent.items) {
      if (!item.str) continue;
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const angle = Math.atan2(tx[1], tx[0]);
      const fontHeight = Math.hypot(tx[2], tx[3]);
      if (fontHeight <= 0) continue;
      const span = document.createElement('span');
      span.textContent = item.str;
      span.style.left = `${tx[4]}px`;
      span.style.top = `${tx[5] - fontHeight}px`;
      span.style.fontSize = `${fontHeight}px`;
      const family = (styles[item.fontName] && styles[item.fontName].fontFamily) || 'sans-serif';
      span.style.fontFamily = family;
      if (angle !== 0) span.style.transform = `rotate(${angle}rad)`;
      fragment.appendChild(span);
    }
    layer.appendChild(fragment);
  } catch (e) {
    console.warn('Text layer render failed', e);
  }
}

// ============================================================
// Text overlay (placed annotations) — draggable
// ============================================================
function drawTextOverlays(viewport, scale) {
  const overlay = $('textOverlay');
  overlay.innerHTML = '';
  const origIdx = state.pageOrder[state.currentPage];
  const perPage = state.textAnnotations
    .filter(a => a.pageOriginalIdx === origIdx)
    .map(a => ({ ann: a, repeat: false }));
  const repeats = state.repeatTexts.map(a => ({ ann: a, repeat: true }));
  for (const { ann, repeat } of [...perPage, ...repeats]) {
    overlay.appendChild(makePlacedTextEl(ann, repeat));
  }
}

function makePlacedTextEl(ann, isRepeat) {
  const el = document.createElement('div');
  el.className = 'placed-text' + (isRepeat ? ' repeat' : '');
  el.textContent = ann.text;
  positionPlacedText(el, ann);

  if (isRepeat) {
    const badge = document.createElement('span');
    badge.className = 'placed-text-badge';
    badge.textContent = '↻';
    badge.title = 'Repeats on every page';
    el.appendChild(badge);
  }

  const del = document.createElement('span');
  del.className = 'placed-text-del';
  del.textContent = '×';
  del.title = 'Remove';
  del.addEventListener('mousedown', (e) => { e.stopPropagation(); });
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isRepeat) {
      const idx = state.repeatTexts.indexOf(ann);
      if (idx >= 0) state.repeatTexts.splice(idx, 1);
    } else {
      const idx = state.textAnnotations.indexOf(ann);
      if (idx >= 0) state.textAnnotations.splice(idx, 1);
    }
    drawTextOverlays(null, state.zoom);
    toast('Text removed');
  });
  el.appendChild(del);

  el.addEventListener('mousedown', (e) => onTextMouseDown(e, el, ann));
  return el;
}

function positionPlacedText(el, ann) {
  const scale = state.zoom;
  el.style.left = (ann.x * scale) + 'px';
  el.style.top = (ann.y * scale) + 'px';
  el.style.fontSize = (ann.size * scale) + 'px';
  el.style.color = ann.color;
  el.style.fontFamily = cssFontFamily(ann.font || 'helvetica');
  el.style.fontWeight = ann.bold ? '700' : '400';
  el.style.fontStyle = ann.italic ? 'italic' : 'normal';
  el.style.textDecoration = ann.underline ? 'underline' : 'none';
}

function onTextMouseDown(e, el, ann) {
  // If user is placing pending text, don't intercept — let the click through
  if (state.pendingTextPlacement) return;
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  el.classList.add('dragging');
  document.body.classList.add('text-dragging');
  const startX = e.clientX, startY = e.clientY;
  const origX = ann.x, origY = ann.y;
  const scale = state.zoom;
  let moved = false;
  function onMove(ev) {
    const dx = (ev.clientX - startX) / scale;
    const dy = (ev.clientY - startY) / scale;
    if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 2) moved = true;
    ann.x = origX + dx;
    ann.y = origY + dy;
    positionPlacedText(el, ann);
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    el.classList.remove('dragging');
    document.body.classList.remove('text-dragging');
    if (moved) toast('Text moved');
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ============================================================
// Sidebar thumbnails
// ============================================================
async function renderThumbnails() {
  const list = $('pageList');
  list.innerHTML = '';
  for (let i = 0; i < state.pageOrder.length; i++) {
    const origIdx = state.pageOrder[i];
    const thumb = document.createElement('div');
    thumb.className = 'page-thumb';
    thumb.draggable = true;
    thumb.dataset.uiIdx = i;

    const c = document.createElement('canvas');
    thumb.appendChild(c);

    const num = document.createElement('div');
    num.className = 'page-thumb-num';
    num.textContent = (i + 1);
    thumb.appendChild(num);

    const del = document.createElement('button');
    del.className = 'page-thumb-del';
    del.textContent = '×';
    del.title = 'Delete page';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deletePage(parseInt(thumb.dataset.uiIdx, 10));
    });
    thumb.appendChild(del);

    thumb.addEventListener('click', () => {
      const ui = parseInt(thumb.dataset.uiIdx, 10);
      state.currentPage = ui;
      if (state.gridMode) toggleGridMode(false);
      renderCurrentPage();
    });

    setupThumbDrag(thumb);
    list.appendChild(thumb);
    renderThumbCanvas(c, origIdx);
  }
  highlightActiveThumb();
}

async function renderThumbCanvas(canvas, origIdx) {
  const wrap = canvas.parentElement; // the .page-thumb (or .grid-item)
  if (state.thumbCache.has(origIdx)) {
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      if (wrap) wrap.style.aspectRatio = `${img.width} / ${img.height}`;
      canvas.getContext('2d').drawImage(img, 0, 0);
    };
    img.src = state.thumbCache.get(origIdx);
    return;
  }
  try {
    const page = await state.pdfjsDoc.getPage(origIdx + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const targetW = 240;
    const scale = targetW / vp1.width;
    const viewport = page.getViewport({ scale });
    const w = Math.floor(viewport.width);
    const h = Math.floor(viewport.height);
    canvas.width = w;
    canvas.height = h;
    if (wrap) wrap.style.aspectRatio = `${w} / ${h}`;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    state.thumbCache.set(origIdx, canvas.toDataURL('image/png'));
  } catch (e) { /* ignore */ }
}

function highlightActiveThumb() {
  document.querySelectorAll('.page-thumb').forEach((t) => {
    const ui = parseInt(t.dataset.uiIdx, 10);
    t.classList.toggle('active', ui === state.currentPage);
  });
  document.querySelectorAll('.grid-item').forEach((t) => {
    const ui = parseInt(t.dataset.uiIdx, 10);
    t.classList.toggle('active', ui === state.currentPage);
  });
}

function deletePage(uiIdx) {
  if (state.pageOrder.length <= 1) {
    toast('Cannot delete the only page', 'error');
    return;
  }
  const removedOrig = state.pageOrder[uiIdx];
  state.pageOrder.splice(uiIdx, 1);
  state.textAnnotations = state.textAnnotations.filter(a => a.pageOriginalIdx !== removedOrig);
  state.bookmarks = state.bookmarks.filter(b => b.pageOriginalIdx !== removedOrig);
  if (state.currentPage >= state.pageOrder.length) state.currentPage = state.pageOrder.length - 1;
  $('totalPages').textContent = state.pageOrder.length;
  $('pageCount').textContent = state.pageOrder.length;
  renderThumbnails();
  if (state.gridMode) renderGridView();
  renderCurrentPage();
  renderBookmarks();
  toast('Page removed');
}

// ============================================================
// Drag-and-drop reordering — sidebar (vertical) and grid (any direction)
// ============================================================
let dragSrcIdx = null;
function setupThumbDrag(el) {
  el.addEventListener('dragstart', (e) => {
    dragSrcIdx = parseInt(el.dataset.uiIdx, 10);
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(dragSrcIdx)); } catch (_) {}
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    document.querySelectorAll('.page-thumb').forEach(t =>
      t.classList.remove('drop-before', 'drop-after'));
    dragSrcIdx = null;
  });
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = el.getBoundingClientRect();
    const before = (e.clientY - r.top) < r.height / 2;
    el.classList.toggle('drop-before', before);
    el.classList.toggle('drop-after', !before);
  });
  el.addEventListener('dragleave', () => {
    el.classList.remove('drop-before', 'drop-after');
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const tgt = parseInt(el.dataset.uiIdx, 10);
    const src = dragSrcIdx;
    el.classList.remove('drop-before', 'drop-after');
    if (src === null || src === tgt) return;
    const r = el.getBoundingClientRect();
    const before = (e.clientY - r.top) < r.height / 2;
    let dest = before ? tgt : tgt + 1;
    movePage(src, dest);
  });
}

let gridDragSrcIdx = null;
function setupGridDrag(el) {
  el.addEventListener('dragstart', (e) => {
    gridDragSrcIdx = parseInt(el.dataset.uiIdx, 10);
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(gridDragSrcIdx)); } catch (_) {}
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    document.querySelectorAll('.grid-item').forEach(t =>
      t.classList.remove('drop-before', 'drop-after'));
    gridDragSrcIdx = null;
  });
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = el.getBoundingClientRect();
    const before = (e.clientX - r.left) < r.width / 2;
    el.classList.toggle('drop-before', before);
    el.classList.toggle('drop-after', !before);
  });
  el.addEventListener('dragleave', () => {
    el.classList.remove('drop-before', 'drop-after');
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const tgt = parseInt(el.dataset.uiIdx, 10);
    const src = gridDragSrcIdx;
    el.classList.remove('drop-before', 'drop-after');
    if (src === null || src === tgt) return;
    const r = el.getBoundingClientRect();
    const before = (e.clientX - r.left) < r.width / 2;
    let dest = before ? tgt : tgt + 1;
    movePage(src, dest);
  });
}

function movePage(src, dest) {
  const [moved] = state.pageOrder.splice(src, 1);
  if (src < dest) dest -= 1;
  state.pageOrder.splice(dest, 0, moved);
  if (state.currentPage === src) state.currentPage = dest;
  else if (src < state.currentPage && dest >= state.currentPage) state.currentPage--;
  else if (src > state.currentPage && dest <= state.currentPage) state.currentPage++;
  renderThumbnails();
  if (state.gridMode) renderGridView();
  renderCurrentPage();
}

// ============================================================
// Grid reorder mode
// ============================================================
$('reorderBtn').addEventListener('click', () => toggleGridMode());

function toggleGridMode(force) {
  const next = (typeof force === 'boolean') ? force : !state.gridMode;
  state.gridMode = next;
  $('canvasWrap').classList.toggle('grid-mode', next);
  $('reorderBtn').classList.toggle('toggled', next);
  $('reorderLabel').textContent = next ? 'Done' : 'Reorder';
  if (next) renderGridView();
}

async function renderGridView() {
  const grid = $('gridView');
  grid.innerHTML = '';
  for (let i = 0; i < state.pageOrder.length; i++) {
    const origIdx = state.pageOrder[i];
    const item = document.createElement('div');
    item.className = 'grid-item';
    item.draggable = true;
    item.dataset.uiIdx = i;

    const c = document.createElement('canvas');
    item.appendChild(c);

    const num = document.createElement('div');
    num.className = 'grid-item-num';
    num.textContent = i + 1;
    item.appendChild(num);

    const del = document.createElement('button');
    del.className = 'grid-item-del';
    del.textContent = '×';
    del.title = 'Delete page';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deletePage(parseInt(item.dataset.uiIdx, 10));
    });
    item.appendChild(del);

    item.addEventListener('dblclick', () => {
      state.currentPage = parseInt(item.dataset.uiIdx, 10);
      toggleGridMode(false);
      renderCurrentPage();
    });

    setupGridDrag(item);
    grid.appendChild(item);
    renderGridCanvas(c, origIdx);
  }
  highlightActiveThumb();
}

async function renderGridCanvas(canvas, origIdx) {
  const wrap = canvas.parentElement;
  try {
    const page = await state.pdfjsDoc.getPage(origIdx + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const targetW = 360;
    const scale = targetW / vp1.width;
    const viewport = page.getViewport({ scale });
    const w = Math.floor(viewport.width);
    const h = Math.floor(viewport.height);
    canvas.width = w;
    canvas.height = h;
    if (wrap) wrap.style.aspectRatio = `${w} / ${h}`;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
  } catch (e) { /* ignore */ }
}

// ============================================================
// Page nav + zoom
// ============================================================
$('prevPage').addEventListener('click', () => {
  if (state.currentPage > 0) { state.currentPage--; renderCurrentPage(); }
});
$('nextPage').addEventListener('click', () => {
  if (state.currentPage < state.pageOrder.length - 1) { state.currentPage++; renderCurrentPage(); }
});
$('zoomIn').addEventListener('click', () => {
  state.fitMode = false;
  state.zoom = Math.min(state.zoom + 0.15, 5);
  renderCurrentPage();
});
$('zoomOut').addEventListener('click', () => {
  state.fitMode = false;
  state.zoom = Math.max(state.zoom - 0.15, 0.2);
  renderCurrentPage();
});
$('zoomFit').addEventListener('click', () => {
  state.fitMode = true;
  renderCurrentPage();
});

window.addEventListener('keydown', (e) => {
  if (!$('editor').classList.contains('active')) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') $('prevPage').click();
  else if (e.key === 'ArrowRight' || e.key === 'PageDown') $('nextPage').click();
});

// Intercept browser zoom shortcuts globally and route them to PDF zoom
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (!['+', '=', '-', '_', '0'].includes(e.key)) return;
  e.preventDefault();
  e.stopPropagation();
  if (!$('editor').classList.contains('active') || state.gridMode) return;
  if (e.key === '0') $('zoomFit').click();
  else if (e.key === '-' || e.key === '_') $('zoomOut').click();
  else $('zoomIn').click();
}, { capture: true });

// Ctrl+wheel zoom — also intercepted so Chromium doesn't zoom the chrome
window.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  e.stopPropagation();
  if (!$('editor').classList.contains('active') || state.gridMode || !state.pdfjsDoc) return;
  state.fitMode = false;
  const step = 0.1;
  if (e.deltaY < 0) state.zoom = Math.min(state.zoom + step, 5);
  else state.zoom = Math.max(state.zoom - step, 0.2);
  renderCurrentPage();
}, { capture: true, passive: false });

let resizeRaf = null;
window.addEventListener('resize', () => {
  if (!$('editor').classList.contains('active')) return;
  if (state.gridMode) return;
  if (!state.fitMode) return;
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(renderCurrentPage);
});

// ============================================================
// Add Text — supports drag placement & repeat-on-all-pages
// ============================================================
$('addTextBtn').addEventListener('click', () => {
  $('textInput').value = '';
  $('textRepeat').checked = false;
  $('textFont').value = 'helvetica';
  $('textBold').classList.remove('active');
  $('textItalic').classList.remove('active');
  $('textUnderline').classList.remove('active');
  openModal('textModal');
  setTimeout(() => $('textInput').focus(), 50);
});
['textBold', 'textItalic', 'textUnderline'].forEach(id => {
  $(id).addEventListener('click', () => $(id).classList.toggle('active'));
});
// Ctrl+B / Ctrl+I / Ctrl+U toggle inside the text input
$('textInput').addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === 'b') { e.preventDefault(); $('textBold').classList.toggle('active'); }
  else if (k === 'i') { e.preventDefault(); $('textItalic').classList.toggle('active'); }
  else if (k === 'u') { e.preventDefault(); $('textUnderline').classList.toggle('active'); }
});
$('textCancel').addEventListener('click', () => closeModal('textModal'));
$('textPlace').addEventListener('click', () => {
  const text = $('textInput').value.trim();
  if (!text) { toast('Enter some text', 'error'); return; }
  state.pendingTextPlacement = {
    text,
    size: Math.max(6, Math.min(200, parseInt($('textSize').value, 10) || 14)),
    color: $('textColor').value,
    repeat: $('textRepeat').checked,
    font: $('textFont').value,
    bold: $('textBold').classList.contains('active'),
    italic: $('textItalic').classList.contains('active'),
    underline: $('textUnderline').classList.contains('active')
  };
  closeModal('textModal');
  $('canvasWrap').classList.add('placing-text');
  toast(state.pendingTextPlacement.repeat
    ? 'Click to place — text will repeat on every page'
    : 'Click on the page to place text');
});

function cssFontFamily(font) {
  switch (font) {
    case 'times': return '"Times New Roman", Times, serif';
    case 'courier': return '"Courier New", Courier, monospace';
    default: return 'Helvetica, Arial, sans-serif';
  }
}

// Single mousedown handler with priority order:
//   pending text placement → place text
//   target inside placed-text → handled by its own listener (already stopPropagation'd)
//   target is a text-layer span → let browser handle text selection
//   otherwise → pan the scroll container
$('canvasWrap').addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (state.gridMode) return;

  // 1. Pending text placement
  if (state.pendingTextPlacement) {
    const canvas = $('pdfCanvas');
    const r = canvas.getBoundingClientRect();
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    if (cx < 0 || cy < 0 || cx > r.width || cy > r.height) return;
    const scale = state.zoom;
    const p = state.pendingTextPlacement;
    const ann = {
      x: cx / scale,
      y: cy / scale,
      text: p.text,
      size: p.size,
      color: p.color,
      font: p.font || 'helvetica',
      bold: !!p.bold,
      italic: !!p.italic,
      underline: !!p.underline
    };
    if (p.repeat) {
      state.repeatTexts.push(ann);
    } else {
      ann.pageOriginalIdx = state.pageOrder[state.currentPage];
      state.textAnnotations.push(ann);
    }
    state.pendingTextPlacement = null;
    $('canvasWrap').classList.remove('placing-text');
    drawTextOverlays(null, state.zoom);
    toast('Text added — drag to move, × to remove', 'success');
    return;
  }

  // 2. Click on a text-layer span → text selection has priority
  const layer = $('textLayer');
  if (layer && layer !== e.target && layer.contains(e.target)) return;

  // 3. Otherwise, start panning the canvas-wrap scroll container
  startPan(e);
});

function startPan(e) {
  const wrap = $('canvasWrap');
  const stage = $('canvasStage');
  // Only pan if there's actually overflow worth panning
  const canPanX = wrap.scrollWidth > wrap.clientWidth;
  const canPanY = wrap.scrollHeight > wrap.clientHeight;
  if (!canPanX && !canPanY) return;

  e.preventDefault();
  stage.classList.add('panning');
  let lastX = e.clientX, lastY = e.clientY;
  function onMove(ev) {
    if (canPanX) wrap.scrollLeft -= (ev.clientX - lastX);
    if (canPanY) wrap.scrollTop  -= (ev.clientY - lastY);
    lastX = ev.clientX;
    lastY = ev.clientY;
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    stage.classList.remove('panning');
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ============================================================
// Bookmarks (incl. anchored to selected text)
// ============================================================
$('addBookmarkBtn').addEventListener('click', () => {
  // Capture current selection (if any) BEFORE opening modal (focus changes)
  const sel = captureCanvasSelection();
  state.capturedSelection = sel;

  $('bookmarkTitle').value = sel ? sel.text.slice(0, 80) : '';
  $('bmPage').textContent = state.currentPage + 1;
  if (sel) {
    $('bmHint').innerHTML = 'Anchored to selected text on page <span id="bmPage">' +
      (state.currentPage + 1) + '</span>.';
  } else {
    $('bmHint').innerHTML = 'Tip: select text on the page first to anchor the bookmark to it. ' +
      'Otherwise it will point to page <span id="bmPage">' + (state.currentPage + 1) + '</span>.';
  }
  openModal('bookmarkModal');
  setTimeout(() => $('bookmarkTitle').focus(), 50);
});
$('bmCancel').addEventListener('click', () => closeModal('bookmarkModal'));
$('bmAdd').addEventListener('click', () => {
  const title = $('bookmarkTitle').value.trim();
  if (!title) { toast('Enter a title', 'error'); return; }
  const bm = {
    title,
    pageOriginalIdx: state.pageOrder[state.currentPage]
  };
  if (state.capturedSelection) {
    bm.x = state.capturedSelection.x;
    bm.y = state.capturedSelection.y;
  }
  state.bookmarks.push(bm);
  state.capturedSelection = null;
  closeModal('bookmarkModal');
  renderBookmarks();
  toast('Bookmark added', 'success');
});

function captureCanvasSelection() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const stage = $('canvasStage');
  // Ensure selection is inside our text layer (i.e. inside the page)
  if (!stage.contains(range.startContainer)) return null;
  const text = sel.toString().trim();
  if (!text) return null;
  const rect = range.getBoundingClientRect();
  const canvas = $('pdfCanvas');
  const cr = canvas.getBoundingClientRect();
  const cx = rect.left - cr.left;
  const cy = rect.top - cr.top;
  const scale = state.zoom;
  return {
    text,
    x: cx / scale,
    y: cy / scale,
    pageOriginalIdx: state.pageOrder[state.currentPage]
  };
}

function renderBookmarks() {
  const list = $('bookmarkList');
  list.innerHTML = '';
  if (state.bookmarks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No bookmarks yet';
    list.appendChild(empty);
    return;
  }
  state.bookmarks.forEach((b, i) => {
    const item = document.createElement('div');
    item.className = 'bookmark-item';
    const uiPage = state.pageOrder.indexOf(b.pageOriginalIdx);

    if (b.x !== undefined) {
      const anchor = document.createElement('span');
      anchor.className = 'bm-anchor';
      anchor.textContent = '“';
      anchor.title = 'Anchored to text';
      item.appendChild(anchor);
    }

    const titleEl = document.createElement('span');
    titleEl.className = 'bm-title';
    titleEl.textContent = b.title;
    const pg = document.createElement('span');
    pg.className = 'bm-page';
    pg.textContent = uiPage >= 0 ? `p.${uiPage + 1}` : '—';
    const del = document.createElement('button');
    del.className = 'bm-del';
    del.textContent = '×';
    del.title = 'Remove';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      state.bookmarks.splice(i, 1);
      renderBookmarks();
    });

    item.appendChild(titleEl);
    item.appendChild(pg);
    item.appendChild(del);
    item.addEventListener('click', () => gotoBookmark(b));
    list.appendChild(item);
  });
}

async function gotoBookmark(b) {
  const uiPage = state.pageOrder.indexOf(b.pageOriginalIdx);
  if (uiPage < 0) return;
  if (state.gridMode) toggleGridMode(false);
  state.currentPage = uiPage;
  await renderCurrentPage();
  if (b.x !== undefined && b.y !== undefined) {
    const wrap = $('canvasWrap');
    const cx = b.x * state.zoom;
    const cy = b.y * state.zoom;
    wrap.scrollTo({
      left: Math.max(0, cx - 60),
      top: Math.max(0, cy - 60),
      behavior: 'smooth'
    });
  }
}

// ============================================================
// Save edited PDF
// ============================================================
$('saveBtn').addEventListener('click', savePdf);

async function savePdf() {
  if (!state.pdfBytes) return;
  try {
    const defaultName = state.filePath
      ? path.basename(state.filePath, path.extname(state.filePath)) + '-edited.pdf'
      : 'edited.pdf';
    const r = await ipcRenderer.invoke('dialog:save', {
      defaultPath: defaultName,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (r.canceled || !r.filePath) return;

    showLoading('Saving PDF...');
    const srcDoc = await PDFDocument.load(state.pdfBytes);
    const newDoc = await PDFDocument.create();
    const fontCache = new Map();
    async function getFont(name) {
      if (!fontCache.has(name)) fontCache.set(name, await newDoc.embedFont(name));
      return fontCache.get(name);
    }

    const copied = await newDoc.copyPages(srcDoc, state.pageOrder);
    const origToNewIdx = new Map();
    copied.forEach((p, i) => {
      newDoc.addPage(p);
      origToNewIdx.set(state.pageOrder[i], i);
    });

    // Per-page text annotations
    for (const a of state.textAnnotations) {
      const newIdx = origToNewIdx.get(a.pageOriginalIdx);
      if (newIdx === undefined) continue;
      await drawTextOnPage(newDoc.getPage(newIdx), a, getFont);
    }

    // Repeat texts → apply to every page
    if (state.repeatTexts.length > 0) {
      for (let pi = 0; pi < newDoc.getPageCount(); pi++) {
        const page = newDoc.getPage(pi);
        for (const a of state.repeatTexts) await drawTextOnPage(page, a, getFont);
      }
    }

    // Bookmarks
    if (state.bookmarks.length > 0) {
      addOutline(newDoc, state.bookmarks
        .map(b => ({
          title: b.title,
          pageIndex: origToNewIdx.get(b.pageOriginalIdx),
          x: b.x,
          y: b.y
        }))
        .filter(b => b.pageIndex !== undefined));
    }

    const out = await newDoc.save();
    await fs.promises.writeFile(r.filePath, Buffer.from(out));
    hideLoading();
    toast('Saved to ' + path.basename(r.filePath), 'success');
  } catch (err) {
    console.error(err);
    hideLoading();
    toast('Save failed: ' + err.message, 'error');
  }
}

function pickStandardFont(family, bold, italic) {
  if (family === 'times') {
    if (bold && italic) return StandardFonts.TimesRomanBoldItalic;
    if (bold) return StandardFonts.TimesRomanBold;
    if (italic) return StandardFonts.TimesRomanItalic;
    return StandardFonts.TimesRoman;
  }
  if (family === 'courier') {
    if (bold && italic) return StandardFonts.CourierBoldOblique;
    if (bold) return StandardFonts.CourierBold;
    if (italic) return StandardFonts.CourierOblique;
    return StandardFonts.Courier;
  }
  if (bold && italic) return StandardFonts.HelveticaBoldOblique;
  if (bold) return StandardFonts.HelveticaBold;
  if (italic) return StandardFonts.HelveticaOblique;
  return StandardFonts.Helvetica;
}

async function drawTextOnPage(page, a, getFont) {
  const fontName = pickStandardFont(a.font || 'helvetica', !!a.bold, !!a.italic);
  const font = await getFont(fontName);
  const { height } = page.getSize();
  const { r, g, b } = hexToRgb01(a.color);
  const baselineY = height - a.y - a.size; // baseline approximation
  page.drawText(a.text, {
    x: a.x,
    y: baselineY,
    size: a.size,
    font,
    color: rgb(r, g, b)
  });
  if (a.underline) {
    let textWidth;
    try { textWidth = font.widthOfTextAtSize(a.text, a.size); }
    catch (_) { textWidth = a.text.length * a.size * 0.5; }
    const ulY = baselineY - Math.max(1, a.size * 0.08);
    page.drawLine({
      start: { x: a.x, y: ulY },
      end:   { x: a.x + textWidth, y: ulY },
      thickness: Math.max(0.5, a.size * 0.06),
      color: rgb(r, g, b)
    });
  }
}

// PDF outline. When item has x,y (in top-left PDF coords), use them in /XYZ Dest.
function addOutline(pdfDoc, items) {
  if (items.length === 0) return;
  const ctx = pdfDoc.context;
  const outlinesRef = ctx.nextRef();
  const itemRefs = items.map(() => ctx.nextRef());

  items.forEach((it, i) => {
    const page = pdfDoc.getPage(it.pageIndex);
    const { height } = page.getSize();
    const dest = PDFArray.withContext(ctx);
    dest.push(page.ref);
    dest.push(PDFName.of('XYZ'));
    if (it.x !== undefined && it.y !== undefined) {
      dest.push(PDFNumber.of(it.x));
      dest.push(PDFNumber.of(height - it.y));
      dest.push(ctx.obj(null));
    } else {
      dest.push(ctx.obj(null));
      dest.push(ctx.obj(null));
      dest.push(ctx.obj(null));
    }
    const dict = ctx.obj({
      Title: PDFString.of(it.title),
      Parent: outlinesRef,
      Dest: dest
    });
    if (i > 0) dict.set(PDFName.of('Prev'), itemRefs[i - 1]);
    if (i < items.length - 1) dict.set(PDFName.of('Next'), itemRefs[i + 1]);
    ctx.assign(itemRefs[i], dict);
  });

  ctx.assign(outlinesRef, ctx.obj({
    Type: PDFName.of('Outlines'),
    First: itemRefs[0],
    Last: itemRefs[itemRefs.length - 1],
    Count: items.length
  }));
  pdfDoc.catalog.set(PDFName.of('Outlines'), outlinesRef);
  pdfDoc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

// ============================================================
// Merge mode
// ============================================================
const mergeBody = $('mergeBody');
const mergeList = $('mergeList');

['dragenter', 'dragover'].forEach(ev =>
  mergeBody.addEventListener(ev, (e) => {
    e.preventDefault();
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
      mergeBody.classList.add('dragover');
    }
  })
);
['dragleave', 'drop'].forEach(ev =>
  mergeBody.addEventListener(ev, () => mergeBody.classList.remove('dragover'))
);
mergeBody.addEventListener('drop', async (e) => {
  e.preventDefault();
  const files = e.dataTransfer && e.dataTransfer.files
    ? Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.pdf'))
    : [];
  for (const f of files) {
    const buf = await fs.promises.readFile(f.path);
    state.mergeFiles.push({
      name: f.name,
      bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    });
  }
  if (files.length) renderMergeList();
});

$('addMoreBtn').addEventListener('click', async () => {
  const r = await ipcRenderer.invoke('dialog:open', {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (r.canceled) return;
  for (const fp of r.filePaths) {
    const buf = await fs.promises.readFile(fp);
    state.mergeFiles.push({
      name: path.basename(fp),
      bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    });
  }
  renderMergeList();
});

function renderMergeList() {
  mergeList.innerHTML = '';
  $('doMergeBtn').disabled = state.mergeFiles.length < 2;
  $('mergeEmpty').style.opacity = state.mergeFiles.length === 0 ? '1' : '0';

  state.mergeFiles.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'merge-item';
    row.draggable = true;
    row.dataset.idx = i;

    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.innerHTML = '⋮⋮';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = f.name;

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = formatBytes(f.bytes.byteLength);

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = '×';
    remove.title = 'Remove';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      state.mergeFiles.splice(i, 1);
      renderMergeList();
    });

    row.append(grip, name, meta, remove);
    setupMergeDrag(row);
    mergeList.appendChild(row);
  });
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

let mergeDragSrc = null;
function setupMergeDrag(el) {
  el.addEventListener('dragstart', (e) => {
    mergeDragSrc = parseInt(el.dataset.idx, 10);
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(mergeDragSrc)); } catch (_) {}
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    document.querySelectorAll('.merge-item').forEach(r => r.classList.remove('drop-before', 'drop-after'));
    mergeDragSrc = null;
  });
  el.addEventListener('dragover', (e) => {
    if (mergeDragSrc === null) return;
    e.preventDefault();
    e.stopPropagation();
    const r = el.getBoundingClientRect();
    const before = (e.clientY - r.top) < r.height / 2;
    el.classList.toggle('drop-before', before);
    el.classList.toggle('drop-after', !before);
  });
  el.addEventListener('dragleave', () => {
    el.classList.remove('drop-before', 'drop-after');
  });
  el.addEventListener('drop', (e) => {
    if (mergeDragSrc === null) return;
    e.preventDefault();
    e.stopPropagation();
    const tgt = parseInt(el.dataset.idx, 10);
    const r = el.getBoundingClientRect();
    const before = (e.clientY - r.top) < r.height / 2;
    let dest = before ? tgt : tgt + 1;
    const src = mergeDragSrc;
    if (src === tgt) return;
    const [moved] = state.mergeFiles.splice(src, 1);
    if (src < dest) dest -= 1;
    state.mergeFiles.splice(dest, 0, moved);
    renderMergeList();
  });
}

$('doMergeBtn').addEventListener('click', async () => {
  if (state.mergeFiles.length < 2) return;
  try {
    const r = await ipcRenderer.invoke('dialog:save', {
      defaultPath: 'merged.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (r.canceled || !r.filePath) return;
    showLoading('Merging PDFs...');
    const out = await PDFDocument.create();
    for (const f of state.mergeFiles) {
      const src = await PDFDocument.load(f.bytes);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach(p => out.addPage(p));
    }
    const bytes = await out.save();
    await fs.promises.writeFile(r.filePath, Buffer.from(bytes));
    hideLoading();
    toast('Merged ' + state.mergeFiles.length + ' files', 'success');
  } catch (err) {
    console.error(err);
    hideLoading();
    toast('Merge failed: ' + err.message, 'error');
  }
});

// ============================================================
// Modals
// ============================================================
document.querySelectorAll('.modal').forEach(m => {
  m.addEventListener('click', (e) => {
    if (e.target === m) m.classList.remove('open');
  });
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open'));
    if (state.pendingTextPlacement) {
      state.pendingTextPlacement = null;
      $('canvasWrap').classList.remove('placing-text');
    }
  }
});

// ============================================================
// Curator branding (Olopad) + version
// ============================================================
const CURATOR_URL = 'https://olopad.com';
try {
  const pkg = require('../package.json');
  $('appVersion').textContent = 'v' + pkg.version;
} catch (_) {}
$('curatorLink').addEventListener('click', (e) => {
  e.preventDefault();
  try { shell.openExternal(CURATOR_URL); } catch (_) {}
});

// Initial screen
showScreen('welcome');
