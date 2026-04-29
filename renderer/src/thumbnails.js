'use strict';
// Sidebar thumbnails + main-area grid view. DRY drag/drop helper shared by both.
const { $, toast } = require('./dom');
const { state, config } = require('./state');

// ---- Generic page-thumb item drag/drop (vertical or horizontal) ----
let dragSrcIdx = null;
function makeDragHandlers(containerSel, itemSel, axis = 'y') {
  return function setupDrag(el) {
    el.addEventListener('dragstart', (e) => {
      dragSrcIdx = parseInt(el.dataset.uiIdx, 10);
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(dragSrcIdx)); } catch (_) {}
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      document.querySelectorAll(itemSel).forEach(t => t.classList.remove('drop-before', 'drop-after'));
      dragSrcIdx = null;
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = el.getBoundingClientRect();
      const before = axis === 'x' ? (e.clientX - r.left) < r.width / 2
                                  : (e.clientY - r.top)  < r.height / 2;
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
      const before = axis === 'x' ? (e.clientX - r.left) < r.width / 2
                                  : (e.clientY - r.top)  < r.height / 2;
      const dest = before ? tgt : tgt + 1;
      // Lazy require to avoid module cycle
      const { movePage } = require('./pages');
      movePage(src, dest);
    });
  };
}

const setupSidebarDrag = makeDragHandlers('#pageList', '.page-thumb', 'y');
const setupGridDrag    = makeDragHandlers('#gridView', '.grid-item', 'x');

// ---- Rendering a single thumb canvas (shared by sidebar + grid) ----
async function paintThumb(canvas, origIdx, targetWidth) {
  const wrap = canvas.parentElement;
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
    const scale = targetWidth / vp1.width;
    const viewport = page.getViewport({ scale });
    const w = Math.floor(viewport.width);
    const h = Math.floor(viewport.height);
    canvas.width = w;
    canvas.height = h;
    if (wrap) wrap.style.aspectRatio = `${w} / ${h}`;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    state.thumbCache.set(origIdx, canvas.toDataURL('image/png'));
  } catch (_) { /* ignore */ }
}

// ---- Build a thumb element (DRY for sidebar + grid) ----
function buildThumb({ wrapClass, numClass, delClass, uiIdx, onClick, onDelete, onDoubleClick, setupDrag }) {
  const el = document.createElement('div');
  el.className = wrapClass;
  el.draggable = true;
  el.dataset.uiIdx = uiIdx;

  const canvas = document.createElement('canvas');
  el.appendChild(canvas);

  const num = document.createElement('div');
  num.className = numClass;
  num.textContent = uiIdx + 1;
  el.appendChild(num);

  const del = document.createElement('button');
  del.className = delClass;
  del.textContent = '×';
  del.title = 'Delete page';
  del.addEventListener('click', (e) => { e.stopPropagation(); onDelete(parseInt(el.dataset.uiIdx, 10)); });
  el.appendChild(del);

  if (onClick) el.addEventListener('click', () => onClick(parseInt(el.dataset.uiIdx, 10)));
  if (onDoubleClick) el.addEventListener('dblclick', () => onDoubleClick(parseInt(el.dataset.uiIdx, 10)));
  setupDrag(el);
  return { el, canvas };
}

// ---- Sidebar thumbnails ----
function renderThumbnails() {
  const list = $('pageList');
  list.innerHTML = '';
  const { gotoPage, deletePage } = require('./pages');
  for (let i = 0; i < state.pageOrder.length; i++) {
    const origIdx = state.pageOrder[i];
    const { el, canvas } = buildThumb({
      wrapClass: 'page-thumb',
      numClass: 'page-thumb-num',
      delClass: 'page-thumb-del',
      uiIdx: i,
      onClick: (ui) => {
        if (state.gridMode) toggleGridMode(false);
        gotoPage(ui);
      },
      onDelete: deletePage,
      setupDrag: setupSidebarDrag
    });
    list.appendChild(el);
    paintThumb(canvas, origIdx, config.THUMB_TARGET_WIDTH);
  }
  highlightActiveThumb();
}

// ---- Grid reorder view ----
function renderGridView() {
  const grid = $('gridView');
  grid.innerHTML = '';
  const { gotoPage, deletePage } = require('./pages');
  for (let i = 0; i < state.pageOrder.length; i++) {
    const origIdx = state.pageOrder[i];
    const { el, canvas } = buildThumb({
      wrapClass: 'grid-item',
      numClass: 'grid-item-num',
      delClass: 'grid-item-del',
      uiIdx: i,
      onDelete: deletePage,
      onDoubleClick: (ui) => { toggleGridMode(false); gotoPage(ui); },
      setupDrag: setupGridDrag
    });
    grid.appendChild(el);
    paintThumb(canvas, origIdx, config.GRID_THUMB_TARGET_WIDTH);
  }
  highlightActiveThumb();
}

function highlightActiveThumb() {
  document.querySelectorAll('.page-thumb, .grid-item').forEach((t) => {
    const ui = parseInt(t.dataset.uiIdx, 10);
    t.classList.toggle('active', ui === state.currentPage);
  });
}

// ---- Grid mode toggle ----
function toggleGridMode(force) {
  const next = (typeof force === 'boolean') ? force : !state.gridMode;
  state.gridMode = next;
  $('canvasWrap').classList.toggle('grid-mode', next);
  $('reorderBtn').classList.toggle('toggled', next);
  $('reorderLabel').textContent = next ? 'Done' : 'Reorder';
  if (next) renderGridView();
}

// Wire the toolbar reorder button
$('reorderBtn').addEventListener('click', () => toggleGridMode());

// Re-highlight active thumb whenever a page is rendered
window.addEventListener('pdf:page-rendered', highlightActiveThumb);

module.exports = { renderThumbnails, renderGridView, highlightActiveThumb, toggleGridMode };
