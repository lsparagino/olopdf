import { nextTick } from 'vue'
import { usePdfStore, type CapturedSelection } from '@/stores/pdf'
import { pageElsFromNode } from '@/composables/usePageElements'
import { pageSize } from '@/composables/usePageMetrics'
import { gotoPage } from '@/composables/usePageActions'
import { scrollToPagePoint } from '@/composables/useViewerScroll'
import { forwardTransform, inverseTransform, unrotatedDims } from '@/utils/pdf'

export function captureCanvasSelection(): CapturedSelection | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  // With every page stacked in one scroll container the selection can start on
  // any of them, so the anchor page comes from the range itself rather than from
  // pdf.currentPage. A selection dragged across a page break anchors to the page
  // it started on, which is also where its first line — and the bookmark — sits.
  const els = pageElsFromNode(range.startContainer)
  if (!els) return null
  // A selection spanning several lines carries the text layer's line breaks; a
  // bookmark title is a single-line field, so fold them into spaces.
  const text = sel.toString().replace(/\s+/g, ' ').trim()
  if (!text) return null
  // The FIRST client rect, not the bounding one: getBoundingClientRect unions
  // every line in the range, so on a multi-line selection its left edge belongs
  // to whichever line starts furthest left, and on a selection dragged across a
  // page break it straddles both pages and means nothing.
  const rects = range.getClientRects()
  const rect = rects.length > 0 ? rects[0] : range.getBoundingClientRect()
  const cr = els.canvas.getBoundingClientRect()
  const cxs = rect.left - cr.left
  const cys = rect.top - cr.top
  const pdf = usePdfStore()
  const scale = pdf.zoom
  const rotation = pdf.rotationFor(els.origIdx)
  const size = pageSize(els.origIdx, rotation)
  const dims = unrotatedDims(size.width, size.height, rotation)
  const { x, y } = inverseTransform(cxs / scale, cys / scale, dims.uW, dims.uH, rotation)
  return {
    text,
    x,
    y,
    pageOriginalIdx: els.origIdx,
  }
}

export async function gotoBookmark(b: {
  pageOriginalIdx: number
  x?: number
  y?: number
}): Promise<void> {
  const pdf = usePdfStore()
  const uiPage = pdf.pageOrder.indexOf(b.pageOriginalIdx)
  if (uiPage < 0) return
  if (pdf.gridMode) {
    pdf.toggleGridMode(false)
    // The page flow is v-if'd away in grid mode; wait for it back before scrolling.
    await nextTick()
  }
  if (b.x === undefined || b.y === undefined) {
    await gotoPage(uiPage)
    return
  }
  const rotation = pdf.rotationFor(b.pageOriginalIdx)
  const size = pageSize(b.pageOriginalIdx, rotation)
  const dims = unrotatedDims(size.width, size.height, rotation)
  const { cx, cy } = forwardTransform(b.x, b.y, dims.uW, dims.uH, rotation)
  pdf.setCurrentPage(uiPage)
  scrollToPagePoint(uiPage, cx * pdf.zoom, cy * pdf.zoom)
}
