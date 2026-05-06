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
  let scale = pdf.zoom
  if (pdf.fitMode) {
    const aw = wrap.clientWidth - PDF_CONFIG.CANVAS_PADDING
    const ah = wrap.clientHeight - PDF_CONFIG.CANVAS_PADDING
    scale = Math.min(aw / baseViewport.width, ah / baseViewport.height)
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

  // Notify composables that listen (text overlay redraw, active-thumb highlight, etc.)
  // without forcing them to import this module.
  window.dispatchEvent(
    new CustomEvent('pdf:page-rendered', { detail: { viewport, scale } }),
  )
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
    for (const item of textContent.items) {
      if (!item.str) continue
      const tx = pdfjs.Util.transform(viewport.transform, item.transform)
      const angle = Math.atan2(tx[1], tx[0])
      const fontHeight = Math.hypot(tx[2], tx[3])
      if (fontHeight <= 0) continue
      const span = document.createElement('span')
      span.textContent = item.str
      span.style.left = `${tx[4]}px`
      span.style.top = `${tx[5] - fontHeight}px`
      span.style.fontSize = `${fontHeight}px`
      const family = styles[item.fontName]?.fontFamily ?? 'sans-serif'
      span.style.fontFamily = family
      if (angle !== 0) span.style.transform = `rotate(${angle}rad)`
      fragment.appendChild(span)
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
