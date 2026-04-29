'use strict';
// Inline text editor: click on the page → editable element with a floating toolbar
// appears in place. No modal. Existing placed text is editable via double-click.
const { $, toast } = require('./dom');
const { state, config } = require('./state');
const { cssFontFamily } = require('./util');

const FONTS = ['helvetica', 'times', 'courier'];
const DEFAULT_OPTS = {
  text: '', font: 'helvetica', size: 14, color: '#111111',
  bold: false, italic: false, underline: false, repeat: false
};

let activeEditor = null; // { el, toolbar, ann, isNew, sourceEl, sourceArr, isRepeat }

// ---- Render the placed-text overlay (called after each renderCurrentPage) ----
function drawTextOverlays() {
  const overlay = $('textOverlay');
  // Preserve any active inline editor across re-renders.
  const editorEl = overlay.querySelector('.inline-text-editor');
  const toolbarEl = overlay.querySelector('.inline-text-toolbar');
  if (editorEl) editorEl.remove();
  if (toolbarEl) toolbarEl.remove();
  overlay.innerHTML = '';

  const origIdx = state.pageOrder[state.currentPage];
  const perPage = state.textAnnotations
    .filter(a => a.pageOriginalIdx === origIdx)
    .map(a => ({ ann: a, repeat: false }));
  const repeats = state.repeatTexts.map(a => ({ ann: a, repeat: true }));
  for (const { ann, repeat } of [...perPage, ...repeats]) {
    if (activeEditor && activeEditor.ann === ann) continue; // hidden behind the editor
    overlay.appendChild(makePlacedTextEl(ann, repeat));
  }

  if (editorEl) overlay.appendChild(editorEl);
  if (toolbarEl) overlay.appendChild(toolbarEl);
  if (activeEditor) {
    positionEditor(activeEditor.el, activeEditor.ann);
    positionToolbar(activeEditor.toolbar, activeEditor.el);
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
  el.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openEditor({ ann, isRepeat, isNew: false, sourceEl: el });
  });
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
  if (state.pendingTextPlacement) return;
  if (activeEditor) return;
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

// ---- Toolbar entry point: enter placement mode ----
$('addTextBtn').addEventListener('click', () => {
  if (activeEditor) commitEditor();
  state.pendingTextPlacement = { ...DEFAULT_OPTS };
  $('canvasWrap').classList.add('placing-text');
  toast('Click on the page to place text');
});

// Called from zoom-pan.js when canvas-wrap is clicked while pendingTextPlacement is set.
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
    text: '',
    size: p.size,
    color: p.color,
    font: p.font,
    bold: !!p.bold,
    italic: !!p.italic,
    underline: !!p.underline
  };
  state.pendingTextPlacement = null;
  $('canvasWrap').classList.remove('placing-text');
  openEditor({ ann, isRepeat: !!p.repeat, isNew: true, sourceEl: null });
  return true;
}

// ---- Inline editor ----
function openEditor({ ann, isRepeat, isNew, sourceEl }) {
  if (activeEditor) commitEditor();

  const overlay = $('textOverlay');

  const el = document.createElement('div');
  el.className = 'inline-text-editor';
  el.contentEditable = 'true';
  el.spellcheck = false;
  el.textContent = ann.text || '';
  applyStyle(el, ann);
  positionEditor(el, ann);
  el.addEventListener('mousedown', (e) => e.stopPropagation());
  el.addEventListener('keydown', onEditorKeydown);
  el.addEventListener('input', () => {
    if (activeEditor) positionToolbar(activeEditor.toolbar, el);
  });
  el.addEventListener('blur', () => {
    // Defer so a click on the toolbar (which preventDefaults its mousedown) doesn't
    // cause a premature commit before the toolbar finishes its action.
    setTimeout(() => {
      if (!activeEditor) return;
      const a = document.activeElement;
      if (a === activeEditor.el) return;
      if (activeEditor.toolbar && activeEditor.toolbar.contains(a)) return;
      commitEditor();
    }, 0);
  });
  overlay.appendChild(el);

  const tb = buildToolbar(ann, isRepeat);
  overlay.appendChild(tb);

  activeEditor = {
    el, toolbar: tb, ann, isNew, sourceEl, isRepeat,
    sourceArr: isNew ? null : (isRepeat ? state.repeatTexts : state.textAnnotations)
  };
  if (sourceEl) sourceEl.style.visibility = 'hidden';

  positionToolbar(tb, el);
  el.focus();
  // Caret at end
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function positionEditor(el, ann) {
  const scale = state.zoom;
  el.style.left = (ann.x * scale) + 'px';
  el.style.top = (ann.y * scale) + 'px';
  el.style.fontSize = (ann.size * scale) + 'px';
}

function applyStyle(el, ann) {
  el.style.color = ann.color;
  el.style.fontFamily = cssFontFamily(ann.font || 'helvetica');
  el.style.fontWeight = ann.bold ? '700' : '400';
  el.style.fontStyle = ann.italic ? 'italic' : 'normal';
  el.style.textDecoration = ann.underline ? 'underline' : 'none';
}

function buildToolbar(ann, isRepeat) {
  const tb = document.createElement('div');
  tb.className = 'inline-text-toolbar';
  // Don't blur the editor when interacting with toolbar widgets.
  tb.addEventListener('mousedown', (e) => {
    if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
      e.preventDefault();
    }
  });

  const fontSel = document.createElement('select');
  fontSel.className = 'tb-input';
  for (const f of FONTS) {
    const o = document.createElement('option');
    o.value = f; o.textContent = f.charAt(0).toUpperCase() + f.slice(1);
    fontSel.appendChild(o);
  }
  fontSel.value = ann.font || 'helvetica';
  fontSel.addEventListener('change', () => {
    if (!activeEditor) return;
    activeEditor.ann.font = fontSel.value;
    applyStyle(activeEditor.el, activeEditor.ann);
    activeEditor.el.focus();
  });

  const sizeInput = document.createElement('input');
  sizeInput.type = 'number';
  sizeInput.className = 'tb-input tb-size';
  sizeInput.min = 6; sizeInput.max = 200;
  sizeInput.value = ann.size;
  sizeInput.addEventListener('input', () => {
    if (!activeEditor) return;
    const v = Math.max(6, Math.min(200, parseInt(sizeInput.value, 10) || 14));
    activeEditor.ann.size = v;
    activeEditor.el.style.fontSize = (v * state.zoom) + 'px';
    positionToolbar(activeEditor.toolbar, activeEditor.el);
  });

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'tb-input tb-color';
  colorInput.value = ann.color;
  colorInput.addEventListener('input', () => {
    if (!activeEditor) return;
    activeEditor.ann.color = colorInput.value;
    activeEditor.el.style.color = colorInput.value;
  });

  const styleDefs = [
    { key: 'bold', label: 'B', extra: 'font-weight:700', title: 'Bold (Ctrl+B)' },
    { key: 'italic', label: 'I', extra: 'font-style:italic;font-family:serif', title: 'Italic (Ctrl+I)' },
    { key: 'underline', label: 'U', extra: 'text-decoration:underline', title: 'Underline (Ctrl+U)' }
  ];
  const styleBtns = styleDefs.map(s => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tb-btn tb-style';
    btn.dataset.styleKey = s.key;
    btn.textContent = s.label;
    btn.setAttribute('style', s.extra);
    btn.title = s.title;
    if (ann[s.key]) btn.classList.add('active');
    btn.addEventListener('click', () => {
      if (!activeEditor) return;
      const on = !btn.classList.contains('active');
      btn.classList.toggle('active', on);
      activeEditor.ann[s.key] = on;
      applyStyle(activeEditor.el, activeEditor.ann);
      activeEditor.el.focus();
    });
    return btn;
  });

  const repeatLabel = document.createElement('label');
  repeatLabel.className = 'tb-check';
  repeatLabel.title = 'Repeat on every page (header / footer)';
  const repeatCb = document.createElement('input');
  repeatCb.type = 'checkbox';
  repeatCb.checked = isRepeat;
  const repText = document.createElement('span');
  repText.textContent = 'Repeat';
  repeatLabel.append(repeatCb, repText);
  repeatCb.addEventListener('change', () => {
    if (!activeEditor) return;
    activeEditor.isRepeat = repeatCb.checked;
  });

  const doneBtn = document.createElement('button');
  doneBtn.type = 'button';
  doneBtn.className = 'tb-btn tb-done';
  doneBtn.title = 'Done (Enter)';
  doneBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  doneBtn.addEventListener('click', () => commitEditor());

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'tb-btn tb-cancel';
  cancelBtn.title = 'Cancel (Esc)';
  cancelBtn.textContent = '×';
  cancelBtn.addEventListener('click', () => cancelEditor());

  tb.append(fontSel, sizeInput, colorInput, ...styleBtns, repeatLabel, doneBtn, cancelBtn);
  return tb;
}

function positionToolbar(tb, editorEl) {
  if (!tb || !editorEl) return;
  const overlay = $('textOverlay');
  const ow = overlay.clientWidth;
  const editorTop = parseFloat(editorEl.style.top) || 0;
  const editorLeft = parseFloat(editorEl.style.left) || 0;
  const editorH = editorEl.offsetHeight || 24;
  const tbW = tb.offsetWidth || 320;
  const tbH = tb.offsetHeight || 36;
  let top = editorTop - tbH - 10;
  if (top < 0) top = editorTop + editorH + 10;
  let left = editorLeft;
  if (left + tbW > ow) left = Math.max(0, ow - tbW - 4);
  if (left < 0) left = 0;
  tb.style.top = top + 'px';
  tb.style.left = left + 'px';
}

function onEditorKeydown(e) {
  if (!activeEditor) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    commitEditor();
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    cancelEditor();
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === 'b' || k === 'i' || k === 'u') {
      e.preventDefault();
      const map = { b: 'bold', i: 'italic', u: 'underline' };
      const key = map[k];
      const on = !activeEditor.ann[key];
      activeEditor.ann[key] = on;
      applyStyle(activeEditor.el, activeEditor.ann);
      const btn = activeEditor.toolbar.querySelector(`.tb-style[data-style-key="${key}"]`);
      if (btn) btn.classList.toggle('active', on);
    }
  }
}

function commitEditor() {
  if (!activeEditor) return;
  const { el, toolbar, ann, isNew, sourceEl, sourceArr, isRepeat } = activeEditor;
  const text = (el.innerText || '').replace(/\s+$/g, '').trim();
  el.remove();
  toolbar.remove();
  activeEditor = null;

  if (!text) {
    if (!isNew && sourceArr) {
      const idx = sourceArr.indexOf(ann);
      if (idx >= 0) sourceArr.splice(idx, 1);
      toast('Text removed');
    }
    drawTextOverlays();
    return;
  }

  ann.text = text;
  if (isNew) {
    if (isRepeat) {
      delete ann.pageOriginalIdx;
      state.repeatTexts.push(ann);
    } else {
      ann.pageOriginalIdx = state.pageOrder[state.currentPage];
      state.textAnnotations.push(ann);
    }
    toast('Text added — drag to move, double-click to edit', 'success');
  } else {
    const wasRepeat = sourceArr === state.repeatTexts;
    if (wasRepeat !== isRepeat) {
      const fromArr = wasRepeat ? state.repeatTexts : state.textAnnotations;
      const idx = fromArr.indexOf(ann);
      if (idx >= 0) fromArr.splice(idx, 1);
      if (isRepeat) {
        delete ann.pageOriginalIdx;
        state.repeatTexts.push(ann);
      } else {
        ann.pageOriginalIdx = state.pageOrder[state.currentPage];
        state.textAnnotations.push(ann);
      }
    }
  }
  drawTextOverlays();
}

function cancelEditor() {
  if (!activeEditor) return;
  const { el, toolbar, sourceEl } = activeEditor;
  el.remove();
  toolbar.remove();
  if (sourceEl) sourceEl.style.visibility = '';
  activeEditor = null;
}

function isEditorActive() { return !!activeEditor; }

window.addEventListener('pdf:page-rendered', drawTextOverlays);

module.exports = {
  drawTextOverlays,
  placePendingTextAt,
  isEditorActive,
  cancelActiveTextEditor: cancelEditor,
  commitActiveTextEditor: commitEditor
};
