import { usePdfjs } from '@/composables/usePdfEngine'
import { loadPage } from '@/composables/usePageMetrics'
import { pageElsAt, type PageEls } from '@/composables/usePageElements'
import { shouldScaleTextRun, textRunOrigin } from '@/utils/textLayer'

interface RenderTaskLike {
  promise: Promise<void>
  cancel(): void
}

interface ViewportLike {
  width: number
  height: number
  transform: number[]
}

interface TextItemLike {
  str: string
  dir?: string
  // Painted extent of the run in unscaled page units. Multiplied by the render
  // scale it is the exact width the glyphs occupy on the canvas.
  width: number
  height: number
  transform: number[]
  fontName: string
  hasEOL?: boolean
}

interface TextStyleLike {
  fontFamily?: string
  vertical?: boolean
}

interface PdfPageLike {
  getViewport(opts: { scale: number; rotation?: number }): ViewportLike
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): RenderTaskLike
  getTextContent(): Promise<{
    items: TextItemLike[]
    styles?: Record<string, TextStyleLike>
  }>
}

interface PdfjsUtilLike {
  Util: {
    transform(a: number[], b: number[]): number[]
  }
}

export interface RenderPageOpts {
  origIdx: number
  rotation: number
  scale: number
}

// Backing-store budget per page canvas. The continuous viewer keeps a handful of
// canvases alive at once, so an uncapped devicePixelRatio at high zoom would
// multiply into hundreds of megabytes long before Chromium's own per-canvas
// ceiling kicks in. Above the budget we drop back towards dpr 1 and let the
// browser upscale — a zoomed-in page is already being read at a size where the
// difference is invisible.
const MAX_CANVAS_PIXELS = 12_000_000

interface PageRenderState {
  // Per-page token. The single global token of the old one-page-at-a-time
  // renderer cannot work here: several pages render concurrently, so page 7
  // finishing would abandon page 8's in-flight work.
  token: number
  task: RenderTaskLike | null
  canvasKey: string | null
  textKey: string | null
}

const renderStates = new WeakMap<HTMLElement, PageRenderState>()

function stateFor(stage: HTMLElement): PageRenderState {
  let st = renderStates.get(stage)
  if (!st) {
    st = { token: 0, task: null, canvasKey: null, textKey: null }
    renderStates.set(stage, st)
  }
  return st
}

function renderKey(opts: RenderPageOpts, dpr: number): string {
  return `${opts.origIdx}:${opts.rotation}:${opts.scale.toFixed(4)}:${dpr.toFixed(2)}`
}

function effectiveDpr(width: number, height: number): number {
  const dpr = window.devicePixelRatio || 1
  const px = width * height
  if (px <= 0) return dpr
  const budgeted = Math.sqrt(MAX_CANVAS_PIXELS / px)
  return Math.max(1, Math.min(dpr, budgeted))
}

// Lays out the page box without painting it. Called on every scale change so the
// flow reflows immediately; the already-painted bitmap stretches with it (briefly
// soft) until the debounced repaint lands.
export function sizePageEls(els: PageEls, width: number, height: number): void {
  const w = `${width}px`
  const h = `${height}px`
  els.stage.style.width = w
  els.stage.style.height = h
  els.canvas.style.width = w
  els.canvas.style.height = h
  els.textLayer.style.width = w
  els.textLayer.style.height = h
  els.textOverlay.style.width = w
  els.textOverlay.style.height = h
}

export function isPageRendered(uiIdx: number): boolean {
  const els = pageElsAt(uiIdx)
  return !!els && els.stage.dataset.rendered === '1'
}

// Resolves once the page has a painted canvas and a built text layer. Used by
// find-in-document, which has to scroll to a span that may not exist yet.
export function waitForPage(uiIdx: number, timeoutMs = 3000): Promise<void> {
  if (isPageRendered(uiIdx)) return Promise.resolve()
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    function done() {
      window.removeEventListener('pdf:page-rendered', onRendered)
      if (timer) clearTimeout(timer)
      resolve()
    }
    function onRendered(e: Event) {
      const detail = (e as CustomEvent<{ uiIdx: number }>).detail
      if (detail?.uiIdx === uiIdx) done()
    }
    window.addEventListener('pdf:page-rendered', onRendered)
    timer = setTimeout(done, timeoutMs)
  })
}

export async function renderPage(els: PageEls, opts: RenderPageOpts): Promise<void> {
  const st = stateFor(els.stage)
  const page = await loadPage(opts.origIdx)
  if (!page) return
  const pdfPage = page as unknown as PdfPageLike

  const viewport = pdfPage.getViewport({ scale: opts.scale, rotation: opts.rotation })
  const dpr = effectiveDpr(viewport.width, viewport.height)
  const key = renderKey(opts, dpr)
  if (st.canvasKey === key && st.textKey === key) return

  const token = ++st.token
  sizePageEls(els, viewport.width, viewport.height)

  if (st.canvasKey !== key) {
    await paintCanvas(els, pdfPage, viewport, st, token)
    if (token !== st.token) return
    st.canvasKey = key
  }

  if (st.textKey !== key) {
    await renderTextLayer(els, pdfPage, viewport, opts, st, token)
    if (token !== st.token) return
    st.textKey = key
  }

  els.stage.dataset.rendered = '1'
  // Notify composables that listen (text overlay redraw, search highlights)
  // without forcing them to import this module.
  window.dispatchEvent(
    new CustomEvent('pdf:page-rendered', {
      detail: { uiIdx: els.uiIdx, origIdx: opts.origIdx, scale: opts.scale },
    }),
  )
}

async function paintCanvas(
  els: PageEls,
  page: PdfPageLike,
  viewport: ViewportLike,
  st: PageRenderState,
  token: number,
): Promise<void> {
  const dpr = effectiveDpr(viewport.width, viewport.height)
  const canvas = els.canvas
  canvas.width = Math.floor(viewport.width * dpr)
  canvas.height = Math.floor(viewport.height * dpr)
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  if (st.task) {
    try {
      st.task.cancel()
    } catch {
      /* ignore */
    }
  }
  const task = page.render({ canvasContext: ctx, viewport })
  st.task = task
  try {
    await task.promise
  } catch {
    /* cancelled or superseded */
  }
  // A newer render for this same page owns st.task by now — don't clear its handle.
  if (token === st.token) st.task = null
}

// Drops a page's pixels when it scrolls far enough out of view. Setting the
// canvas dimensions to zero is what actually frees the backing store; leaving the
// element in place keeps the flow geometry (and the CSS box) untouched.
//
// A page hosting the open inline text editor is never released — the user is
// looking straight at it, and tearing down the overlay would destroy the
// uncommitted edit.
export function releasePage(els: PageEls): void {
  if (els.textOverlay.querySelector('.inline-text-editor')) return
  const st = stateFor(els.stage)
  st.token++
  if (st.task) {
    try {
      st.task.cancel()
    } catch {
      /* ignore */
    }
    st.task = null
  }
  st.canvasKey = null
  st.textKey = null
  els.canvas.width = 0
  els.canvas.height = 0
  els.textLayer.replaceChildren()
  els.textOverlay.replaceChildren()
  delete els.stage.dataset.rendered
}

// ---------------------------------------------------------------------------
// Text-layer metrics
//
// The spans in the text layer are invisible; their only job is to sit exactly on
// top of the glyphs pdf.js painted so that the browser's own hit-testing maps a
// cursor position to the character the user is actually pointing at. Two
// corrections are what make that true, and both are lifted from pdf.js's
// TextLayer — dropping either one is what makes a hand-rolled text layer feel
// jumpy:
//
//   * vertical — pdf.js reports each run's *baseline*. A span's top edge belongs
//     one ascent above it, not one full em, or every line's box sits ~18% of a
//     line too high and the bottom fifth of each visible line hit-tests onto the
//     line below (drag sideways, drift 2px down, and the selection jumps a line).
//   * horizontal — the run is painted in the PDF's embedded font but the DOM
//     renders it in a substitute family, so its natural width is off by 3-8%
//     (measured across the sample documents). scaleX pins the span box back onto
//     the painted run, which keeps every character offset inside a long line
//     honest instead of drifting further out the further right you go.
// ---------------------------------------------------------------------------

const ASCENT_PROBE_FONT_SIZE = 30
const DEFAULT_ASCENT_RATIO = 0.8
const ascentRatios = new Map<string, number>()

let metricsCtx: CanvasRenderingContext2D | null | undefined
let metricsFont = ''

function getMetricsCtx(): CanvasRenderingContext2D | null {
  if (metricsCtx === undefined) {
    metricsCtx = document.createElement('canvas').getContext('2d', { alpha: false })
  }
  return metricsCtx
}

// Setting ctx.font re-resolves the font on every assignment, and a page can hold
// thousands of runs from a handful of families — hence the last-value guard.
function useMetricsFont(ctx: CanvasRenderingContext2D, font: string): void {
  if (font === metricsFont) return
  ctx.font = font
  metricsFont = font
}

function ascentRatioFor(fontFamily: string): number {
  const cached = ascentRatios.get(fontFamily)
  if (cached !== undefined) return cached
  let ratio = DEFAULT_ASCENT_RATIO
  const ctx = getMetricsCtx()
  if (ctx) {
    useMetricsFont(ctx, `${ASCENT_PROBE_FONT_SIZE}px ${fontFamily}`)
    const metrics = ctx.measureText('')
    const ascent = metrics.fontBoundingBoxAscent ?? 0
    const descent = Math.abs(metrics.fontBoundingBoxDescent ?? 0)
    if (ascent > 0 && ascent + descent > 0) ratio = ascent / (ascent + descent)
  }
  ascentRatios.set(fontFamily, ratio)
  return ratio
}

function horizontalScaleFor(
  text: string,
  targetWidth: number,
  fontSizePx: number,
  fontFamily: string,
): number | null {
  if (targetWidth <= 0) return null
  const ctx = getMetricsCtx()
  if (!ctx) return null
  useMetricsFont(ctx, `${fontSizePx}px ${fontFamily}`)
  const natural = ctx.measureText(text).width
  if (!Number.isFinite(natural) || natural <= 0) return null
  return targetWidth / natural
}

function layoutRun(
  span: HTMLSpanElement,
  item: TextItemLike,
  style: TextStyleLike | undefined,
  viewportTransform: number[],
  scale: number,
  util: PdfjsUtilLike['Util'],
): void {
  if (!item.str) {
    span.style.display = 'none'
    return
  }
  const tx = util.transform(viewportTransform, item.transform)
  const fontHeight = Math.hypot(tx[2], tx[3])
  if (fontHeight <= 0) {
    span.style.display = 'none'
    return
  }
  const fontFamily = style?.fontFamily ?? 'sans-serif'
  let angle = Math.atan2(tx[1], tx[0])
  if (style?.vertical) angle += Math.PI / 2
  const origin = textRunOrigin(tx, fontHeight * ascentRatioFor(fontFamily), angle)

  span.textContent = item.str
  if (item.dir) span.dir = item.dir
  span.style.left = `${origin.left}px`
  span.style.top = `${origin.top}px`
  span.style.fontSize = `${fontHeight}px`
  span.style.fontFamily = fontFamily

  // rotate() first so scaleX() applies along the run's own baseline.
  const transforms: string[] = []
  if (angle !== 0) transforms.push(`rotate(${(angle * 180) / Math.PI}deg)`)
  if (shouldScaleTextRun(item)) {
    const target = (style?.vertical ? item.height : item.width) * scale
    const factor = horizontalScaleFor(item.str, target, fontHeight, fontFamily)
    if (factor !== null) transforms.push(`scaleX(${factor})`)
  }
  if (transforms.length > 0) span.style.transform = transforms.join(' ')
}

async function renderTextLayer(
  els: PageEls,
  page: PdfPageLike,
  viewport: ViewportLike,
  opts: RenderPageOpts,
  st: PageRenderState,
  token: number,
): Promise<void> {
  const layer = els.textLayer
  // A page keeps its spans across a zoom change until the replacements are ready
  // — dropping them up front would make the document briefly unselectable on
  // every wheel tick. A page whose *content* changed (reorder put a different
  // original page in this slot) must not keep them, and st.textKey encodes that.
  if (st.textKey !== null && !st.textKey.startsWith(`${opts.origIdx}:${opts.rotation}:`)) {
    layer.replaceChildren()
  }

  let items: TextItemLike[]
  let styles: Record<string, TextStyleLike>
  try {
    const textContent = await page.getTextContent()
    items = textContent.items
    styles = textContent.styles ?? {}
  } catch (e) {
    console.warn('Text layer render failed', e)
    if (token === st.token) layer.replaceChildren()
    return
  }
  if (token !== st.token) return

  const util = (usePdfjs() as unknown as PdfjsUtilLike).Util
  const fragment = document.createDocumentFragment()
  // One span per text-content item — INCLUDING items we'd otherwise skip
  // (empty str / zero font-height). Skipped items get an invisible
  // placeholder span instead of being dropped, so the rendered span at
  // index i always corresponds to textContent.items[i]. useTextSearch
  // builds its match offsets against the full items array; if the
  // renderer dropped some, applyHighlights would land on the wrong span
  // and visually highlight a neighboring cell.
  for (const item of items) {
    const span = document.createElement('span')
    fragment.appendChild(span)
    layoutRun(span, item, styles[item.fontName], viewport.transform, opts.scale, util)
    // pdf.js flags the run that closes a visual line. The <br> sibling is what
    // makes a multi-line selection copy out as separate lines instead of one
    // glued run; it's positioned absolutely (see the .text-layer br rule) so it
    // can't disturb the spans around it. Search highlighting indexes
    // `:scope > span`, so the extra siblings don't shift anything.
    if (item.hasEOL) {
      const br = document.createElement('br')
      br.setAttribute('role', 'presentation')
      fragment.appendChild(br)
    }
  }
  // Sentinel used by the drag-selection clamp in EditorScreen.vue. Must be the
  // last child of the text layer; its dynamic `top` positioning relies on it
  // covering the area below the mousedown point.
  const endOfContent = document.createElement('div')
  endOfContent.className = 'end-of-content'
  fragment.appendChild(endOfContent)
  layer.replaceChildren(fragment)
}
