'use strict';
// Canvas + text-layer rendering. Pure rendering, no event wiring.
const { $ } = require('./dom');
const { state, config } = require('./state');
const { pdfjsLib } = require('./pdf-engine');

async function renderCurrentPage() {
  if (!state.pdfjsDoc || state.pageOrder.length === 0) return;
  if (state.currentPage >= state.pageOrder.length) state.currentPage = state.pageOrder.length - 1;
  if (state.currentPage < 0) state.currentPage = 0;

  const origIdx = state.pageOrder[state.currentPage];
  const page = await state.pdfjsDoc.getPage(origIdx + 1);

  const wrap = $('canvasWrap');
  const baseViewport = page.getViewport({ scale: 1 });
  let scale = state.zoom;
  if (state.fitMode) {
    const aw = wrap.clientWidth - config.CANVAS_PADDING;
    const ah = wrap.clientHeight - config.CANVAS_PADDING;
    scale = Math.min(aw / baseViewport.width, ah / baseViewport.height);
    if (!isFinite(scale) || scale <= 0) scale = 1.0;
    state.zoom = scale;
  }

  const viewport = page.getViewport({ scale });
  const canvas = $('pdfCanvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = viewport.width + 'px';
  canvas.style.height = viewport.height + 'px';

  const stage = $('canvasStage');
  stage.style.width = viewport.width + 'px';
  stage.style.height = viewport.height + 'px';

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (state.renderTask) {
    try { state.renderTask.cancel(); } catch (_) {}
  }
  state.renderTask = page.render({ canvasContext: ctx, viewport });
  try { await state.renderTask.promise; } catch (_) {}
  state.renderTask = null;

  $('curPage').textContent = state.currentPage + 1;
  $('zoomLabel').textContent = Math.round(state.zoom * 100) + '%';

  await renderTextLayer(page, viewport);

  // Notify other modules (text-overlay, thumb highlight) without creating a dep cycle.
  window.dispatchEvent(new CustomEvent('pdf:page-rendered', { detail: { viewport, scale } }));
}

// Manual text layer — full control of styles so user-select is never blocked upstream.
async function renderTextLayer(page, viewport) {
  const layer = $('textLayer');
  layer.innerHTML = '';
  layer.style.width = viewport.width + 'px';
  layer.style.height = viewport.height + 'px';
  try {
    const textContent = await page.getTextContent();
    const styles = textContent.styles || {};
    const fragment = document.createDocumentFragment();
    for (const item of textContent.items) {
      if (!item.str) continue;
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const angle = Math.atan2(tx[1], tx[0]);
      const fontHeight = Math.hypot(tx[2], tx[3]);
      if (fontHeight <= 0) continue;
      const span = document.createElement('span');
      span.textContent = item.str;
      span.style.left = `${tx[4]}px`;
      span.style.top = `${tx[5] - fontHeight}px`;
      span.style.fontSize = `${fontHeight}px`;
      const family = (styles[item.fontName] && styles[item.fontName].fontFamily) || 'sans-serif';
      span.style.fontFamily = family;
      if (angle !== 0) span.style.transform = `rotate(${angle}rad)`;
      fragment.appendChild(span);
    }
    layer.appendChild(fragment);
  } catch (e) {
    console.warn('Text layer render failed', e);
  }
}

module.exports = { renderCurrentPage, renderTextLayer };
