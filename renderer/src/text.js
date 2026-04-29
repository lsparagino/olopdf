'use strict';
// Text annotations: the modal that captures text + format options, and the placed-text
// DOM elements that overlay the canvas (with drag-to-move).
const { $, toast, openModal, closeModal } = require('./dom');
const { state, config } = require('./state');
const { cssFontFamily } = require('./util');

// ---- Render the placed-text overlay (called after each renderCurrentPage) ----
function drawTextOverlays() {
  const overlay = $('textOverlay');
  overlay.innerHTML = '';
  const origIdx = state.pageOrder[state.currentPage];
  const perPage = state.textAnnotations
    .filter(a => a.pageOriginalIdx === origIdx)
    .map(a => ({ ann: a, repeat: false }));
  const repeats = state.repeatTexts.map(a => ({ ann: a, repeat: true }));
  for (const { ann, repeat } of [...perPage, ...repeats]) {
    overlay.appendChild(makePlacedTextEl(ann, repeat));
  }
}

function makePlacedTextEl(ann, isRepeat) {
  const el = document.createElement('div');
  el.className = 'placed-text' + (isRepeat ? ' repeat' : '');
  el.textContent = ann.text;
  positionPlacedText(el, ann);

  if (isRepeat) {
    const badge = document.createElement('span');
    badge.className = 'placed-text-badge';
    badge.textContent = '↻';
    badge.title = 'Repeats on every page';
    el.appendChild(badge);
  }

  const del = document.createElement('span');
  del.className = 'placed-text-del';
  del.textContent = '×';
  del.title = 'Remove';
  del.addEventListener('mousedown', (e) => e.stopPropagation());
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    const arr = isRepeat ? state.repeatTexts : state.textAnnotations;
    const idx = arr.indexOf(ann);
    if (idx >= 0) arr.splice(idx, 1);
    drawTextOverlays();
    toast('Text removed');
  });
  el.appendChild(del);

  el.addEventListener('mousedown', (e) => onTextMouseDown(e, el, ann));
  return el;
}

function positionPlacedText(el, ann) {
  const scale = state.zoom;
  el.style.left = (ann.x * scale) + 'px';
  el.style.top = (ann.y * scale) + 'px';
  el.style.fontSize = (ann.size * scale) + 'px';
  el.style.color = ann.color;
  el.style.fontFamily = cssFontFamily(ann.font || 'helvetica');
  el.style.fontWeight = ann.bold ? '700' : '400';
  el.style.fontStyle = ann.italic ? 'italic' : 'normal';
  el.style.textDecoration = ann.underline ? 'underline' : 'none';
}

function onTextMouseDown(e, el, ann) {
  // Pending placement takes priority — let the canvas-wrap handler get it
  if (state.pendingTextPlacement) return;
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  el.classList.add('dragging');
  document.body.classList.add('text-dragging');
  const startX = e.clientX, startY = e.clientY;
  const origX = ann.x, origY = ann.y;
  const scale = state.zoom;
  let moved = false;
  function onMove(ev) {
    const dx = (ev.clientX - startX) / scale;
    const dy = (ev.clientY - startY) / scale;
    if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > config.TEXT_DRAG_THRESHOLD_PX) {
      moved = true;
    }
    ann.x = origX + dx;
    ann.y = origY + dy;
    positionPlacedText(el, ann);
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    el.classList.remove('dragging');
    document.body.classList.remove('text-dragging');
    if (moved) toast('Text moved');
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ---- Place text triggered by the canvas-wrap mousedown handler ----
function placePendingTextAt(clientX, clientY) {
  const p = state.pendingTextPlacement;
  if (!p) return false;
  const canvas = $('pdfCanvas');
  const r = canvas.getBoundingClientRect();
  const cx = clientX - r.left;
  const cy = clientY - r.top;
  if (cx < 0 || cy < 0 || cx > r.width || cy > r.height) return false;
  const scale = state.zoom;
  const ann = {
    x: cx / scale,
    y: cy / scale,
    text: p.text,
    size: p.size,
    color: p.color,
    font: p.font || 'helvetica',
    bold: !!p.bold,
    italic: !!p.italic,
    underline: !!p.underline
  };
  if (p.repeat) {
    state.repeatTexts.push(ann);
  } else {
    ann.pageOriginalIdx = state.pageOrder[state.currentPage];
    state.textAnnotations.push(ann);
  }
  state.pendingTextPlacement = null;
  $('canvasWrap').classList.remove('placing-text');
  drawTextOverlays();
  toast('Text added — drag to move, × to remove', 'success');
  return true;
}

// ---- Add Text modal wiring ----
$('addTextBtn').addEventListener('click', () => {
  $('textInput').value = '';
  $('textRepeat').checked = false;
  $('textFont').value = 'helvetica';
  ['textBold', 'textItalic', 'textUnderline'].forEach(id => $(id).classList.remove('active'));
  openModal('textModal');
  setTimeout(() => $('textInput').focus(), 50);
});

['textBold', 'textItalic', 'textUnderline'].forEach(id => {
  $(id).addEventListener('click', () => $(id).classList.toggle('active'));
});

// Ctrl+B / Ctrl+I / Ctrl+U inside the modal text input
$('textInput').addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  const map = { b: 'textBold', i: 'textItalic', u: 'textUnderline' };
  if (!map[k]) return;
  e.preventDefault();
  $(map[k]).classList.toggle('active');
});

$('textCancel').addEventListener('click', () => closeModal('textModal'));
$('textPlace').addEventListener('click', () => {
  const text = $('textInput').value.trim();
  if (!text) { toast('Enter some text', 'error'); return; }
  state.pendingTextPlacement = {
    text,
    size: Math.max(6, Math.min(200, parseInt($('textSize').value, 10) || 14)),
    color: $('textColor').value,
    repeat: $('textRepeat').checked,
    font: $('textFont').value,
    bold: $('textBold').classList.contains('active'),
    italic: $('textItalic').classList.contains('active'),
    underline: $('textUnderline').classList.contains('active')
  };
  closeModal('textModal');
  $('canvasWrap').classList.add('placing-text');
  toast(state.pendingTextPlacement.repeat
    ? 'Click to place — text will repeat on every page'
    : 'Click on the page to place text');
});

// Refresh the placed-text overlay whenever a page is rendered
window.addEventListener('pdf:page-rendered', drawTextOverlays);

module.exports = { drawTextOverlays, placePendingTextAt };
