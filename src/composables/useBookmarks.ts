import { useEditorRefs } from '@/composables/useEditorRefs'
import { usePdfStore, type CapturedSelection } from '@/stores/pdf'
import { gotoPage } from '@/composables/usePageActions'

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
  const cx = rect.left - cr.left
  const cy = rect.top - cr.top
  const pdf = usePdfStore()
  const scale = pdf.zoom
  return {
    text,
    x: cx / scale,
    y: cy / scale,
    pageOriginalIdx: pdf.pageOrder[pdf.currentPage],
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
    wrap.scrollTo({
      left: Math.max(0, b.x * pdf.zoom - 60),
      top: Math.max(0, b.y * pdf.zoom - 60),
      behavior: 'smooth',
    })
  }
}
