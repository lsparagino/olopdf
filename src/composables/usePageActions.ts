import { usePdfStore } from '@/stores/pdf'
import { renderCurrentPage } from '@/composables/usePdfRenderer'
import { toast } from '@/composables/useToast'

export async function gotoPage(uiIdx: number): Promise<void> {
  const pdf = usePdfStore()
  if (uiIdx < 0 || uiIdx >= pdf.pageOrder.length) return
  pdf.setCurrentPage(uiIdx)
  await renderCurrentPage()
}

export async function deletePage(uiIdx: number): Promise<void> {
  const pdf = usePdfStore()
  if (!pdf.deletePageAt(uiIdx)) {
    toast('Cannot delete the only page', 'error')
    return
  }
  await renderCurrentPage()
  // Bookmarks may have been purged; refresh dependent views.
  window.dispatchEvent(new CustomEvent('pdf:bookmarks-changed'))
  toast('Page removed')
}

export async function movePage(src: number, dest: number): Promise<void> {
  const pdf = usePdfStore()
  pdf.movePageOrder(src, dest)
  await renderCurrentPage()
  window.dispatchEvent(new CustomEvent('pdf:bookmarks-changed'))
}

export async function rotatePage(uiIdx: number, dir: 'cw' | 'ccw'): Promise<void> {
  const pdf = usePdfStore()
  const next = pdf.rotatePage(uiIdx, dir)
  if (next === null) return
  // Re-fit after rotation since the page's aspect ratio swaps for 90/270.
  pdf.fitMode = true
  await renderCurrentPage()
  toast(dir === 'cw' ? 'Rotated clockwise' : 'Rotated counter-clockwise')
}
