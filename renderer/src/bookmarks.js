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

// Keep state.bookmarks ordered by their position in the document so both the
// sidebar and the saved PDF outline reflect reading order.
function sortBookmarks() {
  state.bookmarks.sort((a, b) => {
    const pa = state.pageOrder.indexOf(a.pageOriginalIdx);
    const pb = state.pageOrder.indexOf(b.pageOriginalIdx);
    if (pa !== pb) return pa - pb;
    const ya = a.y ?? 0, yb = b.y ?? 0;
    if (ya !== yb) return ya - yb;
    return (a.x ?? 0) - (b.x ?? 0);
  });
}

function renderBookmarks() {
  sortBookmarks();
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

    const edit = document.createElement('button');
    edit.className = 'bm-edit';
    edit.title = 'Rename';
    edit.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      startEditTitle(item, titleEl, b);
    });

    const del = document.createElement('button');
    del.className = 'bm-del';
    del.textContent = '×';
    del.title = 'Remove';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      state.bookmarks.splice(i, 1);
      renderBookmarks();
    });

    item.append(titleEl, pg, edit, del);
    item.addEventListener('click', () => gotoBookmark(b));
    item.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startEditTitle(item, titleEl, b);
    });
    list.appendChild(item);
  });
}

function startEditTitle(item, titleEl, bookmark) {
  if (item.classList.contains('editing')) return;
  item.classList.add('editing');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'bm-title-input';
  input.value = bookmark.title;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) {
      const next = input.value.trim();
      if (next && next !== bookmark.title) bookmark.title = next;
    }
    renderBookmarks();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
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
