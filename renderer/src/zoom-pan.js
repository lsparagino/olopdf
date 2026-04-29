'use strict';
// Zoom controls + pan + the canvas-wrap mousedown orchestration.
// Mousedown priority: pending text placement → text-layer span (browser selection) → pan.
const { $ } = require('./dom');
const { state, config } = require('./state');
const { renderCurrentPage } = require('./viewer');
const { placePendingTextAt, isEditorActive, drawTextOverlays } = require('./text');
const { gotoPage } = require('./pages');

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
// On each wheel tick we only CSS-resize the stage (keeping the previously rendered
// bitmap visible — momentarily blurry, but no flicker). The real bitmap re-render
// is debounced ~120ms after the last wheel event.
let zoomDebounceTimer = null;

// Capture the unscaled page size whenever a real render completes, so the
// CSS-only zoom path can compute target dimensions without re-asking pdf.js.
window.addEventListener('pdf:page-rendered', (e) => {
  if (e.detail && e.detail.viewport && e.detail.scale) {
    state.baseViewport = {
      width: e.detail.viewport.width / e.detail.scale,
      height: e.detail.viewport.height / e.detail.scale
    };
    state.renderedZoom = e.detail.scale;
  }
});

window.addEventListener('pdf:wheel-zoom', (e) => {
  state.fitMode = false;
  const step = config.WHEEL_ZOOM_STEP;
  state.zoom = e.detail.direction > 0
    ? clamp(state.zoom + step, config.ZOOM_MIN, config.ZOOM_MAX)
    : clamp(state.zoom - step, config.ZOOM_MIN, config.ZOOM_MAX);

  applyCssZoom();

  if (zoomDebounceTimer) clearTimeout(zoomDebounceTimer);
  zoomDebounceTimer = setTimeout(async () => {
    zoomDebounceTimer = null;
    await renderCurrentPage();          // crisp bitmap render once the burst settles
    $('textLayer').style.visibility = ''; // renderTextLayer rebuilt the spans
  }, 120);
});

function applyCssZoom() {
  if (!state.baseViewport) return;
  const w = state.baseViewport.width * state.zoom;
  const h = state.baseViewport.height * state.zoom;

  // Resize layout containers — canvas bitmap stays at its old resolution and
  // stretches via CSS (gets blurry until the debounced render runs).
  $('canvasStage').style.width = w + 'px';
  $('canvasStage').style.height = h + 'px';
  $('pdfCanvas').style.width = w + 'px';
  $('pdfCanvas').style.height = h + 'px';
  $('textOverlay').style.width = w + 'px';
  $('textOverlay').style.height = h + 'px';

  // The text-layer spans have absolute positions baked in at the rendered zoom;
  // hiding it avoids a visibly misaligned selection layer during the burst.
  $('textLayer').style.visibility = 'hidden';

  $('zoomLabel').textContent = Math.round(state.zoom * 100) + '%';

  // Placed-text overlays use state.zoom directly, so re-rendering them moves
  // them to the right spot without any bitmap work.
  drawTextOverlays();
}

// ---- Wheel scroll (within page) + page-flip at boundary ----
// In-page scrolling is left to the browser (compositor-thread smooth scroll —
// taking it over caused stutter on high-frequency wheel/trackpad input). We only
// intercept at the top/bottom edge to flip pages. A delta accumulator gates the
// flip so a single mouse tick (~100px deltaY) flips immediately, while a
// high-resolution wheel still produces one flip per real tick.
const FLIP_THRESHOLD = 30;
const OVERFLOW_TOLERANCE = 2;
let wheelAcc = 0;
let wheelDir = 0;
let isFlipping = false;

function normalizeWheelDelta(e) {
  if (e.deltaMode === 1) return e.deltaY * 16;     // lines → px
  if (e.deltaMode === 2) return e.deltaY * 600;    // pages → px
  return e.deltaY;
}

$('canvasWrap').addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) return;          // chrome.js handles zoom
  if (state.gridMode) return;                   // grid scrolls natively
  const wrap = e.currentTarget;
  const deltaY = normalizeWheelDelta(e);
  const dir = Math.sign(deltaY);
  if (!dir) return;

  const overflow = wrap.scrollHeight - wrap.clientHeight;
  const canScroll = overflow > OVERFLOW_TOLERANCE;
  const atTop = wrap.scrollTop <= 0;
  const atBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - OVERFLOW_TOLERANCE;
  const atEdge = (dir > 0 && atBottom) || (dir < 0 && atTop);

  if (canScroll && !atEdge) {
    wheelAcc = 0;
    return;                                     // native scroll handles it
  }

  // Page fully visible OR wheeling past the edge → flip page, with delta gating.
  e.preventDefault();
  if (isFlipping) return;
  if (wheelDir !== dir) { wheelDir = dir; wheelAcc = 0; }
  wheelAcc += Math.abs(deltaY);
  if (wheelAcc < FLIP_THRESHOLD) return;
  wheelAcc = 0;

  const target = state.currentPage + dir;
  if (target < 0 || target >= state.pageOrder.length) return;
  isFlipping = true;
  gotoPage(target).then(() => {
    const w = $('canvasWrap');
    if (dir < 0) w.scrollTop = Math.max(0, w.scrollHeight - w.clientHeight);
    else w.scrollTop = 0;
    isFlipping = false;
  }).catch(() => { isFlipping = false; });
}, { passive: false });

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
  // 1. Pending text placement — preventDefault so the browser doesn't reassign
  //    focus away from the contenteditable we just created and focused.
  if (state.pendingTextPlacement) {
    e.preventDefault();
    placePendingTextAt(e.clientX, e.clientY);
    return;
  }
  // 2. Inline text editor open: don't preventDefault — let the click blur the
  //    editor so it commits cleanly. Also skip pan.
  if (isEditorActive()) return;
  // 3. Click on a span inside text-layer → text selection wins
  const layer = $('textLayer');
  if (layer && layer !== e.target && layer.contains(e.target)) return;
  // 4. Otherwise pan (only if there's actual scroll overflow)
  startPan(e);
});

module.exports = { startPan };
