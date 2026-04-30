import { onBeforeUnmount, onMounted } from 'vue'
import { PDF_CONFIG, usePdfStore } from '@/stores/pdf'
import { useEditorRefs } from '@/composables/useEditorRefs'
import { renderCurrentPage } from '@/composables/usePdfRenderer'
import { gotoPage } from '@/composables/usePageActions'

const FLIP_THRESHOLD = 30
const OVERFLOW_TOLERANCE = 2

function normalizeWheelDelta(e: WheelEvent): number {
  if (e.deltaMode === 1) return e.deltaY * 16
  if (e.deltaMode === 2) return e.deltaY * 600
  return e.deltaY
}

// Wheel-zoom: CSS-resize on each tick (keeps the previously rendered bitmap visible —
// momentarily blurry, but no flicker), then debounce-render the crisp bitmap.
function applyCssZoom(): void {
  const pdf = usePdfStore()
  const refs = useEditorRefs()
  const stage = refs.canvasStage.value
  const canvas = refs.pdfCanvas.value
  const overlay = refs.textOverlay.value
  const layer = refs.textLayer.value
  if (!pdf.baseViewport || !stage || !canvas) return
  const w = pdf.baseViewport.width * pdf.zoom
  const h = pdf.baseViewport.height * pdf.zoom
  stage.style.width = `${w}px`
  stage.style.height = `${h}px`
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
  if (overlay) {
    overlay.style.width = `${w}px`
    overlay.style.height = `${h}px`
  }
  // The text-layer spans have absolute positions baked in at the rendered zoom; hide
  // the layer until the debounced render rebuilds the spans at the new zoom.
  if (layer) layer.style.visibility = 'hidden'
  refs.zoomLabel.value = `${Math.round(pdf.zoom * 100)}%`
  // Placed-text overlay reads pdf.zoom directly, so it'll move on the next reactive tick.
}

export function useZoomPan(canvasWrapEl: () => HTMLElement | null) {
  const pdf = usePdfStore()
  const refs = useEditorRefs()
  let zoomDebounceTimer: ReturnType<typeof setTimeout> | null = null
  let wheelAcc = 0
  let wheelDir = 0
  let isFlipping = false
  let cleanups: Array<() => void> = []

  function onWheelZoomEvent(e: Event) {
    const detail = (e as CustomEvent<{ direction: 1 | -1 }>).detail
    pdf.wheelZoom(detail.direction)
    applyCssZoom()
    if (zoomDebounceTimer) clearTimeout(zoomDebounceTimer)
    zoomDebounceTimer = setTimeout(async () => {
      zoomDebounceTimer = null
      await renderCurrentPage()
      const layer = refs.textLayer.value
      if (layer) layer.style.visibility = ''
    }, 120)
  }

  function onZoomKey(e: Event) {
    const detail = (e as CustomEvent<'in' | 'out' | 'fit'>).detail
    if (detail === 'in') pdf.zoomIn()
    else if (detail === 'out') pdf.zoomOut()
    else pdf.zoomFit()
    void renderCurrentPage()
  }

  function onWheel(e: WheelEvent) {
    if (e.ctrlKey || e.metaKey) return // chrome defense intercepts these
    if (pdf.gridMode) return
    const wrap = e.currentTarget as HTMLElement
    const deltaY = normalizeWheelDelta(e)
    const dir = Math.sign(deltaY)
    if (!dir) return

    const overflow = wrap.scrollHeight - wrap.clientHeight
    const canScroll = overflow > OVERFLOW_TOLERANCE
    const atTop = wrap.scrollTop <= 0
    const atBottom =
      wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - OVERFLOW_TOLERANCE
    const atEdge = (dir > 0 && atBottom) || (dir < 0 && atTop)

    if (canScroll && !atEdge) {
      wheelAcc = 0
      return
    }

    e.preventDefault()
    if (isFlipping) return
    if (wheelDir !== dir) {
      wheelDir = dir
      wheelAcc = 0
    }
    wheelAcc += Math.abs(deltaY)
    if (wheelAcc < FLIP_THRESHOLD) return
    wheelAcc = 0

    const target = pdf.currentPage + dir
    if (target < 0 || target >= pdf.pageOrder.length) return
    isFlipping = true
    gotoPage(target)
      .then(() => {
        const w = canvasWrapEl()
        if (!w) {
          isFlipping = false
          return
        }
        if (dir < 0) w.scrollTop = Math.max(0, w.scrollHeight - w.clientHeight)
        else w.scrollTop = 0
        isFlipping = false
      })
      .catch(() => {
        isFlipping = false
      })
  }

  function startPan(e: MouseEvent) {
    const wrap = canvasWrapEl()
    const stage = refs.canvasStage.value
    if (!wrap || !stage) return
    const canPanX = wrap.scrollWidth > wrap.clientWidth
    const canPanY = wrap.scrollHeight > wrap.clientHeight
    if (!canPanX && !canPanY) return

    e.preventDefault()
    stage.classList.add('panning')
    let lastX = e.clientX
    let lastY = e.clientY
    function onMove(ev: MouseEvent) {
      if (canPanX) wrap!.scrollLeft -= ev.clientX - lastX
      if (canPanY) wrap!.scrollTop -= ev.clientY - lastY
      lastX = ev.clientX
      lastY = ev.clientY
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      stage!.classList.remove('panning')
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // Resize re-fit (only while in fit-mode and not in grid-mode)
  let resizeRaf: number | null = null
  function onResize() {
    if (pdf.gridMode || !pdf.fitMode) return
    if (resizeRaf) cancelAnimationFrame(resizeRaf)
    resizeRaf = requestAnimationFrame(() => {
      void renderCurrentPage()
    })
  }

  onMounted(() => {
    window.addEventListener('pdf:wheel-zoom', onWheelZoomEvent)
    window.addEventListener('pdf:zoom-key', onZoomKey)
    window.addEventListener('resize', onResize)
    cleanups.push(
      () => window.removeEventListener('pdf:wheel-zoom', onWheelZoomEvent),
      () => window.removeEventListener('pdf:zoom-key', onZoomKey),
      () => window.removeEventListener('resize', onResize),
    )
  })

  onBeforeUnmount(() => {
    cleanups.forEach((fn) => fn())
    cleanups = []
    if (zoomDebounceTimer) clearTimeout(zoomDebounceTimer)
    if (resizeRaf) cancelAnimationFrame(resizeRaf)
  })

  return {
    onWheel,
    startPan,
    applyCssZoom,
    onZoomInClick: () => {
      pdf.zoomIn()
      void renderCurrentPage()
    },
    onZoomOutClick: () => {
      pdf.zoomOut()
      void renderCurrentPage()
    },
    onZoomFitClick: () => {
      pdf.zoomFit()
      void renderCurrentPage()
    },
  }
}
