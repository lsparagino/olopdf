'use strict';
// Compare mode: load two PDFs, diff them per page, render side-by-side
// with highlight overlays and connector lines. Two diff modes:
//   - Text only (default): LCS over text items → grouped hunks
//   - Visual: tile-based pixel SAD → merged rectangles
const path = require('path');
const { ipcRenderer } = require('electron');
const { $, toast, showLoading, hideLoading, showScreen } = require('./dom');
const { state, config } = require('./state');
const { readFileAsArrayBuffer } = require('./util');
const { pdfjsLib } = require('./pdf-engine');

const SVG_NS = 'http://www.w3.org/2000/svg';

// ---- Element refs (computed lazily so this file can require freely) ----
const els = () => ({
  body:        $('compareBody'),
  leftPane:    $('compareLeftPane'),
  rightPane:   $('compareRightPane'),
  leftHeader:  $('compareLeftHeader'),
  rightHeader: $('compareRightHeader'),
  leftStatus:  $('compareLeftStatus'),
  rightStatus: $('compareRightStatus'),
  leftStage:   $('compareLeftStage'),
  rightStage:  $('compareRightStage'),
  leftCanvas:  $('compareLeftCanvas'),
  rightCanvas: $('compareRightCanvas'),
  leftOverlay: $('compareLeftOverlay'),
  rightOverlay:$('compareRightOverlay'),
  leftWrap:    $('compareLeftWrap'),
  rightWrap:   $('compareRightWrap'),
  leftEmpty:   $('compareLeftEmpty'),
  rightEmpty:  $('compareRightEmpty'),
  runBtn:      $('compareRunBtn'),
  swapBtn:     $('compareSwapBtn'),
  textOnly:    $('compareTextOnly'),
  summary:     $('compareSummary'),
  addedCount:  $('compareAddedCount'),
  removedCount:$('compareRemovedCount'),
  changedPages:$('compareChangedPages'),
  prevDiffBtn: $('comparePrevDiffBtn'),
  nextDiffBtn: $('compareNextDiffBtn'),
  nav:         $('compareNav'),
  curPage:     $('compareCurPage'),
  totalPages:  $('compareTotalPages'),
  zoomLabel:   $('compareZoomLabel'),
  connectors:  $('compareConnectors'),
});

// Module-local rendering state — current scale per pane, current hunk cursor.
let leftScale = 1, rightScale = 1;
let currentHunkIdx = -1;          // index into the flattened hunk list
let connectorRafPending = false;  // dedupe rAF redraws under fast scroll
function scheduleDrawConnectors() {
  if (connectorRafPending) return;
  connectorRafPending = true;
  requestAnimationFrame(() => { connectorRafPending = false; drawConnectors(); });
}

// ---- Top-level event wiring ----
$('compareBackBtn').addEventListener('click', () => showScreen('welcome'));

setupPaneDropZone('left',  els().leftWrap);
setupPaneDropZone('right', els().rightWrap);

$('compareSwapBtn').addEventListener('click', () => {
  const c = state.compare;
  if (!c.left || !c.right) return;
  [c.left, c.right] = [c.right, c.left];
  c.diffs = [];
  currentHunkIdx = -1;
  refreshPaneState();
  els().summary.style.display = 'none';
  els().nav.style.display = 'none';
  clearOverlay('left'); clearOverlay('right');
  drawConnectors();
  // Re-render previews with the swapped sides
  renderSidePreview('left');
  renderSidePreview('right');
});

els().textOnly.addEventListener('change', () => {
  state.compare.textOnly = els().textOnly.checked;
  // Any prior diff was computed for the other mode — invalidate it.
  state.compare.diffs = [];
  currentHunkIdx = -1;
  els().summary.style.display = 'none';
  els().nav.style.display = 'none';
  clearOverlay('left'); clearOverlay('right');
  drawConnectors();
});

els().runBtn.addEventListener('click', runCompare);
els().prevDiffBtn.addEventListener('click', () => jumpDiff(-1));
els().nextDiffBtn.addEventListener('click', () => jumpDiff(+1));
$('comparePrevPage').addEventListener('click', () => gotoPage(state.compare.currentPage - 1));
$('compareNextPage').addEventListener('click', () => gotoPage(state.compare.currentPage + 1));
$('compareZoomIn').addEventListener('click',  () => stepZoom(+1));
$('compareZoomOut').addEventListener('click', () => stepZoom(-1));
$('compareZoomFit').addEventListener('click', () => { state.compare.fitMode = true; renderComparePage(); });

// Re-fit + redraw connectors on resize while compare screen is active.
window.addEventListener('resize', () => {
  if (!$('compare').classList.contains('active')) return;
  if (state.compare.fitMode) renderComparePage();
  else drawConnectors();
});

// Synced vertical scroll between the two panes. Proportional so pages of
// different lengths still anchor cleanly at top/bottom.
(function setupScrollSync() {
  const lw = els().leftWrap, rw = els().rightWrap;
  if (!lw || !rw) return;
  let syncing = false;
  const onScroll = (src, dst) => {
    if (!syncing) {
      syncing = true;
      const srcMax = Math.max(1, src.scrollHeight - src.clientHeight);
      const dstMax = Math.max(0, dst.scrollHeight - dst.clientHeight);
      dst.scrollTop = (src.scrollTop / srcMax) * dstMax;
      requestAnimationFrame(() => { syncing = false; });
    }
    scheduleDrawConnectors();
  };
  lw.addEventListener('scroll', () => onScroll(lw, rw), { passive: true });
  rw.addEventListener('scroll', () => onScroll(rw, lw), { passive: true });
})();

// Keyboard nav while compare screen is active.
window.addEventListener('keydown', (e) => {
  if (!$('compare').classList.contains('active')) return;
  if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === 'ArrowLeft' || e.key === 'PageUp')   gotoPage(state.compare.currentPage - 1);
  if (e.key === 'ArrowRight' || e.key === 'PageDown') gotoPage(state.compare.currentPage + 1);
});

// ---- Pane-as-dropzone (replaces the old picker row) ----
function setupPaneDropZone(side, wrap) {
  // Click inside the wrap (only when in empty state) opens the file picker.
  wrap.addEventListener('click', (e) => {
    const pane = els()[side + 'Pane'];
    if (!pane.classList.contains('empty')) return;     // ignore clicks once loaded
    e.stopPropagation();
    pickFile(side);
  });
  ['dragenter', 'dragover'].forEach(ev =>
    wrap.addEventListener(ev, (e) => {
      const pane = els()[side + 'Pane'];
      if (!pane.classList.contains('empty')) return;   // only react when empty
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault(); e.stopPropagation();
        wrap.classList.add('dragover');
      }
    })
  );
  ['dragleave', 'drop'].forEach(ev =>
    wrap.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); wrap.classList.remove('dragover'); })
  );
  wrap.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation();
    wrap.classList.remove('dragover');
    const file = e.dataTransfer && e.dataTransfer.files && Array.from(e.dataTransfer.files)
      .find(f => f.name.toLowerCase().endsWith('.pdf'));
    if (!file) return;
    await loadPdfForSide(side, file.path);
  });
}

async function pickFile(side) {
  const r = await ipcRenderer.invoke('dialog:open', {
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (r.canceled || r.filePaths.length === 0) return;
  await loadPdfForSide(side, r.filePaths[0]);
}

async function loadPdfForSide(side, filePath) {
  try {
    showLoading('Loading ' + path.basename(filePath) + '...');
    const ab = await readFileAsArrayBuffer(filePath);
    const data = ab.slice(0); // pdf.js transfers the buffer
    const doc = await pdfjsLib.getDocument({ data }).promise;
    state.compare[side] = { name: path.basename(filePath), filePath, doc, numPages: doc.numPages };
    state.compare.diffs = [];
    state.compare.currentPage = 0;
    currentHunkIdx = -1;
    refreshPaneState();
    els().summary.style.display = 'none';
    els().nav.style.display = 'none';
    drawConnectors();
    await renderSidePreview(side);
  } catch (err) {
    console.error(err);
    toast('Failed to load PDF: ' + err.message, 'error');
  } finally {
    hideLoading();
  }
}

function refreshPaneState() {
  const c = state.compare;
  const e = els();
  e.leftPane.classList.toggle('empty',  !c.left);
  e.rightPane.classList.toggle('empty', !c.right);
  e.leftHeader.textContent  = c.left  ? c.left.name  : 'Original';
  e.rightHeader.textContent = c.right ? c.right.name : 'Revised';
  e.runBtn.disabled = !(c.left && c.right);
  e.swapBtn.disabled = !(c.left && c.right);
  e.leftStatus.style.display  = c.left  ? '' : 'none';
  e.rightStatus.style.display = c.right ? '' : 'none';
}

// Quick render of one side's first page so the user gets immediate feedback.
async function renderSidePreview(side) {
  const meta = state.compare[side];
  if (!meta) return;
  const page = await meta.doc.getPage(1);
  await renderPageToCanvas(page, side);
  clearOverlay(side);
}

// =============================================================================
// Diff computation
// =============================================================================

async function runCompare() {
  const c = state.compare;
  if (!c.left || !c.right) return;
  c.textOnly = els().textOnly.checked;
  const max = Math.max(c.left.numPages, c.right.numPages);
  showLoading(c.textOnly ? 'Comparing text...' : 'Comparing visually...');
  try {
    const diffs = new Array(max);
    for (let i = 0; i < max; i++) {
      if (i % 3 === 0) await new Promise(r => setTimeout(r, 0));   // yield to UI
      const lp = i < c.left.numPages  ? await c.left.doc.getPage(i + 1)  : null;
      const rp = i < c.right.numPages ? await c.right.doc.getPage(i + 1) : null;
      diffs[i] = c.textOnly ? await diffPageText(lp, rp) : await diffPageVisual(lp, rp);
    }
    c.diffs = diffs;
    currentHunkIdx = -1;
    updateSummary();
    els().summary.style.display = '';
    els().nav.style.display = '';
    els().totalPages.textContent = max;
    const firstChanged = diffs.findIndex(d => d && d.changed);
    await gotoPage(firstChanged >= 0 ? firstChanged : 0);
  } catch (err) {
    console.error(err);
    toast('Compare failed: ' + err.message, 'error');
  } finally {
    hideLoading();
  }
}

// --- Text diff: extract per-item text + position, run LCS, group into hunks ---
async function pageTextItems(page) {
  if (!page) return null;
  const viewport = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const items = [];
  for (const it of tc.items) {
    if (!it.str) continue;
    const tx = pdfjsLib.Util.transform(viewport.transform, it.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    if (fontHeight <= 0) continue;
    const left = tx[4];
    const top  = tx[5] - fontHeight;
    const w = (it.width || it.str.length * fontHeight * 0.5) * viewport.scale;
    items.push({
      str: it.str,
      norm: it.str.replace(/\s+/g, ' ').trim(),
      x: left, y: top, w, h: fontHeight
    });
  }
  return { items, baseW: viewport.width, baseH: viewport.height };
}

async function diffPageText(leftPage, rightPage) {
  const ld = await pageTextItems(leftPage);
  const rd = await pageTextItems(rightPage);
  if (!ld && !rd) return emptyDiff();
  if (!ld) return wholePageDiff(rd, 'right');
  if (!rd) return wholePageDiff(ld, 'left');

  const L = ld.items, R = rd.items;
  const Ln = L.map(i => i.norm), Rn = R.map(i => i.norm);

  const hunks = (L.length > config.COMPARE_TEXT_LCS_LIMIT || R.length > config.COMPARE_TEXT_LCS_LIMIT)
    ? setDiffHunks(L, R, Ln, Rn)
    : lcsDiffHunks(L, R, Ln, Rn);

  return assembleDiff(hunks, ld, rd, !!leftPage, !!rightPage);
}

// Backward LCS walk that groups consecutive non-equal moves into hunks.
// We collect in reverse, then reverse everything for natural top-down order.
function lcsDiffHunks(L, R, Ln, Rn) {
  const n = L.length, m = R.length;
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (Ln[i - 1] && Ln[i - 1] === Rn[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const hunks = [];
  let cur = null;
  let i = n, j = m;
  const closeHunk = () => {
    if (!cur) return;
    cur.leftBoxes.reverse();
    cur.rightBoxes.reverse();
    if (cur.leftBoxes.length || cur.rightBoxes.length) hunks.push(cur);
    cur = null;
  };
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && Ln[i - 1] && Ln[i - 1] === Rn[j - 1]) {
      closeHunk();
      i--; j--;
    } else {
      if (!cur) cur = { leftBoxes: [], rightBoxes: [] };
      const goRemove = j === 0 || (i > 0 && dp[i - 1][j] >= dp[i][j - 1]);
      if (goRemove) {
        if (Ln[i - 1]) cur.leftBoxes.push(itemBox(L[i - 1], 'removed'));
        i--;
      } else {
        if (Rn[j - 1]) cur.rightBoxes.push(itemBox(R[j - 1], 'added'));
        j--;
      }
    }
  }
  closeHunk();
  hunks.reverse();
  for (const h of hunks) h.kind = hunkKind(h);
  return hunks;
}

// Multiset diff fallback for very large pages — loses ordering nuance, so we
// emit one removed-only hunk and one added-only hunk (no visual pairing).
function setDiffHunks(L, R, Ln, Rn) {
  const counts = new Map();
  for (const s of Ln) if (s) counts.set(s, (counts.get(s) || 0) + 1);
  const addedIdx = [];
  for (let j = 0; j < Rn.length; j++) {
    const s = Rn[j];
    if (!s) continue;
    const c = counts.get(s) || 0;
    if (c > 0) counts.set(s, c - 1);
    else addedIdx.push(j);
  }
  const remaining = new Map(counts);
  const removedIdx = [];
  for (let i = 0; i < Ln.length; i++) {
    const s = Ln[i];
    if (!s) continue;
    const c = remaining.get(s) || 0;
    if (c > 0) { removedIdx.push(i); remaining.set(s, c - 1); }
  }
  const hunks = [];
  if (removedIdx.length) {
    hunks.push({
      kind: 'removed',
      leftBoxes:  removedIdx.map(i => itemBox(L[i], 'removed')).filter(Boolean),
      rightBoxes: []
    });
  }
  if (addedIdx.length) {
    hunks.push({
      kind: 'added',
      leftBoxes:  [],
      rightBoxes: addedIdx.map(i => itemBox(R[i], 'added')).filter(Boolean)
    });
  }
  return hunks;
}

function hunkKind(h) {
  if (h.leftBoxes.length && h.rightBoxes.length) return 'changed';
  if (h.leftBoxes.length) return 'removed';
  return 'added';
}

function itemBox(item, kind) {
  if (!item || !item.norm) return null;
  return { x: item.x, y: item.y, w: item.w, h: item.h, kind };
}

function emptyDiff() {
  return {
    leftBoxes: [], rightBoxes: [], hunks: [],
    leftBaseW: 0, leftBaseH: 0, rightBaseW: 0, rightBaseH: 0,
    removedCount: 0, addedCount: 0,
    leftStatus: 'same', rightStatus: 'same',
    changed: false
  };
}

function assembleDiff(hunks, ld, rd, hasLeft, hasRight) {
  const leftBoxes = [], rightBoxes = [];
  let removedCount = 0, addedCount = 0;
  for (const h of hunks) {
    for (const b of h.leftBoxes)  { leftBoxes.push(b);  removedCount++; }
    for (const b of h.rightBoxes) { rightBoxes.push(b); addedCount++; }
  }
  return {
    leftBoxes, rightBoxes, hunks,
    leftBaseW:  ld ? ld.baseW : 0, leftBaseH:  ld ? ld.baseH : 0,
    rightBaseW: rd ? rd.baseW : 0, rightBaseH: rd ? rd.baseH : 0,
    removedCount, addedCount,
    leftStatus:  removedCount ? (hasRight ? 'changed' : 'removed') : 'same',
    rightStatus: addedCount   ? (hasLeft  ? 'changed' : 'added')   : 'same',
    changed: removedCount + addedCount > 0
  };
}

function wholePageDiff(data, side) {
  if (!data) return emptyDiff();
  const kind = side === 'left' ? 'removed' : 'added';
  const boxes = data.items.map(i => itemBox(i, kind)).filter(Boolean);
  const hunks = boxes.length ? [{
    kind,
    leftBoxes:  side === 'left'  ? boxes : [],
    rightBoxes: side === 'right' ? boxes : []
  }] : [];
  return {
    leftBoxes:  side === 'left'  ? boxes : [],
    rightBoxes: side === 'right' ? boxes : [],
    hunks,
    leftBaseW:  side === 'left'  ? data.baseW : 0,
    leftBaseH:  side === 'left'  ? data.baseH : 0,
    rightBaseW: side === 'right' ? data.baseW : 0,
    rightBaseH: side === 'right' ? data.baseH : 0,
    removedCount: side === 'left'  ? boxes.length : 0,
    addedCount:   side === 'right' ? boxes.length : 0,
    leftStatus:  side === 'left'  ? 'removed' : 'removed',
    rightStatus: side === 'right' ? 'added'   : 'added',
    changed: boxes.length > 0
  };
}

// --- Visual diff: render both pages off-screen, tile-SAD, merge into rects ---
async function diffPageVisual(leftPage, rightPage) {
  const scale = config.COMPARE_VISUAL_RENDER_SCALE;
  const lc = leftPage  ? await renderOffscreen(leftPage,  scale) : null;
  const rc = rightPage ? await renderOffscreen(rightPage, scale) : null;
  if (!lc && !rc) return emptyDiff();

  const baseLW = leftPage  ? leftPage.getViewport({ scale: 1 }).width  : 0;
  const baseLH = leftPage  ? leftPage.getViewport({ scale: 1 }).height : 0;
  const baseRW = rightPage ? rightPage.getViewport({ scale: 1 }).width  : 0;
  const baseRH = rightPage ? rightPage.getViewport({ scale: 1 }).height : 0;

  if (!lc) {
    const box = { x: 0, y: 0, w: baseRW, h: baseRH, kind: 'added' };
    return {
      leftBoxes: [], rightBoxes: [box],
      hunks: [{ kind: 'added', leftBoxes: [], rightBoxes: [box] }],
      leftBaseW: 0, leftBaseH: 0, rightBaseW: baseRW, rightBaseH: baseRH,
      removedCount: 0, addedCount: 1,
      leftStatus: 'added', rightStatus: 'added', changed: true
    };
  }
  if (!rc) {
    const box = { x: 0, y: 0, w: baseLW, h: baseLH, kind: 'removed' };
    return {
      leftBoxes: [box], rightBoxes: [],
      hunks: [{ kind: 'removed', leftBoxes: [box], rightBoxes: [] }],
      leftBaseW: baseLW, leftBaseH: baseLH, rightBaseW: 0, rightBaseH: 0,
      removedCount: 1, addedCount: 0,
      leftStatus: 'removed', rightStatus: 'removed', changed: true
    };
  }

  const W = Math.min(lc.width, rc.width);
  const H = Math.min(lc.height, rc.height);
  const lImg = lc.getContext('2d').getImageData(0, 0, lc.width, lc.height);
  const rImg = rc.getContext('2d').getImageData(0, 0, rc.width, rc.height);

  const TILE = config.COMPARE_VISUAL_TILE;
  const THRESH = config.COMPARE_VISUAL_THRESHOLD;
  const cols = Math.ceil(W / TILE);
  const rows = Math.ceil(H / TILE);
  const tileFlags = new Uint8Array(cols * rows);
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const x0 = rx * TILE, y0 = ry * TILE;
      const tw = Math.min(TILE, W - x0);
      const th = Math.min(TILE, H - y0);
      if (tileSAD(lImg, rImg, x0, y0, tw, th) > THRESH) tileFlags[ry * cols + rx] = 1;
    }
  }
  const merged = mergeTiles(tileFlags, cols, rows, TILE);
  const boxes = merged.map(b => ({
    x: b.x / scale, y: b.y / scale,
    w: b.w / scale, h: b.h / scale,
    kind: 'changed'
  }));

  const leftBoxes  = boxes.map(b => ({ ...b }));
  const rightBoxes = boxes.map(b => ({ ...b }));
  const hunks = boxes.map(b => ({
    kind: 'changed',
    leftBoxes:  [{ ...b }],
    rightBoxes: [{ ...b }]
  }));

  return {
    leftBoxes, rightBoxes, hunks,
    leftBaseW: baseLW, leftBaseH: baseLH,
    rightBaseW: baseRW, rightBaseH: baseRH,
    removedCount: 0, addedCount: 0,
    leftStatus:  boxes.length ? 'changed' : 'same',
    rightStatus: boxes.length ? 'changed' : 'same',
    changed: boxes.length > 0
  };
}

async function renderOffscreen(page, scale) {
  const viewport = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.ceil(viewport.width);
  c.height = Math.ceil(viewport.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return c;
}

function tileSAD(a, b, x0, y0, tw, th) {
  let sum = 0;
  const aw = a.width, bw = b.width;
  const ad = a.data, bd = b.data;
  for (let y = 0; y < th; y += 2) {
    const ay = y0 + y;
    if (ay >= a.height || ay >= b.height) break;
    for (let x = 0; x < tw; x += 2) {
      const ax = x0 + x;
      const ai = (ay * aw + ax) * 4;
      const bi = (ay * bw + ax) * 4;
      sum += Math.abs(ad[ai]     - bd[bi])
           + Math.abs(ad[ai + 1] - bd[bi + 1])
           + Math.abs(ad[ai + 2] - bd[bi + 2]);
    }
  }
  return sum;
}

function mergeTiles(flags, cols, rows, TILE) {
  const out = [];
  const used = new Uint8Array(flags.length);
  for (let ry = 0; ry < rows; ry++) {
    let rx = 0;
    while (rx < cols) {
      const idx = ry * cols + rx;
      if (!flags[idx] || used[idx]) { rx++; continue; }
      let endX = rx + 1;
      while (endX < cols && flags[ry * cols + endX] && !used[ry * cols + endX]) endX++;
      let endY = ry + 1;
      outer: while (endY < rows) {
        for (let c = rx; c < endX; c++) {
          if (!flags[endY * cols + c] || used[endY * cols + c]) break outer;
        }
        endY++;
      }
      for (let yy = ry; yy < endY; yy++)
        for (let xx = rx; xx < endX; xx++) used[yy * cols + xx] = 1;
      out.push({ x: rx * TILE, y: ry * TILE, w: (endX - rx) * TILE, h: (endY - ry) * TILE });
      rx = endX;
    }
  }
  return out;
}

// =============================================================================
// Summary + navigation
// =============================================================================

function updateSummary() {
  const c = state.compare;
  let added = 0, removed = 0, changed = 0;
  for (const d of c.diffs) {
    if (!d) continue;
    added += d.addedCount || 0;
    removed += d.removedCount || 0;
    if (d.changed) changed++;
  }
  els().addedCount.textContent  = added;
  els().removedCount.textContent = removed;
  els().changedPages.textContent = changed;
}

// Flatten all hunks across all pages into a single ordered list with
// (page, primary y) so jumpDiff can step through them and auto-scroll.
function flattenHunks() {
  const out = [];
  state.compare.diffs.forEach((d, page) => {
    if (!d || !d.hunks) return;
    for (const h of d.hunks) {
      const primary = (h.leftBoxes && h.leftBoxes[0]) || (h.rightBoxes && h.rightBoxes[0]);
      out.push({ page, y: primary ? primary.y : 0, hunk: h });
    }
  });
  return out;
}

async function jumpDiff(direction) {
  const all = flattenHunks();
  if (!all.length) { toast('No differences found', 'success'); return; }
  // Anchor against the current page if we have no cursor yet (or it's stale).
  if (currentHunkIdx < 0 || currentHunkIdx >= all.length) {
    const page = state.compare.currentPage;
    const onPage = all.findIndex(h => h.page === page);
    currentHunkIdx = onPage >= 0 ? onPage : (direction > 0 ? -1 : all.length);
  }
  let idx = currentHunkIdx + direction;
  if (idx < 0) idx = all.length - 1;
  if (idx >= all.length) idx = 0;
  currentHunkIdx = idx;
  const target = all[idx];
  if (target.page !== state.compare.currentPage) {
    await gotoPage(target.page);
  }
  scrollHunkIntoView(target);
}

function scrollHunkIntoView(target) {
  // Pick whichever side actually has a box for this hunk, so the scroll math
  // uses that side's scale and stage offset; sync handler mirrors the other.
  const c = state.compare;
  const hunk = target.hunk;
  let side, scale, stage, wrap;
  if (hunk.leftBoxes && hunk.leftBoxes.length) {
    side = 'left';  scale = leftScale;  stage = els().leftStage;  wrap = els().leftWrap;
  } else {
    side = 'right'; scale = rightScale; stage = els().rightStage; wrap = els().rightWrap;
  }
  if (!stage) return;
  const yPx = stage.offsetTop + target.y * scale;
  const inView = yPx >= wrap.scrollTop + 12
              && yPx + 80 <= wrap.scrollTop + wrap.clientHeight;
  if (!inView) {
    wrap.scrollTop = Math.max(0, yPx - wrap.clientHeight * 0.25);
  }
  // Connectors usually settle via the scroll listener; force one extra pass
  // for the case where no scroll actually happened.
  scheduleDrawConnectors();
}

async function gotoPage(idx) {
  const c = state.compare;
  const total = Math.max(c.left ? c.left.numPages : 0, c.right ? c.right.numPages : 0);
  if (total === 0) return;
  if (idx < 0) idx = 0;
  if (idx >= total) idx = total - 1;
  c.currentPage = idx;
  await renderComparePage();
  els().leftWrap.scrollTop = 0;
  els().rightWrap.scrollTop = 0;
  drawConnectors();
}

function stepZoom(dir) {
  const c = state.compare;
  c.fitMode = false;
  c.zoom = Math.max(config.ZOOM_MIN, Math.min(config.ZOOM_MAX, c.zoom + dir * config.ZOOM_STEP));
  renderComparePage();
}

// =============================================================================
// Per-page rendering
// =============================================================================

async function renderComparePage() {
  const c = state.compare;
  const total = Math.max(c.left ? c.left.numPages : 0, c.right ? c.right.numPages : 0);
  if (total === 0) return;
  const idx = c.currentPage;
  els().curPage.textContent = idx + 1;
  els().totalPages.textContent = total;

  const lp = (c.left  && idx < c.left.numPages)  ? await c.left.doc.getPage(idx + 1)  : null;
  const rp = (c.right && idx < c.right.numPages) ? await c.right.doc.getPage(idx + 1) : null;

  leftScale  = computeScale(lp, els().leftWrap);
  rightScale = computeScale(rp, els().rightWrap);

  // Empty placeholder semantics:
  //   left missing  + right exists → page was added → green tint
  //   right missing + left exists  → page was removed → red tint
  await Promise.all([
    lp ? renderPageToCanvas(lp, 'left',  leftScale)  : showEmptyPane('left',  rp ? 'added'   : null),
    rp ? renderPageToCanvas(rp, 'right', rightScale) : showEmptyPane('right', lp ? 'removed' : null),
  ]);

  const d = c.diffs[idx];
  if (d) {
    paintOverlay('left',  d.leftBoxes,  leftScale);
    paintOverlay('right', d.rightBoxes, rightScale);
    setStatusBadge('left',  d.leftStatus);
    setStatusBadge('right', d.rightStatus);
  } else {
    clearOverlay('left'); clearOverlay('right');
    setStatusBadge('left',  null);
    setStatusBadge('right', null);
  }

  const shownScale = leftScale || rightScale || 1;
  els().zoomLabel.textContent = c.fitMode ? 'Fit' : Math.round(shownScale * 100) + '%';
  drawConnectors();
}

// Fit-to-page: the whole page is visible without scrolling.
// Vertical scroll only kicks in when the user manually zooms in past fit.
function computeScale(page, wrap) {
  if (!page || !wrap) return 0;
  const c = state.compare;
  if (!c.fitMode) return c.zoom;
  const baseViewport = page.getViewport({ scale: 1 });
  const aw = wrap.clientWidth - 32;
  const ah = wrap.clientHeight - 32;
  const s = Math.min(aw / baseViewport.width, ah / baseViewport.height);
  return (isFinite(s) && s > 0) ? s : 1;
}

async function renderPageToCanvas(page, side, scale) {
  if (scale == null) scale = computeScale(page, els()[side + 'Wrap']);
  if (side === 'left')  leftScale  = scale;
  if (side === 'right') rightScale = scale;
  const viewport = page.getViewport({ scale });
  const canvas = els()[side + 'Canvas'];
  const stage  = els()[side + 'Stage'];
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = viewport.width + 'px';
  canvas.style.height = viewport.height + 'px';
  stage.style.width = viewport.width + 'px';
  stage.style.height = viewport.height + 'px';
  stage.classList.remove('empty', 'removed-side', 'added-side');
  els()[side + 'Empty'].style.display = 'none';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, viewport.width, viewport.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return viewport;
}

function showEmptyPane(side, kind) {
  // Match the other pane's dimensions so the layout stays balanced.
  const otherSide = side === 'left' ? 'right' : 'left';
  const otherCanvas = els()[otherSide + 'Canvas'];
  const stage = els()[side + 'Stage'];
  const w = otherCanvas.style.width || '400px';
  const h = otherCanvas.style.height || '500px';
  stage.style.width = w; stage.style.height = h;
  const canvas = els()[side + 'Canvas'];
  canvas.style.width = w; canvas.style.height = h;
  canvas.width = 1; canvas.height = 1;
  stage.classList.add('empty');
  if (kind === 'removed') stage.classList.add('removed-side');
  if (kind === 'added')   stage.classList.add('added-side');
  els()[side + 'Empty'].style.display = '';
  els()[side + 'Empty'].textContent = kind === 'removed' ? 'Page removed' : kind === 'added' ? 'Page added' : 'No page';
  clearOverlay(side);
}

function paintOverlay(side, boxes, scale) {
  const overlay = els()[side + 'Overlay'];
  overlay.innerHTML = '';
  if (!boxes || !boxes.length || !scale) return;
  const frag = document.createDocumentFragment();
  for (const b of boxes) {
    const el = document.createElement('div');
    el.className = 'diff-box ' + b.kind;
    el.style.left   = (b.x * scale) + 'px';
    el.style.top    = (b.y * scale) + 'px';
    el.style.width  = Math.max(2, b.w * scale) + 'px';
    el.style.height = Math.max(2, b.h * scale) + 'px';
    frag.appendChild(el);
  }
  overlay.appendChild(frag);
}

function clearOverlay(side) {
  const overlay = els()[side + 'Overlay'];
  if (overlay) overlay.innerHTML = '';
}

function setStatusBadge(side, status) {
  const el = els()[side + 'Status'];
  el.classList.remove('added', 'removed', 'changed', 'same');
  if (!status) { el.style.display = 'none'; el.textContent = '—'; return; }
  el.style.display = '';
  el.classList.add(status);
  el.textContent =
    status === 'added'   ? 'added'   :
    status === 'removed' ? 'removed' :
    status === 'changed' ? 'changed' : 'same';
}

// =============================================================================
// Connector lines: SVG paths linking matched left/right hunks
// =============================================================================

function drawConnectors() {
  const svg = els().connectors;
  const body = els().body;
  if (!svg || !body) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const c = state.compare;
  const d = c.diffs[c.currentPage];
  if (!d || !d.hunks || !d.hunks.length) return;

  const bRect = body.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${bRect.width} ${bRect.height}`);

  const lcRect = els().leftCanvas.getBoundingClientRect();
  const rcRect = els().rightCanvas.getBoundingClientRect();
  // If the canvas is collapsed (page missing on this side), fall back to its
  // wrap rect so connectors still terminate visibly inside the empty pane.
  const lwRect = els().leftWrap.getBoundingClientRect();
  const rwRect = els().rightWrap.getBoundingClientRect();
  const ls = leftScale  || 1;
  const rs = rightScale || 1;

  const frag = document.createDocumentFragment();
  for (const h of d.hunks) {
    const hasL = h.leftBoxes && h.leftBoxes.length;
    const hasR = h.rightBoxes && h.rightBoxes.length;
    if (!hasL && !hasR) continue;
    const kind = h.kind || (hasL && hasR ? 'changed' : (hasL ? 'removed' : 'added'));

    let lx, ly, rx, ry;
    if (hasL) {
      const u = unionBox(h.leftBoxes);
      lx = lcRect.left + (u.x + u.w) * ls;        // right edge of left hunk
      ly = lcRect.top  + (u.y + u.h / 2) * ls;
    } else {
      // Pure-add hunks: anchor at the left pane's right edge, vertically aligned
      // with the right hunk so the line still has a meaningful start point.
      const u = unionBox(h.rightBoxes);
      lx = lwRect.right;
      ly = rcRect.top + (u.y + u.h / 2) * rs;
    }
    if (hasR) {
      const u = unionBox(h.rightBoxes);
      rx = rcRect.left + u.x * rs;                // left edge of right hunk
      ry = rcRect.top  + (u.y + u.h / 2) * rs;
    } else {
      const u = unionBox(h.leftBoxes);
      rx = rwRect.left;
      ry = lcRect.top + (u.y + u.h / 2) * ls;
    }

    // Convert screen coords → body-relative (SVG) coords.
    lx -= bRect.left; ly -= bRect.top;
    rx -= bRect.left; ry -= bRect.top;

    // Skip lines whose endpoints both fall outside the body viewport — saves
    // DOM nodes when many hunks are scrolled off-screen.
    if ((ly < 0 && ry < 0) || (ly > bRect.height && ry > bRect.height)) continue;

    const mx = (lx + rx) / 2;
    const path = `M ${lx.toFixed(1)},${ly.toFixed(1)} ` +
                 `C ${mx.toFixed(1)},${ly.toFixed(1)} ` +
                   `${mx.toFixed(1)},${ry.toFixed(1)} ` +
                   `${rx.toFixed(1)},${ry.toFixed(1)}`;
    const el = document.createElementNS(SVG_NS, 'path');
    el.setAttribute('d', path);
    el.setAttribute('class', kind);
    frag.appendChild(el);
  }
  svg.appendChild(frag);
}

function unionBox(boxes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    if (b.x < x0) x0 = b.x;
    if (b.y < y0) y0 = b.y;
    if (b.x + b.w > x1) x1 = b.x + b.w;
    if (b.y + b.h > y1) y1 = b.y + b.h;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

module.exports = { runCompare, gotoPage, renderComparePage };
