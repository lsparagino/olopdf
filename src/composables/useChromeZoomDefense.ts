import { onBeforeUnmount, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { usePdfStore } from '@/stores/pdf'

// Layer 2 of the renderer-side zoom defense.
// Why: Chromium leaks zoom through any single defense — without these capture-phase
// listeners, Ctrl+= / Ctrl+- / Ctrl+0 / Ctrl+wheel zoom the whole UI even with
// webFrame.setZoomFactor and main-process resets in place. The intercept reroutes
// those gestures to the PDF zoom engine via a custom event that zoom-pan listens to.
export function useChromeZoomDefense() {
  const route = useRoute()
  const pdf = usePdfStore()

  function inEditorActive(): boolean {
    return route.name === 'editor' && !pdf.gridMode
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!(e.ctrlKey || e.metaKey)) return
    if (!['+', '=', '-', '_', '0'].includes(e.key)) return
    e.preventDefault()
    e.stopPropagation()
    if (!inEditorActive()) return
    const detail = e.key === '0' ? 'fit' : e.key === '-' || e.key === '_' ? 'out' : 'in'
    window.dispatchEvent(new CustomEvent('pdf:zoom-key', { detail }))
  }

  function onWheel(e: WheelEvent) {
    if (!(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    e.stopPropagation()
    if (!inEditorActive()) return
    window.dispatchEvent(
      new CustomEvent('pdf:wheel-zoom', { detail: { direction: e.deltaY < 0 ? 1 : -1 } }),
    )
  }

  function onDragOver(e: DragEvent) {
    e.preventDefault()
  }
  function onDrop(e: DragEvent) {
    e.preventDefault()
  }

  onMounted(() => {
    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('wheel', onWheel, { capture: true, passive: false })
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeyDown, { capture: true })
    window.removeEventListener('wheel', onWheel, { capture: true })
    window.removeEventListener('dragover', onDragOver)
    window.removeEventListener('drop', onDrop)
  })
}
