'use strict';
// Bookmark modal + sidebar list + selection capture (anchored bookmarks).
const { $, toast, openModal, closeModal } = require('./dom');
const { state } = require('./state');
const { gotoPage } = require('./pages');

// Capture a text selection inside the canvas-stage so the bookmark anchors to it.
function captureCanvasSelection() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const stage = $('canvasStage');
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

// ---- Modal wiring ----
$('addBookmarkBtn').addEventListener('click', () => {
  const sel = captureCanvasSelection();
  state.capturedSelection = sel;
  $('bookmarkTitle').value = sel ? sel.text.slice(0, 80) : '';
  $('bmPage').textContent = state.currentPage + 1;
  $('bmHint').innerHTML = sel
    ? `Anchored to selected text on page <span id="bmPage">${state.currentPage + 1}</span>.`
    : `Tip: select text on the page first to anchor the bookmark to it. Otherwise it will point to page <span id="bmPage">${state.currentPage + 1}</span>.`;
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

    item.append(titleEl, pg, del);
    item.addEventListener('click', () => gotoBookmark(b));
    list.appendChild(item);
  });
}

async function gotoBookmark(b) {
  const uiPage = state.pageOrder.indexOf(b.pageOriginalIdx);
  if (uiPage < 0) return;
  if (state.gridMode) {
    const { toggleGridMode } = require('./thumbnails');
    toggleGridMode(false);
  }
  await gotoPage(uiPage);
  if (b.x !== undefined && b.y !== undefined) {
    const wrap = $('canvasWrap');
    wrap.scrollTo({
      left: Math.max(0, b.x * state.zoom - 60),
      top:  Math.max(0, b.y * state.zoom - 60),
      behavior: 'smooth'
    });
  }
}

// Refresh after page operations (e.g. delete page may purge bookmarks)
window.addEventListener('pdf:bookmarks-changed', renderBookmarks);

module.exports = { renderBookmarks };
