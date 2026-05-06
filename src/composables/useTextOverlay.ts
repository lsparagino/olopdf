// Text overlay: renders placed text + repeat-text annotations imperatively into the
// overlay div, plus the inline contenteditable editor and its floating toolbar.
//
// Why imperative: each annotation needs precise pixel positioning that scales with
// pdf.zoom, plus drag-to-move with mouse listeners on document. Wrapping each in a Vue
// component adds a layer of reactivity churn for no benefit — the legacy DOM approach
// is the right tool here. We DO source the data from the Pinia store, so the rest of
// the app stays reactive.

import { PDF_CONFIG, usePdfStore, type TextAnnotation } from '@/stores/pdf'
import { useEditorRefs } from '@/composables/useEditorRefs'
import { toast } from '@/composables/useToast'
import {
  cssFontFamily,
  forwardTransform,
  inverseDelta,
  inverseTransform,
  unrotatedDims,
  type FontFamily,
} from '@/utils/pdf'

const FONTS: FontFamily[] = ['helvetica', 'times', 'courier']

export const DEFAULT_TEXT_OPTS = {
  text: '',
  font: 'helvetica' as FontFamily,
  size: 14,
  color: '#111111',
  bold: false,
  italic: false,
  underline: false,
  repeat: false,
}

interface ActiveEditor {
  el: HTMLDivElement
  toolbar: HTMLDivElement
  ann: TextAnnotation
  isNew: boolean
  sourceEl: HTMLElement | null
  isRepeat: boolean
  sourceArr: TextAnnotation[] | null
}

let activeEditor: ActiveEditor | null = null

// Per-element back-reference to the annotation it renders. Lets external callers
// (the Inserted Text panel) find the placed-text DOM node for a given annotation
// without us having to assign and track DOM ids.
const PLACED_TEXT_ANN = new WeakMap<HTMLDivElement, TextAnnotation>()

export function isEditorActive(): boolean {
  return !!activeEditor
}

// Open the inline editor for an annotation that already lives in the store. The
// caller is responsible for navigating to the correct page first; we look up the
// rendered placed-text element on the current overlay (so it can be hidden while
// the editor is active) and invoke openEditor with the right isRepeat flag.
export function editAnnotation(ann: TextAnnotation, isRepeat: boolean): void {
  const refs = useEditorRefs()
  const overlay = refs.textOverlay.value
  let sourceEl: HTMLElement | null = null
  if (overlay) {
    const placed = overlay.querySelectorAll<HTMLDivElement>('.placed-text')
    for (const el of placed) {
      if (PLACED_TEXT_ANN.get(el) === ann) {
        sourceEl = el
        break
      }
    }
  }
  openEditor({ ann, isRepeat, isNew: false, sourceEl })
}

export function drawTextOverlays(): void {
  const refs = useEditorRefs()
  const overlay = refs.textOverlay.value
  if (!overlay) return
  const pdf = usePdfStore()

  const editorEl = overlay.querySelector<HTMLDivElement>('.inline-text-editor')
  const toolbarEl = overlay.querySelector<HTMLDivElement>('.inline-text-toolbar')
  if (editorEl) editorEl.remove()
  if (toolbarEl) toolbarEl.remove()
  overlay.innerHTML = ''

  const origIdx = pdf.pageOrder[pdf.currentPage]
  const perPage = pdf.textAnnotations
    .filter((a) => a.pageOriginalIdx === origIdx)
    .map((a) => ({ ann: a, repeat: false }))
  const repeats = pdf.repeatTexts.map((a) => ({ ann: a, repeat: true }))

  for (const { ann, repeat } of [...perPage, ...repeats]) {
    if (activeEditor && activeEditor.ann === ann) continue
    overlay.appendChild(makePlacedTextEl(ann, repeat))
  }

  if (editorEl) overlay.appendChild(editorEl)
  if (toolbarEl) overlay.appendChild(toolbarEl)
  if (activeEditor) {
    positionEditor(activeEditor.el, activeEditor.ann)
    positionToolbar(activeEditor.toolbar, activeEditor.el)
  }
}

function makePlacedTextEl(ann: TextAnnotation, isRepeat: boolean): HTMLDivElement {
  const el = document.createElement('div')
  el.className = `placed-text${isRepeat ? ' repeat' : ''}`
  el.textContent = ann.text
  PLACED_TEXT_ANN.set(el, ann)
  positionPlacedText(el, ann)

  if (isRepeat) {
    const badge = document.createElement('span')
    badge.className = 'placed-text-badge'
    badge.textContent = '↻'
    badge.title = 'Repeats on every page'
    el.appendChild(badge)
  }

  const del = document.createElement('span')
  del.className = 'placed-text-del'
  del.textContent = '×'
  del.title = 'Remove'
  del.addEventListener('mousedown', (e) => e.stopPropagation())
  del.addEventListener('click', (e) => {
    e.stopPropagation()
    const pdf = usePdfStore()
    if (isRepeat) pdf.removeRepeatText(ann)
    else pdf.removeTextAnnotation(ann)
    drawTextOverlays()
    toast('Text removed')
  })
  el.appendChild(del)

  el.addEventListener('mousedown', (e) => onTextMouseDown(e, el, ann))
  el.addEventListener('dblclick', (e) => {
    e.preventDefault()
    e.stopPropagation()
    openEditor({ ann, isRepeat, isNew: false, sourceEl: el })
  })
  return el
}

// Returns the current page's rotation and unrotated dims, derived from the
// rendered baseViewport. Defaults to (0, 0, 0) if the doc isn't ready.
function pageRotationContext(): { rotation: number; uW: number; uH: number } {
  const pdf = usePdfStore()
  const origIdx = pdf.pageOrder[pdf.currentPage]
  const rotation = origIdx !== undefined ? pdf.rotationFor(origIdx) : 0
  const bv = pdf.baseViewport
  if (!bv) return { rotation, uW: 0, uH: 0 }
  const { uW, uH } = unrotatedDims(bv.width, bv.height, rotation)
  return { rotation, uW, uH }
}

function positionPlacedText(el: HTMLElement, ann: TextAnnotation): void {
  const pdf = usePdfStore()
  const scale = pdf.zoom
  const { rotation, uW, uH } = pageRotationContext()
  const { cx, cy } = forwardTransform(ann.x, ann.y, uW, uH, rotation)
  el.style.left = `${cx * scale}px`
  el.style.top = `${cy * scale}px`
  el.style.fontSize = `${ann.size * scale}px`
  el.style.color = ann.color
  el.style.fontFamily = cssFontFamily(ann.font || 'helvetica')
  el.style.fontWeight = ann.bold ? '700' : '400'
  el.style.fontStyle = ann.italic ? 'italic' : 'normal'
  el.style.textDecoration = ann.underline ? 'underline' : 'none'
  el.style.transformOrigin = '0 0'
  el.style.transform = rotation ? `rotate(${rotation}deg)` : ''
}

function onTextMouseDown(e: MouseEvent, el: HTMLDivElement, ann: TextAnnotation): void {
  const pdf = usePdfStore()
  if (pdf.pendingTextPlacement) return
  if (activeEditor) return
  if (e.button !== 0) return
  e.preventDefault()
  e.stopPropagation()
  el.classList.add('dragging')
  document.body.classList.add('text-dragging')
  const startX = e.clientX
  const startY = e.clientY
  const origX = ann.x
  const origY = ann.y
  const scale = pdf.zoom
  const { rotation } = pageRotationContext()
  let moved = false

  function onMove(ev: MouseEvent) {
    const dCx = (ev.clientX - startX) / scale
    const dCy = (ev.clientY - startY) / scale
    const { dx, dy } = inverseDelta(dCx, dCy, rotation)
    if (
      !moved &&
      Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) >
        PDF_CONFIG.TEXT_DRAG_THRESHOLD_PX
    ) {
      moved = true
    }
    ann.x = origX + dx
    ann.y = origY + dy
    positionPlacedText(el, ann)
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    el.classList.remove('dragging')
    document.body.classList.remove('text-dragging')
    if (moved) {
      toast('Text moved')
      return
    }
    // Click without drag: enter edit mode. The annotation lives in either
    // textAnnotations or repeatTexts — repeatTexts has no pageOriginalIdx, so
    // checking presence in the per-page array is the reliable discriminator.
    const store = usePdfStore()
    const isRepeat = store.repeatTexts.indexOf(ann) >= 0
    openEditor({ ann, isRepeat, isNew: false, sourceEl: el })
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

export function startTextPlacement(): void {
  if (activeEditor) commitEditor()
  const pdf = usePdfStore()
  pdf.pendingTextPlacement = { ...DEFAULT_TEXT_OPTS } as typeof DEFAULT_TEXT_OPTS
  const refs = useEditorRefs()
  refs.canvasWrap.value?.classList.add('placing-text')
  toast('Click on the page to place text')
}

export function placePendingTextAt(clientX: number, clientY: number): boolean {
  const pdf = usePdfStore()
  const p = pdf.pendingTextPlacement
  if (!p) return false
  const refs = useEditorRefs()
  const canvas = refs.pdfCanvas.value
  if (!canvas) return false
  const r = canvas.getBoundingClientRect()
  const cxs = clientX - r.left
  const cys = clientY - r.top
  if (cxs < 0 || cys < 0 || cxs > r.width || cys > r.height) return false
  const scale = pdf.zoom
  const { rotation, uW, uH } = pageRotationContext()
  const { x, y } = inverseTransform(cxs / scale, cys / scale, uW, uH, rotation)
  const ann: TextAnnotation = {
    x,
    y,
    text: '',
    size: p.size,
    color: p.color,
    font: p.font,
    bold: !!p.bold,
    italic: !!p.italic,
    underline: !!p.underline,
  }
  pdf.pendingTextPlacement = null
  refs.canvasWrap.value?.classList.remove('placing-text')
  openEditor({ ann, isRepeat: !!p.repeat, isNew: true, sourceEl: null })
  return true
}

interface OpenEditorOpts {
  ann: TextAnnotation
  isRepeat: boolean
  isNew: boolean
  sourceEl: HTMLElement | null
}

function openEditor({ ann, isRepeat, isNew, sourceEl }: OpenEditorOpts): void {
  if (activeEditor) commitEditor()
  const refs = useEditorRefs()
  const overlay = refs.textOverlay.value
  if (!overlay) return

  const el = document.createElement('div')
  el.className = 'inline-text-editor'
  el.contentEditable = 'true'
  el.spellcheck = false
  el.textContent = ann.text || ''
  applyEditorStyle(el, ann)
  positionEditor(el, ann)
  el.addEventListener('mousedown', (e) => e.stopPropagation())
  el.addEventListener('keydown', onEditorKeydown)
  el.addEventListener('input', () => {
    if (activeEditor) positionToolbar(activeEditor.toolbar, el)
  })
  el.addEventListener('blur', () => {
    setTimeout(() => {
      if (!activeEditor) return
      const a = document.activeElement
      if (a === activeEditor.el) return
      if (activeEditor.toolbar.contains(a as Node)) return
      commitEditor()
    }, 0)
  })
  overlay.appendChild(el)

  const tb = buildToolbar(ann, isRepeat)
  overlay.appendChild(tb)

  const pdf = usePdfStore()
  activeEditor = {
    el,
    toolbar: tb,
    ann,
    isNew,
    sourceEl,
    isRepeat,
    sourceArr: isNew ? null : isRepeat ? pdf.repeatTexts : pdf.textAnnotations,
  }
  if (sourceEl) sourceEl.style.visibility = 'hidden'

  positionToolbar(tb, el)
  el.focus()
  // Place caret at end
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

function positionEditor(el: HTMLElement, ann: TextAnnotation): void {
  const pdf = usePdfStore()
  const scale = pdf.zoom
  const { rotation, uW, uH } = pageRotationContext()
  const { cx, cy } = forwardTransform(ann.x, ann.y, uW, uH, rotation)
  el.style.left = `${cx * scale}px`
  el.style.top = `${cy * scale}px`
  el.style.fontSize = `${ann.size * scale}px`
  el.style.transformOrigin = '0 0'
  el.style.transform = rotation ? `rotate(${rotation}deg)` : ''
}

function applyEditorStyle(el: HTMLElement, ann: TextAnnotation): void {
  el.style.color = ann.color
  el.style.fontFamily = cssFontFamily(ann.font || 'helvetica')
  el.style.fontWeight = ann.bold ? '700' : '400'
  el.style.fontStyle = ann.italic ? 'italic' : 'normal'
  el.style.textDecoration = ann.underline ? 'underline' : 'none'
}

function buildToolbar(ann: TextAnnotation, isRepeat: boolean): HTMLDivElement {
  const tb = document.createElement('div')
  tb.className = 'inline-text-toolbar'
  tb.addEventListener('mousedown', (e) => {
    const tag = (e.target as HTMLElement).tagName
    if (tag !== 'INPUT' && tag !== 'SELECT') e.preventDefault()
  })

  const fontSel = document.createElement('select')
  fontSel.className = 'tb-input'
  for (const f of FONTS) {
    const o = document.createElement('option')
    o.value = f
    o.textContent = f.charAt(0).toUpperCase() + f.slice(1)
    fontSel.appendChild(o)
  }
  fontSel.value = ann.font || 'helvetica'
  fontSel.addEventListener('change', () => {
    if (!activeEditor) return
    activeEditor.ann.font = fontSel.value as FontFamily
    applyEditorStyle(activeEditor.el, activeEditor.ann)
    activeEditor.el.focus()
  })

  const sizeInput = document.createElement('input')
  sizeInput.type = 'number'
  sizeInput.className = 'tb-input tb-size'
  sizeInput.min = '6'
  sizeInput.max = '200'
  sizeInput.value = String(ann.size)
  sizeInput.addEventListener('input', () => {
    if (!activeEditor) return
    const v = Math.max(6, Math.min(200, parseInt(sizeInput.value, 10) || 14))
    activeEditor.ann.size = v
    activeEditor.el.style.fontSize = `${v * usePdfStore().zoom}px`
    positionToolbar(activeEditor.toolbar, activeEditor.el)
  })

  const colorInput = document.createElement('input')
  colorInput.type = 'color'
  colorInput.className = 'tb-input tb-color'
  colorInput.value = ann.color
  colorInput.addEventListener('input', () => {
    if (!activeEditor) return
    activeEditor.ann.color = colorInput.value
    activeEditor.el.style.color = colorInput.value
  })

  type StyleKey = 'bold' | 'italic' | 'underline'
  const styleDefs: Array<{
    key: StyleKey
    label: string
    extra: string
    title: string
  }> = [
    { key: 'bold', label: 'B', extra: 'font-weight:700', title: 'Bold (Ctrl+B)' },
    {
      key: 'italic',
      label: 'I',
      extra: 'font-style:italic;font-family:serif',
      title: 'Italic (Ctrl+I)',
    },
    {
      key: 'underline',
      label: 'U',
      extra: 'text-decoration:underline',
      title: 'Underline (Ctrl+U)',
    },
  ]
  const styleBtns = styleDefs.map((s) => {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'tb-btn tb-style'
    btn.dataset.styleKey = s.key
    btn.textContent = s.label
    btn.setAttribute('style', s.extra)
    btn.title = s.title
    if (ann[s.key]) btn.classList.add('active')
    btn.addEventListener('click', () => {
      if (!activeEditor) return
      const on = !btn.classList.contains('active')
      btn.classList.toggle('active', on)
      activeEditor.ann[s.key] = on
      applyEditorStyle(activeEditor.el, activeEditor.ann)
      activeEditor.el.focus()
    })
    return btn
  })

  const repeatLabel = document.createElement('label')
  repeatLabel.className = 'tb-check'
  repeatLabel.title = 'Repeat on every page (header / footer)'
  const repeatCb = document.createElement('input')
  repeatCb.type = 'checkbox'
  repeatCb.checked = isRepeat
  const repText = document.createElement('span')
  repText.textContent = 'Repeat'
  repeatLabel.append(repeatCb, repText)
  repeatCb.addEventListener('change', () => {
    if (!activeEditor) return
    activeEditor.isRepeat = repeatCb.checked
  })

  const doneBtn = document.createElement('button')
  doneBtn.type = 'button'
  doneBtn.className = 'tb-btn tb-done'
  doneBtn.title = 'Done (Enter)'
  doneBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
  doneBtn.addEventListener('click', () => commitEditor())

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'tb-btn tb-cancel'
  cancelBtn.title = 'Cancel (Esc)'
  cancelBtn.textContent = '×'
  cancelBtn.addEventListener('click', () => cancelEditor())

  tb.append(fontSel, sizeInput, colorInput, ...styleBtns, repeatLabel, doneBtn, cancelBtn)
  return tb
}

function positionToolbar(tb: HTMLElement, editorEl: HTMLElement): void {
  const refs = useEditorRefs()
  const overlay = refs.textOverlay.value
  if (!overlay) return
  const ow = overlay.clientWidth
  const editorTop = parseFloat(editorEl.style.top) || 0
  const editorLeft = parseFloat(editorEl.style.left) || 0
  const editorH = editorEl.offsetHeight || 24
  const tbW = tb.offsetWidth || 320
  const tbH = tb.offsetHeight || 36
  let top = editorTop - tbH - 10
  if (top < 0) top = editorTop + editorH + 10
  let left = editorLeft
  if (left + tbW > ow) left = Math.max(0, ow - tbW - 4)
  if (left < 0) left = 0
  tb.style.top = `${top}px`
  tb.style.left = `${left}px`
}

function onEditorKeydown(e: KeyboardEvent): void {
  if (!activeEditor) return
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    commitEditor()
    return
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    cancelEditor()
    return
  }
  if (e.ctrlKey || e.metaKey) {
    const k = e.key.toLowerCase()
    if (k === 'b' || k === 'i' || k === 'u') {
      e.preventDefault()
      const map: Record<string, 'bold' | 'italic' | 'underline'> = {
        b: 'bold',
        i: 'italic',
        u: 'underline',
      }
      const key = map[k]
      const on = !activeEditor.ann[key]
      activeEditor.ann[key] = on
      applyEditorStyle(activeEditor.el, activeEditor.ann)
      const btn = activeEditor.toolbar.querySelector<HTMLButtonElement>(
        `.tb-style[data-style-key="${key}"]`,
      )
      if (btn) btn.classList.toggle('active', on)
    }
  }
}

export function commitEditor(): void {
  if (!activeEditor) return
  const { el, toolbar, ann, isNew, sourceArr, isRepeat } = activeEditor
  const text = (el.innerText || '').replace(/\s+$/g, '').trim()
  el.remove()
  toolbar.remove()
  activeEditor = null

  const pdf = usePdfStore()
  if (!text) {
    if (!isNew && sourceArr) {
      const idx = sourceArr.indexOf(ann)
      if (idx >= 0) sourceArr.splice(idx, 1)
      toast('Text removed')
    }
    drawTextOverlays()
    return
  }

  ann.text = text
  if (isNew) {
    if (isRepeat) {
      delete (ann as { pageOriginalIdx?: number }).pageOriginalIdx
      pdf.addRepeatText(ann)
    } else {
      ann.pageOriginalIdx = pdf.pageOrder[pdf.currentPage]
      pdf.addTextAnnotation(ann)
    }
    toast('Text added — drag to move, double-click to edit', 'success')
  } else {
    const wasRepeat = sourceArr === pdf.repeatTexts
    if (wasRepeat !== isRepeat) {
      const fromArr = wasRepeat ? pdf.repeatTexts : pdf.textAnnotations
      const idx = fromArr.indexOf(ann)
      if (idx >= 0) fromArr.splice(idx, 1)
      if (isRepeat) {
        delete (ann as { pageOriginalIdx?: number }).pageOriginalIdx
        pdf.addRepeatText(ann)
      } else {
        ann.pageOriginalIdx = pdf.pageOrder[pdf.currentPage]
        pdf.addTextAnnotation(ann)
      }
    }
  }
  drawTextOverlays()
}

export function cancelEditor(): void {
  if (!activeEditor) return
  const { el, toolbar, sourceEl } = activeEditor
  el.remove()
  toolbar.remove()
  if (sourceEl) sourceEl.style.visibility = ''
  activeEditor = null
}
