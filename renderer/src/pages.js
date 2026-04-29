'use strict';
// Page state mutations: navigate, delete, move. Triggers re-renders.
const { $, toast } = require('./dom');
const { state } = require('./state');
const { renderCurrentPage } = require('./viewer');
const { renderThumbnails, renderGridView, toggleGridMode } = require('./thumbnails');

function gotoPage(uiIdx) {
  if (uiIdx < 0 || uiIdx >= state.pageOrder.length) return;
  state.currentPage = uiIdx;
  return renderCurrentPage();
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
  // Tell bookmarks (and anyone else) to refresh
  window.dispatchEvent(new CustomEvent('pdf:bookmarks-changed'));
  toast('Page removed');
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
  // Bookmark display order tracks page order — refresh the sidebar.
  window.dispatchEvent(new CustomEvent('pdf:bookmarks-changed'));
}

// Wire page navigation buttons
$('prevPage').addEventListener('click', () => gotoPage(state.currentPage - 1));
$('nextPage').addEventListener('click', () => gotoPage(state.currentPage + 1));

// Keyboard navigation (only inside the editor screen, not while typing)
window.addEventListener('keydown', (e) => {
  if (!$('editor').classList.contains('active')) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.target.isContentEditable) return;          // inline text/bookmark editor
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') $('prevPage').click();
  else if (e.key === 'ArrowRight' || e.key === 'PageDown') $('nextPage').click();
});

// Re-fit on window resize while in fit-mode
let resizeRaf = null;
window.addEventListener('resize', () => {
  if (!$('editor').classList.contains('active')) return;
  if (state.gridMode || !state.fitMode) return;
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(renderCurrentPage);
});

module.exports = { gotoPage, deletePage, movePage };
