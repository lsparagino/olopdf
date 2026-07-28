import { nextTick } from 'vue'
import { usePdfStore } from '@/stores/pdf'
import { invalidatePage, measurePage } from '@/composables/usePageMetrics'
import { scrollToPage, setFitAnchor } from '@/composables/useViewerScroll'
import { toast } from '@/composables/useToast'

// "Go to page" is a scroll in the continuous flow, not a re-render. nextTick lets
// the row heights settle first when the call follows a structural change.
export async function gotoPage(
  uiIdx: number,
  behavior: ScrollBehavior = 'smooth',
): Promise<void> {
  const pdf = usePdfStore()
  if (uiIdx < 0 || uiIdx >= pdf.pageOrder.length) return
  pdf.setCurrentPage(uiIdx)
  await nextTick()
  scrollToPage(uiIdx, behavior)
}

export async function deletePage(uiIdx: number): Promise<void> {
  const pdf = usePdfStore()
  if (!pdf.deletePageAt(uiIdx)) {
    toast('Cannot delete the only page', 'error')
    return
  }
  await nextTick()
  scrollToPage(pdf.currentPage, 'auto')
  // Bookmarks may have been purged; refresh dependent views.
  window.dispatchEvent(new CustomEvent('pdf:bookmarks-changed'))
  toast('Page removed')
}

export async function movePage(src: number, dest: number): Promise<void> {
  const pdf = usePdfStore()
  pdf.movePageOrder(src, dest)
  await nextTick()
  scrollToPage(pdf.currentPage, 'auto')
  window.dispatchEvent(new CustomEvent('pdf:bookmarks-changed'))
}

export async function rotatePage(uiIdx: number, dir: 'cw' | 'ccw'): Promise<void> {
  const pdf = usePdfStore()
  const origIdx = pdf.pageOrder[uiIdx]
  const next = pdf.rotatePage(uiIdx, dir)
  if (next === null) return
  // The page box swaps for 90/270, so its cached measurement is stale — remeasure
  // before the flow relays out, otherwise the row briefly keeps the old height.
  invalidatePage(origIdx)
  await measurePage(origIdx, next)
  // Rotating swaps the page's aspect ratio, so re-point the fit modes at it —
  // rotating a page to read it and having the zoom ignore it is the wrong answer.
  setFitAnchor(uiIdx)
  await nextTick()
  scrollToPage(uiIdx, 'auto')
  toast(dir === 'cw' ? 'Rotated clockwise' : 'Rotated counter-clockwise')
}
