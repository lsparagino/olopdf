import { useEditorRefs } from '@/composables/useEditorRefs'
import { usePdfStore, type CapturedSelection } from '@/stores/pdf'
import { gotoPage } from '@/composables/usePageActions'
import { forwardTransform, inverseTransform, unrotatedDims } from '@/utils/pdf'

export function captureCanvasSelection(): CapturedSelection | null {
  const refs = useEditorRefs()
  const stage = refs.canvasStage.value
  const canvas = refs.pdfCanvas.value
  if (!stage || !canvas) return null
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  if (!stage.contains(range.startContainer)) return null
  const text = sel.toString().trim()
  if (!text) return null
  const rect = range.getBoundingClientRect()
  const cr = canvas.getBoundingClientRect()
  const cxs = rect.left - cr.left
  const cys = rect.top - cr.top
  const pdf = usePdfStore()
  const scale = pdf.zoom
  const origIdx = pdf.pageOrder[pdf.currentPage]
  const rotation = pdf.rotationFor(origIdx)
  const bv = pdf.baseViewport
  const dims = bv ? unrotatedDims(bv.width, bv.height, rotation) : { uW: 0, uH: 0 }
  const { x, y } = inverseTransform(cxs / scale, cys / scale, dims.uW, dims.uH, rotation)
  return {
    text,
    x,
    y,
    pageOriginalIdx: origIdx,
  }
}

export async function gotoBookmark(b: { pageOriginalIdx: number; x?: number; y?: number }): Promise<void> {
  const pdf = usePdfStore()
  const uiPage = pdf.pageOrder.indexOf(b.pageOriginalIdx)
  if (uiPage < 0) return
  if (pdf.gridMode) pdf.toggleGridMode(false)
  await gotoPage(uiPage)
  if (b.x !== undefined && b.y !== undefined) {
    const refs = useEditorRefs()
    const wrap = refs.canvasWrap.value
    if (!wrap) return
    const rotation = pdf.rotationFor(b.pageOriginalIdx)
    const bv = pdf.baseViewport
    const dims = bv ? unrotatedDims(bv.width, bv.height, rotation) : { uW: 0, uH: 0 }
    const { cx, cy } = forwardTransform(b.x, b.y, dims.uW, dims.uH, rotation)
    wrap.scrollTo({
      left: Math.max(0, cx * pdf.zoom - 60),
      top: Math.max(0, cy * pdf.zoom - 60),
      behavior: 'smooth',
    })
  }
}
