'use strict';
// Zoom controls + pan + the canvas-wrap mousedown orchestration.
// Mousedown priority: pending text placement → text-layer span (browser selection) → pan.
const { $ } = require('./dom');
const { state, config } = require('./state');
const { renderCurrentPage } = require('./viewer');
const { placePendingTextAt } = require('./text');

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---- Zoom buttons ----
$('zoomIn').addEventListener('click', () => {
  state.fitMode = false;
  state.zoom = clamp(state.zoom + config.ZOOM_STEP, config.ZOOM_MIN, config.ZOOM_MAX);
  renderCurrentPage();
});
$('zoomOut').addEventListener('click', () => {
  state.fitMode = false;
  state.zoom = clamp(state.zoom - config.ZOOM_STEP, config.ZOOM_MIN, config.ZOOM_MAX);
  renderCurrentPage();
});
$('zoomFit').addEventListener('click', () => {
  state.fitMode = true;
  renderCurrentPage();
});

// ---- Wheel zoom (finer step than buttons; emitted by chrome.js) ----
window.addEventListener('pdf:wheel-zoom', (e) => {
  state.fitMode = false;
  const step = config.WHEEL_ZOOM_STEP;
  state.zoom = e.detail.direction > 0
    ? clamp(state.zoom + step, config.ZOOM_MIN, config.ZOOM_MAX)
    : clamp(state.zoom - step, config.ZOOM_MIN, config.ZOOM_MAX);
  renderCurrentPage();
});

// ---- Pan ----
function startPan(e) {
  const wrap = $('canvasWrap');
  const stage = $('canvasStage');
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

// ---- Single mousedown handler for the canvas-wrap (the orchestrator) ----
$('canvasWrap').addEventListener('mousedown', (e) => {
  if (e.button !== 0 || state.gridMode) return;
  // 1. Pending text placement
  if (state.pendingTextPlacement) {
    placePendingTextAt(e.clientX, e.clientY);
    return;
  }
  // 2. Click on a span inside text-layer → text selection wins
  const layer = $('textLayer');
  if (layer && layer !== e.target && layer.contains(e.target)) return;
  // 3. Otherwise pan (only if there's actual scroll overflow)
  startPan(e);
});

module.exports = { startPan };
