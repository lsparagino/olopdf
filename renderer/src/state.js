'use strict';

// Single source of truth. Mutated in place by feature modules.
const state = {
  filePath: null,            // currently-open file path
  pdfBytes: null,            // ArrayBuffer of original (immutable)
  pdfjsDoc: null,            // pdf.js doc (rendering)
  pageOrder: [],             // current page order (array of original indices)
  bookmarks: [],             // [{ title, pageOriginalIdx, x?, y? }]
  textAnnotations: [],       // [{ pageOriginalIdx, x, y, text, size, color, font, bold, italic, underline }]
  repeatTexts: [],           // header/footer texts (no page index — applied to every page)
  currentPage: 0,            // index into pageOrder
  zoom: 1.0,
  fitMode: true,
  thumbCache: new Map(),     // origIdx -> dataURL
  baseViewport: null,        // unscaled width/height of the current page (for CSS-only zoom)
  renderedZoom: null,        // the zoom at which the current canvas bitmap was rendered
  renderTask: null,
  pendingTextPlacement: null,
  capturedSelection: null,   // selection captured for the next bookmark
  gridMode: false,
  mergeFiles: []             // merge screen list
};

const config = Object.freeze({
  CURATOR_URL: 'https://olopad.com',
  THUMB_TARGET_WIDTH: 240,
  GRID_THUMB_TARGET_WIDTH: 360,
  RECENTS_LIMIT: 5,
  ZOOM_STEP: 0.15,
  WHEEL_ZOOM_STEP: 0.1,
  ZOOM_MIN: 0.2,
  ZOOM_MAX: 5,
  CANVAS_PADDING: 48,
  TEXT_DRAG_THRESHOLD_PX: 2,
  TOAST_DURATION_MS: 2400
});

module.exports = { state, config };
