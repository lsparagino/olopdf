'use strict';
// Floating action bar that appears above a text selection in the canvas.
// Buttons: copy, add bookmark.
const { $, toast, onScreenChange } = require('./dom');

const toolbar = document.createElement('div');
toolbar.className = 'selection-toolbar';
toolbar.innerHTML = `
  <button type="button" class="sel-btn sel-copy" title="Copy">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    </svg>
  </button>
  <button type="button" class="sel-btn sel-bookmark" title="Add bookmark">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
    </svg>
  </button>
`;
document.body.appendChild(toolbar);

let lastSelectionText = '';

function getCanvasSelection() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const layer = $('textLayer');
  if (!layer || !layer.contains(range.startContainer)) return null;
  const text = sel.toString().trim();
  if (!text) return null;
  return { range, text };
}

function showAtSelection() {
  const s = getCanvasSelection();
  if (!s) { hide(); return; }
  const rect = s.range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) { hide(); return; }

  lastSelectionText = s.text;
  toolbar.classList.add('visible');

  // Measure after making visible so offsetWidth/Height are accurate.
  const tw = toolbar.offsetWidth;
  const th = toolbar.offsetHeight;
  let left = rect.left + rect.width / 2;
  let top = rect.top - th - 10;
  if (top < 8) top = rect.bottom + 10;
  // Keep within viewport horizontally.
  const minLeft = 8 + tw / 2;
  const maxLeft = window.innerWidth - 8 - tw / 2;
  if (left < minLeft) left = minLeft;
  if (left > maxLeft) left = maxLeft;
  toolbar.style.left = left + 'px';
  toolbar.style.top = top + 'px';
}

function hide() {
  toolbar.classList.remove('visible');
  lastSelectionText = '';
}

// Show only after the user finishes a drag-select — selectionchange fires
// continuously during the drag and would make the bar flicker mid-selection.
document.addEventListener('mouseup', () => {
  setTimeout(showAtSelection, 0);
});

// Hide as soon as the selection collapses (click elsewhere, Esc, etc).
document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) hide();
});

// Hide on canvas scroll / page change — easier than re-positioning during scroll.
$('canvasWrap').addEventListener('scroll', hide);
window.addEventListener('pdf:page-rendered', hide);
onScreenChange((id) => { if (id !== 'editor') hide(); });

// Don't let the toolbar steal focus / collapse the selection on click.
toolbar.addEventListener('mousedown', (e) => e.preventDefault());

toolbar.querySelector('.sel-copy').addEventListener('click', async () => {
  const text = lastSelectionText;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch (_) {
    toast('Copy failed', 'error');
  }
  hide();
});

toolbar.querySelector('.sel-bookmark').addEventListener('click', () => {
  // Reuse the existing bookmark flow — the button's own handler captures the
  // current selection, so we just trigger it. Selection is preserved because
  // our toolbar's mousedown preventDefault'd.
  $('addBookmarkBtn').click();
  hide();
});
