'use strict';
// Welcome screen: open/merge buttons, drag-drop, recents, curator link, version.
const path = require('path');
const fs = require('fs');
const { ipcRenderer, shell } = require('electron');
const { $, toast, showLoading, hideLoading, showScreen, onScreenChange } = require('./dom');
const { state, config } = require('./state');
const { arrayBufferFromBuffer, readFileAsArrayBuffer } = require('./util');

// ---- App version + curator link ----
try {
  const pkg = require('../../package.json');
  $('appVersion').textContent = 'v' + pkg.version;
} catch (_) {}
$('curatorLink').addEventListener('click', (e) => {
  e.preventDefault();
  try { shell.openExternal(config.CURATOR_URL); } catch (_) {}
});

// ---- Welcome buttons ----
$('openBtn').addEventListener('click', pickAndOpenPdf);
$('mergeBtn').addEventListener('click', () => {
  state.mergeFiles = [];
  // merge.js exports renderMergeList for the initial empty render
  require('./merge').renderMergeList();
  showScreen('merge');
});
$('compareBtn').addEventListener('click', () => {
  showScreen('compare');
});
$('backBtn').addEventListener('click', () => {
  if (state.gridMode) {
    require('./thumbnails').toggleGridMode(false);
  }
  showScreen('welcome');
});

// ---- Drop zone (single file → open; multiple → merge mode) ----
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
      state.mergeFiles.push({ name: f.name, bytes: await readFileAsArrayBuffer(f.path) });
    }
    require('./merge').renderMergeList();
    showScreen('merge');
  }
});

// ---- File open ----
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
    const ab = await readFileAsArrayBuffer(filePath);
    await loadPdfBytes(ab, filePath);
    showScreen('editor');
    try { await ipcRenderer.invoke('recents:add', filePath); } catch (_) {}
  } catch (err) {
    console.error(err);
    toast('Failed to open PDF: ' + err.message, 'error');
  } finally {
    hideLoading();
  }
}

async function loadPdfBytes(arrayBuffer, filePath) {
  const { pdfjsLib } = require('./pdf-engine');
  const { renderCurrentPage } = require('./viewer');
  const { renderThumbnails, toggleGridMode } = require('./thumbnails');
  const { renderBookmarks } = require('./bookmarks');

  const pdfjsCopy = arrayBuffer.slice(0); // pdfjs transfers the buffer
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

// ---- Recents ----
async function renderRecents() {
  let list = [];
  try { list = await ipcRenderer.invoke('recents:get'); } catch (_) {}
  // Filter to existing files
  const existing = [];
  for (const p of list) {
    try { await fs.promises.access(p, fs.constants.F_OK); existing.push(p); } catch (_) {}
  }
  const recentsEl = $('recents');
  const listEl = $('recentsList');
  listEl.innerHTML = '';
  if (existing.length === 0) {
    recentsEl.style.display = 'none';
    return;
  }
  recentsEl.style.display = '';
  for (const p of existing) listEl.appendChild(makeRecentItem(p));
}

function makeRecentItem(filePath) {
  const item = document.createElement('button');
  item.className = 'recent-item';
  item.title = filePath;

  const icon = document.createElement('span');
  icon.className = 'recent-icon';
  icon.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

  const info = document.createElement('span');
  info.className = 'recent-info';
  const name = document.createElement('span');
  name.className = 'recent-name';
  name.textContent = path.basename(filePath);
  const dir = document.createElement('span');
  dir.className = 'recent-dir';
  dir.textContent = path.dirname(filePath);
  info.append(name, dir);

  const remove = document.createElement('span');
  remove.className = 'recent-remove';
  remove.textContent = '×';
  remove.title = 'Remove from recents';
  remove.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await ipcRenderer.invoke('recents:remove', filePath); } catch (_) {}
    renderRecents();
  });

  item.append(icon, info, remove);
  item.addEventListener('click', () => openPdfFromPath(filePath));
  return item;
}

// Re-render recents whenever the welcome screen is shown
onScreenChange((id) => { if (id === 'welcome') renderRecents(); });

module.exports = { pickAndOpenPdf, openPdfFromPath, loadPdfBytes, renderRecents };
