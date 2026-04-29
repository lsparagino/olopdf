'use strict';
// Window chrome: titlebar buttons, global zoom intercept, escape, modal background close.
// All three layers of zoom defense live here (renderer side); main.js has its counterparts.
const { ipcRenderer, webFrame } = require('electron');
const { $, closeAllModals } = require('./dom');
const { state } = require('./state');

// Layer 1 — disable visual (pinch) zoom and lock the renderer's base factor.
try {
  webFrame.setZoomFactor(1);
  webFrame.setVisualZoomLevelLimits(1, 1);
} catch (_) {}

// Window control buttons
$('winMin').addEventListener('click', () => ipcRenderer.send('win:min'));
$('winMax').addEventListener('click', () => ipcRenderer.send('win:max'));
$('winClose').addEventListener('click', () => ipcRenderer.send('win:close'));

// Don't let dropped files navigate the window away from the app
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// Layer 2 — capture-phase intercept of Ctrl+= / Ctrl+- / Ctrl+0 and Ctrl+wheel.
// Re-routed to the visible PDF zoom buttons (they're wired up by zoom-pan.js).
function inEditorActive() {
  return $('editor').classList.contains('active') && !state.gridMode;
}

window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (!['+', '=', '-', '_', '0'].includes(e.key)) return;
  e.preventDefault();
  e.stopPropagation();
  if (!inEditorActive()) return;
  if (e.key === '0') $('zoomFit').click();
  else if (e.key === '-' || e.key === '_') $('zoomOut').click();
  else $('zoomIn').click();
}, { capture: true });

window.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  e.stopPropagation();
  if (!inEditorActive()) return;
  // Dispatch a custom event so zoom-pan.js can apply the wheel-specific finer step
  window.dispatchEvent(new CustomEvent('pdf:wheel-zoom', { detail: { direction: e.deltaY < 0 ? 1 : -1 } }));
}, { capture: true, passive: false });

// Modal background click closes
document.querySelectorAll('.modal').forEach(m => {
  m.addEventListener('click', (e) => {
    if (e.target === m) m.classList.remove('open');
  });
});

// Escape: closes any open modal, cancels pending text placement, cancels inline editor
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeAllModals();
  if (state.pendingTextPlacement) {
    state.pendingTextPlacement = null;
    $('canvasWrap').classList.remove('placing-text');
  }
  try { require('./text').cancelActiveTextEditor(); } catch (_) {}
});
