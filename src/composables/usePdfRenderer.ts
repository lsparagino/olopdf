import { usePdfStore, PDF_CONFIG } from '@/stores/pdf'
import { usePdfjs } from '@/composables/usePdfEngine'
import { useEditorRefs } from '@/composables/useEditorRefs'

interface RenderTaskLike {
  promise: Promise<void>
  cancel(): void
}

interface PdfPageLike {
  getViewport(opts: { scale: number; rotation?: number }): {
    width: number
    height: number
    transform: number[]
  }
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): RenderTaskLike
  getTextContent(): Promise<{
    items: Array<{ str: string; transform: number[]; fontName: string }>
    styles?: Record<string, { fontFamily?: string }>
  }>
}

let activeRenderTask: RenderTaskLike | null = null
let activeRightRenderTask: RenderTaskLike | null = null

// CSS-pixel gap drawn between the two pages in double-page mode when
// pdf.doublePageGap is on. Constant, not zoom-scaled.
const DOUBLE_PAGE_GAP_PX = 16

export async function renderCurrentPage(): Promise<void> {
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
  const rotation = pdf.rotationFor(origIdx)

  const baseViewport = page.getViewport({ scale: 1, rotation })

  // In double mode, also load the right page so the fit calculation accounts
  // for the combined width and the maximum height across both pages. Skipped
  // when there's no next page (last page; we render single-page on the left).
  const rightPageInfo = await loadRightPage()

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
  activeRenderTask = null

  pdf.baseViewport = { width: baseViewport.width, height: baseViewport.height }
  pdf.renderedZoom = scale
  refs.zoomLabel.value = `${Math.round(pdf.zoom * 100)}%`

  await renderTextLayer(page, viewport)

  // Right page (double-page view). Hidden if there's no next page or we're in
  // single-page mode. Rendered after the left page so layout is stable when
  // overlays / search highlights re-position from the page-rendered event.
  await renderRightPage(rightPageInfo, scale)

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

async function renderTextLayer(
  page: PdfPageLike,
  viewport: { width: number; height: number; transform: number[] },
): Promise<void> {
  const refs = useEditorRefs()
  const layer = refs.textLayer.value
  if (!layer) return
  layer.innerHTML = ''
  layer.style.width = `${viewport.width}px`
  layer.style.height = `${viewport.height}px`
  try {
    const textContent = await page.getTextContent()
    const styles = textContent.styles ?? {}
    const fragment = document.createDocumentFragment()
    const pdfjs = usePdfjs() as unknown as {
      Util: {
        transform(a: number[], b: number[]): number[]
      }
    }
    // One span per text-content item — INCLUDING items we'd otherwise skip
    // (empty str / zero font-height). Skipped items get an invisible
    // placeholder span instead of being dropped, so the rendered span at
    // index i always corresponds to textContent.items[i]. useTextSearch
    // builds its match offsets against the full items array; if the
    // renderer dropped some, applyHighlights would land on the wrong span
    // and visually highlight a neighboring cell.
    for (const item of textContent.items) {
      const span = document.createElement('span')
      fragment.appendChild(span)
      if (!item.str) {
        span.style.display = 'none'
        continue
      }
      const tx = pdfjs.Util.transform(viewport.transform, item.transform)
      const angle = Math.atan2(tx[1], tx[0])
      const fontHeight = Math.hypot(tx[2], tx[3])
      if (fontHeight <= 0) {
        span.style.display = 'none'
        continue
      }
      span.textContent = item.str
      span.style.left = `${tx[4]}px`
      span.style.top = `${tx[5] - fontHeight}px`
      span.style.fontSize = `${fontHeight}px`
      const family = styles[item.fontName]?.fontFamily ?? 'sans-serif'
      span.style.fontFamily = family
      if (angle !== 0) span.style.transform = `rotate(${angle}rad)`
    }
    // Sentinel used by the drag-selection clamp in EditorScreen.vue. Must be the
    // last child of the text layer; its dynamic `top` positioning relies on it
    // covering the area below the mousedown point.
    const endOfContent = document.createElement('div')
    endOfContent.className = 'end-of-content'
    fragment.appendChild(endOfContent)
    layer.appendChild(fragment)
  } catch (e) {
    console.warn('Text layer render failed', e)
  }
}
