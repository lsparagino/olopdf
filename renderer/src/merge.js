'use strict';
// Merge mode: drag-and-drop list of PDFs, drag-reorder, then output a merged PDF.
const path = require('path');
const fs = require('fs');
const { ipcRenderer } = require('electron');
const { PDFDocument } = require('pdf-lib');
const { $, toast, showLoading, hideLoading, showScreen } = require('./dom');
const { state } = require('./state');
const { formatBytes, arrayBufferFromBuffer } = require('./util');

const mergeBody = $('mergeBody');
const mergeList = $('mergeList');

// Accept dropped PDFs onto the merge body
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
    state.mergeFiles.push({ name: f.name, bytes: arrayBufferFromBuffer(buf) });
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
    state.mergeFiles.push({ name: path.basename(fp), bytes: arrayBufferFromBuffer(buf) });
  }
  renderMergeList();
});

$('mergeBackBtn').addEventListener('click', () => showScreen('welcome'));

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

module.exports = { renderMergeList };
