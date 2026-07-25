import { usePdfStore, PDF_CONFIG } from '@/stores/pdf'
import { usePdfjs } from '@/composables/usePdfEngine'
import { useEditorRefs } from '@/composables/useEditorRefs'
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

let activeRenderTask: RenderTaskLike | null = null
let activeRightRenderTask: RenderTaskLike | null = null

// Every renderCurrentPage() call claims a token and abandons its work as soon as
// a newer call has claimed one. Page loads and getTextContent() are async and
// renderCurrentPage is fired from a dozen places (page flips, zoom debounce,
// resize, rotate, delete), so without this a slow render of page N can land
// after page N+1 and leave page N's spans in the text layer above page N+1's
// bitmap — selection then picks up text that isn't on screen at all.
let renderToken = 0

// CSS-pixel gap drawn between the two pages in double-page mode when
// pdf.doublePageGap is on. Constant, not zoom-scaled.
const DOUBLE_PAGE_GAP_PX = 16

export async function renderCurrentPage(): Promise<void> {
  const token = ++renderToken
  const pdf = usePdfStore()
  const refs = useEditorRefs()
  const wrap = refs.canvasWrap.value
  const canvas = refs.pdfCanvas.value
  const stage = refs.canvasStage.value
  if (!pdf.pdfjsDoc || !wrap || !canvas || !stage) return
  if (pdf.pageOrder.length === 0) return
  if (pdf.currentPage >= pdf.pageOrder.length) pdf.currentPage = pdf.pageOrder.length - 1
  if (pdf.currentPage < 0) pdf.currentPage = 0

  const origIdx = pdf.pageOrder[pdf.currentPage]
  const page = (await pdf.pdfjsDoc.getPage(origIdx + 1)) as PdfPageLike
  if (token !== renderToken) return
  const rotation = pdf.rotationFor(origIdx)

  const baseViewport = page.getViewport({ scale: 1, rotation })

  // In double mode, also load the right page so the fit calculation accounts
  // for the combined width and the maximum height across both pages. Skipped
  // when there's no next page (last page; we render single-page on the left).
  const rightPageInfo = await loadRightPage()
  if (token !== renderToken) return

  let scale = pdf.zoom
  if (pdf.fitMode) {
    const gap = rightPageInfo && pdf.doublePageGap ? DOUBLE_PAGE_GAP_PX : 0
    const aw = wrap.clientWidth - PDF_CONFIG.CANVAS_PADDING - gap
    const ah = wrap.clientHeight - PDF_CONFIG.CANVAS_PADDING
    const totalW = baseViewport.width + (rightPageInfo?.baseViewport.width ?? 0)
    const maxH = Math.max(baseViewport.height, rightPageInfo?.baseViewport.height ?? 0)
    scale = Math.min(aw / totalW, ah / maxH)
    if (!isFinite(scale) || scale <= 0) scale = 1.0
    pdf.zoom = scale
  }

  const viewport = page.getViewport({ scale, rotation })
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.floor(viewport.width * dpr)
  canvas.height = Math.floor(viewport.height * dpr)
  canvas.style.width = `${viewport.width}px`
  canvas.style.height = `${viewport.height}px`

  stage.style.width = `${viewport.width}px`
  stage.style.height = `${viewport.height}px`

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  if (activeRenderTask) {
    try {
      activeRenderTask.cancel()
    } catch {
      /* ignore */
    }
  }
  activeRenderTask = page.render({ canvasContext: ctx, viewport })
  try {
    await activeRenderTask.promise
  } catch {
    /* cancelled */
  }
  // A newer render owns activeRenderTask by now — don't clear its handle.
  if (token !== renderToken) return
  activeRenderTask = null

  pdf.baseViewport = { width: baseViewport.width, height: baseViewport.height }
  pdf.renderedZoom = scale
  refs.zoomLabel.value = `${Math.round(pdf.zoom * 100)}%`

  await renderTextLayer(page, origIdx, viewport, scale, token)
  if (token !== renderToken) return

  // Right page (double-page view). Hidden if there's no next page or we're in
  // single-page mode. Rendered after the left page so layout is stable when
  // overlays / search highlights re-position from the page-rendered event.
  await renderRightPage(rightPageInfo, scale)
  if (token !== renderToken) return

  // Notify composables that listen (text overlay redraw, active-thumb highlight, etc.)
  // without forcing them to import this module.
  window.dispatchEvent(
    new CustomEvent('pdf:page-rendered', { detail: { viewport, scale } }),
  )
}

interface RightPageInfo {
  page: PdfPageLike
  rotation: number
  baseViewport: { width: number; height: number }
}

async function loadRightPage(): Promise<RightPageInfo | null> {
  const pdf = usePdfStore()
  if (pdf.viewMode !== 'double') return null
  const rightUiIdx = pdf.currentPage + 1
  if (rightUiIdx >= pdf.pageOrder.length) return null
  const origIdx = pdf.pageOrder[rightUiIdx]
  const rotation = pdf.rotationFor(origIdx)
  const page = (await pdf.pdfjsDoc!.getPage(origIdx + 1)) as PdfPageLike
  const vp = page.getViewport({ scale: 1, rotation })
  return { page, rotation, baseViewport: { width: vp.width, height: vp.height } }
}

async function renderRightPage(info: RightPageInfo | null, scale: number): Promise<void> {
  const refs = useEditorRefs()
  const stage2 = refs.canvasStage2.value
  const canvas2 = refs.pdfCanvas2.value
  if (!stage2 || !canvas2) return

  if (!info) {
    stage2.style.display = 'none'
    return
  }

  stage2.style.display = ''
  const viewport = info.page.getViewport({ scale, rotation: info.rotation })
  const dpr = window.devicePixelRatio || 1
  canvas2.width = Math.floor(viewport.width * dpr)
  canvas2.height = Math.floor(viewport.height * dpr)
  canvas2.style.width = `${viewport.width}px`
  canvas2.style.height = `${viewport.height}px`
  stage2.style.width = `${viewport.width}px`
  stage2.style.height = `${viewport.height}px`

  const ctx = canvas2.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  if (activeRightRenderTask) {
    try {
      activeRightRenderTask.cancel()
    } catch {
      /* ignore */
    }
  }
  activeRightRenderTask = info.page.render({ canvasContext: ctx, viewport })
  try {
    await activeRightRenderTask.promise
  } catch {
    /* cancelled */
  }
  activeRightRenderTask = null
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

// Which page the spans sitting in the layer right now were built for. A page flip
// drops them up front — selecting text from the page you just left is worse than
// a moment with no text layer — while a re-render of the same page at a new zoom
// keeps them until the replacements are ready.
let textLayerFor: { layer: HTMLElement; pageOriginalIdx: number } | null = null

async function renderTextLayer(
  page: PdfPageLike,
  pageOriginalIdx: number,
  viewport: ViewportLike,
  scale: number,
  token: number,
): Promise<void> {
  const refs = useEditorRefs()
  const layer = refs.textLayer.value
  if (!layer) return

  if (
    textLayerFor?.layer !== layer ||
    textLayerFor.pageOriginalIdx !== pageOriginalIdx
  ) {
    layer.replaceChildren()
    textLayerFor = null
  }

  let items: TextItemLike[]
  let styles: Record<string, TextStyleLike>
  try {
    const textContent = await page.getTextContent()
    items = textContent.items
    styles = textContent.styles ?? {}
  } catch (e) {
    console.warn('Text layer render failed', e)
    if (token === renderToken) {
      layer.replaceChildren()
      textLayerFor = null
    }
    return
  }
  if (token !== renderToken || refs.textLayer.value !== layer) return

  layer.style.width = `${viewport.width}px`
  layer.style.height = `${viewport.height}px`

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
    layoutRun(span, item, styles[item.fontName], viewport.transform, scale, util)
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
  textLayerFor = { layer, pageOriginalIdx }
}
