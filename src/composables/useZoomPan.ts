import { nextTick, onBeforeUnmount, onMounted, watch } from 'vue'
import { usePdfStore } from '@/stores/pdf'
import { useEditorRefs } from '@/composables/useEditorRefs'
import {
  captureScrollAnchor,
  fitScale,
  restoreScrollAnchor,
  scrollToPage,
  setContainerSize,
  setFitAnchor,
} from '@/composables/useViewerScroll'

// Zoom and pan for the continuous viewer.
//
// The wheel is deliberately NOT handled here any more: the pages are stacked in a
// real scroll container, so plain wheel scrolling is the browser's job and stays
// smooth. Only Ctrl+wheel and Ctrl+±/0 reach us, routed through the capture-phase
// listeners in useChromeZoomDefense as 'pdf:wheel-zoom' / 'pdf:zoom-key'.
export function useZoomPan() {
  const pdf = usePdfStore()
  const refs = useEditorRefs()
  let resizeObserver: ResizeObserver | null = null
  let cleanups: Array<() => void> = []

  // Every zoom change is bracketed by an anchor capture/restore so the point the
  // user was looking at stays under the cursor instead of the flow collapsing
  // back to wherever scrollTop happens to land after the reflow.
  async function withZoomAnchor(mutate: () => void): Promise<void> {
    const anchor = captureScrollAnchor()
    mutate()
    await nextTick()
    restoreScrollAnchor(anchor)
  }

  function onWheelZoomEvent(e: Event) {
    const detail = (e as CustomEvent<{ direction: 1 | -1 }>).detail
    void withZoomAnchor(() => pdf.wheelZoom(detail.direction))
  }

  function onZoomKey(e: Event) {
    const detail = (e as CustomEvent<'in' | 'out' | 'fit'>).detail
    if (detail === 'in') void withZoomAnchor(() => pdf.zoomIn())
    else if (detail === 'out') void withZoomAnchor(() => pdf.zoomOut())
    else onZoomFitPageClick()
  }

  function startPan(e: MouseEvent) {
    const wrap = refs.canvasWrap.value
    if (!wrap) return
    // No can-pan snapshot: the scroll setters clamp themselves, and in a
    // continuous document a downward pan can enter a wider page mid-drag.
    e.preventDefault()
    wrap.classList.add('panning')
    let lastX = e.clientX
    let lastY = e.clientY
    function onMove(ev: MouseEvent) {
      wrap!.scrollLeft -= ev.clientX - lastX
      wrap!.scrollTop -= ev.clientY - lastY
      lastX = ev.clientX
      lastY = ev.clientY
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      // A mouseup outside the Electron window is never delivered; without the
      // blur fallback the viewer stays stuck in .panning with a grabbing cursor.
      window.removeEventListener('blur', onUp)
      wrap!.classList.remove('panning')
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    window.addEventListener('blur', onUp)
  }

  function onZoomInClick() {
    void withZoomAnchor(() => pdf.zoomIn())
  }
  function onZoomOutClick() {
    void withZoomAnchor(() => pdf.zoomOut())
  }

  // Both fit handlers set the new zoom themselves rather than leaving it to the
  // fitScale watcher. Two independent async reactions to the same click — the
  // watcher restoring its anchor and the handler scrolling — landed in
  // unpredictable order and the loser's scroll position was silently discarded.
  // Setting the scale here means the watcher sees no change and stands down.
  function applyFit(mutate: () => void): number | null {
    setFitAnchor(pdf.currentPage)
    mutate()
    const scale = fitScale().value
    if (scale !== null) pdf.setZoom(scale)
    return scale
  }

  function onZoomFitWidthClick() {
    const anchor = captureScrollAnchor()
    applyFit(() => pdf.zoomFitWidth())
    void nextTick(() => restoreScrollAnchor(anchor))
  }

  // Fitting a whole page only reads as "fit" if that page is the one on screen,
  // so this one snaps to the current page instead of holding the scroll anchor.
  function onZoomFitPageClick() {
    applyFit(() => pdf.zoomFitPage())
    void nextTick(() => scrollToPage(pdf.currentPage, 'auto'))
  }

  onMounted(() => {
    const wrap = refs.canvasWrap.value
    if (wrap) {
      setContainerSize(wrap.clientWidth, wrap.clientHeight)
      // ResizeObserver rather than window 'resize': the right sidebar is
      // user-resizable, and dragging it changes the viewer's width without the
      // window ever resizing.
      resizeObserver = new ResizeObserver(() => {
        const el = refs.canvasWrap.value
        if (el) setContainerSize(el.clientWidth, el.clientHeight)
      })
      resizeObserver.observe(wrap)
    }

    window.addEventListener('pdf:wheel-zoom', onWheelZoomEvent)
    window.addEventListener('pdf:zoom-key', onZoomKey)
    cleanups.push(
      () => window.removeEventListener('pdf:wheel-zoom', onWheelZoomEvent),
      () => window.removeEventListener('pdf:zoom-key', onZoomKey),
    )
  })

  // Fit modes stay live: the computed scale reacts to container size, page
  // measurements landing, rotation, and single/double view, and pushes the result
  // into the store.
  watch(
    fitScale(),
    (scale) => {
      if (scale === null) return
      if (Math.abs(scale - pdf.zoom) < 0.0005) return
      void withZoomAnchor(() => pdf.setZoom(scale))
    },
    { immediate: true },
  )

  watch(
    () => pdf.zoom,
    (z) => {
      refs.zoomLabel.value = `${Math.round(z * 100)}%`
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    cleanups.forEach((fn) => fn())
    cleanups = []
    resizeObserver?.disconnect()
    resizeObserver = null
  })

  return {
    startPan,
    onZoomInClick,
    onZoomOutClick,
    onZoomFitWidthClick,
    onZoomFitPageClick,
  }
}
