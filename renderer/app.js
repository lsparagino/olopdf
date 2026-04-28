// ============================================================
// PDF Editor — renderer logic
// ============================================================
const path = require('path');
const fs = require('fs');
const { ipcRenderer } = require('electron');

// pdf.js (legacy CJS build) + pdf-lib
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const { PDFDocument, StandardFonts, rgb, PDFName, PDFString, PDFArray, PDFRef, PDFNumber } = require('pdf-lib');

// Configure pdf.js worker by loading the worker script as a Blob URL.
// This works both in development and in the packaged asar.
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
  filePath: null,           // string | null
  pdfBytes: null,           // ArrayBuffer of original
  pdfjsDoc: null,           // pdfjs document
  pageOrder: [],            // array of original page indices (0-based)
  bookmarks: [],            // [{ title, pageOriginalIdx }]
  textAnnotations: [],      // [{ pageOriginalIdx, x, y, text, size, color }]
  currentPage: 0,           // index into pageOrder
  zoom: 1.0,
  fitMode: false,           // when true, recompute zoom to fit container
  thumbCache: new Map(),    // originalPageIdx -> dataURL
  renderTask: null,
  pendingTextPlacement: null, // {text,size,color} | null
  // merge mode
  mergeFiles: [],           // [{ name, bytes }]
};

// ============================================================
// Helpers
// ============================================================
const $ = (id) => document.getElementById(id);

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
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
// Welcome screen
// ============================================================
$('openBtn').addEventListener('click', pickAndOpenPdf);
$('mergeBtn').addEventListener('click', () => {
  state.mergeFiles = [];
  renderMergeList();
  showScreen('merge');
});
$('mergeBackBtn').addEventListener('click', () => showScreen('welcome'));
$('backBtn').addEventListener('click', () => showScreen('welcome'));

// Drop on welcome card
const dropZone = $('dropZone');
['dragenter', 'dragover'].forEach(ev =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach(ev =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
  })
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
      state.mergeFiles.push({ name: f.name, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    }
    renderMergeList();
    showScreen('merge');
  }
});

// Prevent default file drops on the entire window
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
  } catch (err) {
    console.error(err);
    toast('Failed to open PDF: ' + err.message, 'error');
  } finally {
    hideLoading();
  }
}

async function loadPdfBytes(arrayBuffer, filePath) {
  // pdfjs needs a copy because it transfers the buffer
  const pdfjsCopy = arrayBuffer.slice(0);
  state.pdfBytes = arrayBuffer;
  state.filePath = filePath;
  state.pdfjsDoc = await pdfjsLib.getDocument({ data: pdfjsCopy }).promise;
  state.pageOrder = Array.from({ length: state.pdfjsDoc.numPages }, (_, i) => i);
  state.bookmarks = [];
  state.textAnnotations = [];
  state.currentPage = 0;
  state.zoom = 1.0;
  state.fitMode = true;
  state.thumbCache.clear();

  $('filename').textContent = filePath ? path.basename(filePath) : 'untitled.pdf';
  $('totalPages').textContent = state.pageOrder.length;
  $('pageCount').textContent = state.pageOrder.length;
  await renderThumbnails();
  await renderCurrentPage();
  renderBookmarks();
}

// ============================================================
// Rendering
// ============================================================
async function renderCurrentPage() {
  if (!state.pdfjsDoc || state.pageOrder.length === 0) return;
  if (state.currentPage >= state.pageOrder.length) state.currentPage = state.pageOrder.length - 1;
  if (state.currentPage < 0) state.currentPage = 0;

  const origIdx = state.pageOrder[state.currentPage];
  const page = await state.pdfjsDoc.getPage(origIdx + 1);

  // Compute scale
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

  drawTextOverlays(viewport, scale);
  highlightActiveThumb();
}

function drawTextOverlays(viewport, scale) {
  const overlay = $('textOverlay');
  overlay.innerHTML = '';
  const origIdx = state.pageOrder[state.currentPage];
  const items = state.textAnnotations.filter(a => a.pageOriginalIdx === origIdx);
  for (const a of items) {
    const el = document.createElement('div');
    el.className = 'placed-text';
    el.textContent = a.text;
    el.style.left = (a.x * scale) + 'px';
    // a.y is from top-left in PDF user units (after our conversion below).
    el.style.top = (a.y * scale) + 'px';
    el.style.fontSize = (a.size * scale) + 'px';
    el.style.color = a.color;
    el.style.lineHeight = '1';
    el.title = 'Click to remove';
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const idx = state.textAnnotations.indexOf(a);
      if (idx >= 0) state.textAnnotations.splice(idx, 1);
      renderCurrentPage();
      toast('Text removed');
    });
    overlay.appendChild(el);
  }
}

async function renderThumbnails() {
  const list = $('pageList');
  list.innerHTML = '';
  for (let i = 0; i < state.pageOrder.length; i++) {
    const origIdx = state.pageOrder[i];
    const thumb = document.createElement('div');
    thumb.className = 'page-thumb';
    thumb.draggable = true;
    thumb.dataset.uiIdx = i;

    // canvas placeholder; render async
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
      renderCurrentPage();
    });

    setupThumbDrag(thumb);
    list.appendChild(thumb);
    renderThumbCanvas(c, origIdx);
  }
  highlightActiveThumb();
}

async function renderThumbCanvas(canvas, origIdx) {
  if (state.thumbCache.has(origIdx)) {
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
    };
    img.src = state.thumbCache.get(origIdx);
    return;
  }
  try {
    const page = await state.pdfjsDoc.getPage(origIdx + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const targetW = 200;
    const scale = targetW / vp1.width;
    const viewport = page.getViewport({ scale });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
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
}

function deletePage(uiIdx) {
  if (state.pageOrder.length <= 1) {
    toast('Cannot delete the only page', 'error');
    return;
  }
  const removedOrig = state.pageOrder[uiIdx];
  state.pageOrder.splice(uiIdx, 1);
  // Drop annotations + bookmarks pointing to that original page
  state.textAnnotations = state.textAnnotations.filter(a => a.pageOriginalIdx !== removedOrig);
  state.bookmarks = state.bookmarks.filter(b => b.pageOriginalIdx !== removedOrig);
  if (state.currentPage >= state.pageOrder.length) state.currentPage = state.pageOrder.length - 1;
  $('totalPages').textContent = state.pageOrder.length;
  $('pageCount').textContent = state.pageOrder.length;
  renderThumbnails();
  renderCurrentPage();
  renderBookmarks();
  toast('Page removed');
}

// ============================================================
// Drag-and-drop reordering of pages
// ============================================================
let dragSrcIdx = null;
function setupThumbDrag(el) {
  el.addEventListener('dragstart', (e) => {
    dragSrcIdx = parseInt(el.dataset.uiIdx, 10);
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragSrcIdx));
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    document.querySelectorAll('.page-thumb').forEach(t => {
      t.classList.remove('drop-before', 'drop-after');
    });
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
    const [moved] = state.pageOrder.splice(src, 1);
    if (src < dest) dest -= 1;
    state.pageOrder.splice(dest, 0, moved);
    // adjust currentPage
    if (state.currentPage === src) state.currentPage = dest;
    else if (src < state.currentPage && dest >= state.currentPage) state.currentPage--;
    else if (src > state.currentPage && dest <= state.currentPage) state.currentPage++;
    renderThumbnails();
    renderCurrentPage();
  });
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
  if ($('editor').classList.contains('active')) {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { $('prevPage').click(); }
    else if (e.key === 'ArrowRight' || e.key === 'PageDown') { $('nextPage').click(); }
  }
});

let resizeRaf = null;
window.addEventListener('resize', () => {
  if (!$('editor').classList.contains('active')) return;
  if (!state.fitMode) return;
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(renderCurrentPage);
});

// ============================================================
// Add Text
// ============================================================
$('addTextBtn').addEventListener('click', () => {
  $('textInput').value = '';
  openModal('textModal');
  setTimeout(() => $('textInput').focus(), 50);
});
$('textCancel').addEventListener('click', () => closeModal('textModal'));
$('textPlace').addEventListener('click', () => {
  const text = $('textInput').value.trim();
  if (!text) { toast('Enter some text', 'error'); return; }
  const size = Math.max(6, Math.min(200, parseInt($('textSize').value, 10) || 14));
  const color = $('textColor').value;
  state.pendingTextPlacement = { text, size, color };
  closeModal('textModal');
  $('canvasWrap').classList.add('placing-text');
  toast('Click on the page to place text');
});

$('canvasWrap').addEventListener('click', (e) => {
  if (!state.pendingTextPlacement) return;
  const canvas = $('pdfCanvas');
  const r = canvas.getBoundingClientRect();
  const cx = e.clientX - r.left;
  const cy = e.clientY - r.top;
  if (cx < 0 || cy < 0 || cx > r.width || cy > r.height) return;
  const scale = state.zoom;
  // Convert CSS px on canvas → PDF user-space (top-left coord system; we'll flip on save)
  const xPdf = cx / scale;
  const yPdfFromTop = cy / scale;
  const origIdx = state.pageOrder[state.currentPage];
  state.textAnnotations.push({
    pageOriginalIdx: origIdx,
    x: xPdf,
    y: yPdfFromTop,
    text: state.pendingTextPlacement.text,
    size: state.pendingTextPlacement.size,
    color: state.pendingTextPlacement.color
  });
  state.pendingTextPlacement = null;
  $('canvasWrap').classList.remove('placing-text');
  renderCurrentPage();
  toast('Text added — click to remove', 'success');
});

// ============================================================
// Bookmarks
// ============================================================
$('addBookmarkBtn').addEventListener('click', () => {
  $('bookmarkTitle').value = '';
  $('bmPage').textContent = state.currentPage + 1;
  openModal('bookmarkModal');
  setTimeout(() => $('bookmarkTitle').focus(), 50);
});
$('bmCancel').addEventListener('click', () => closeModal('bookmarkModal'));
$('bmAdd').addEventListener('click', () => {
  const title = $('bookmarkTitle').value.trim();
  if (!title) { toast('Enter a title', 'error'); return; }
  state.bookmarks.push({
    title,
    pageOriginalIdx: state.pageOrder[state.currentPage]
  });
  closeModal('bookmarkModal');
  renderBookmarks();
  toast('Bookmark added', 'success');
});

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
    item.addEventListener('click', () => {
      if (uiPage >= 0) {
        state.currentPage = uiPage;
        renderCurrentPage();
      }
    });
    list.appendChild(item);
  });
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
    const helvetica = await newDoc.embedFont(StandardFonts.Helvetica);

    // Copy pages in current order
    const copied = await newDoc.copyPages(srcDoc, state.pageOrder);
    // Maps: original page index -> position in newDoc
    const origToNewIdx = new Map();
    copied.forEach((p, i) => {
      newDoc.addPage(p);
      origToNewIdx.set(state.pageOrder[i], i);
    });

    // Apply text annotations (PDF y-axis is bottom-up)
    for (const a of state.textAnnotations) {
      const newIdx = origToNewIdx.get(a.pageOriginalIdx);
      if (newIdx === undefined) continue;
      const page = newDoc.getPage(newIdx);
      const { height } = page.getSize();
      const { r, g, b } = hexToRgb01(a.color);
      page.drawText(a.text, {
        x: a.x,
        y: height - a.y - a.size,  // baseline anchor approximation
        size: a.size,
        font: helvetica,
        color: rgb(r, g, b)
      });
    }

    // Apply bookmarks (PDF outline)
    if (state.bookmarks.length > 0) {
      addOutline(newDoc, state.bookmarks
        .map(b => ({ title: b.title, pageIndex: origToNewIdx.get(b.pageOriginalIdx) }))
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

// Build a flat PDF outline (bookmarks).
// Reference: PDF 1.7 §12.3 Document-level navigation.
function addOutline(pdfDoc, items) {
  if (items.length === 0) return;
  const ctx = pdfDoc.context;
  const outlinesRef = ctx.nextRef();
  const itemRefs = items.map(() => ctx.nextRef());

  items.forEach((it, i) => {
    const page = pdfDoc.getPage(it.pageIndex);
    const dest = PDFArray.withContext(ctx);
    dest.push(page.ref);
    dest.push(PDFName.of('XYZ'));
    dest.push(ctx.obj(null));   // left
    dest.push(ctx.obj(null));   // top
    dest.push(ctx.obj(null));   // zoom
    const dict = ctx.obj({
      Title: PDFString.of(it.title),
      Parent: outlinesRef,
      Dest: dest
    });
    if (i > 0) dict.set(PDFName.of('Prev'), itemRefs[i - 1]);
    if (i < items.length - 1) dict.set(PDFName.of('Next'), itemRefs[i + 1]);
    ctx.assign(itemRefs[i], dict);
  });

  const outlinesDict = ctx.obj({
    Type: PDFName.of('Outlines'),
    First: itemRefs[0],
    Last: itemRefs[itemRefs.length - 1],
    Count: items.length
  });
  ctx.assign(outlinesRef, outlinesDict);

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
// Modal background click closes
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

// Initial screen
showScreen('welcome');
