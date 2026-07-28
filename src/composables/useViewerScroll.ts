// Geometry and scrolling for the continuous page flow.
//
// Pages are stacked in one scroll container. Every row's box is given an explicit
// pixel height derived from the numbers in this module, so the arithmetic here
// and the rendered CSS agree exactly — that is what lets "scroll to page 12" be a
// plain scrollTop assignment instead of a DOM measurement, and what keeps the
// current-page readout honest without reading layout on every scroll frame.
//
// Row = one page in single view, one spread (two pages) in double view. Scrolling
// therefore advances a spread at a time in double view for free.

import { computed, ref, type ComputedRef } from 'vue'
import { PDF_CONFIG, usePdfStore } from '@/stores/pdf'
import { useEditorRefs } from '@/composables/useEditorRefs'
import { pageSize } from '@/composables/usePageMetrics'

export interface ViewerPage {
  uiIdx: number
  origIdx: number
  rotation: number
  // Unscaled (scale-1) page box, already accounting for rotation.
  width: number
  height: number
}

export interface ViewerRow {
  key: string
  rowIdx: number
  pages: ViewerPage[]
  // Unscaled width/height of the row. gapPx is a constant CSS gap and is NOT
  // multiplied by the zoom, so it is tracked apart from the scaled dimensions.
  width: number
  height: number
  gapPx: number
}

export interface RowGeom {
  top: number
  height: number
}

export interface ScrollAnchor {
  // Anchored to a page rather than a row index: rows are re-paired when the user
  // toggles double view, so a row index captured before the change points
  // somewhere else entirely after it.
  uiIdx: number
  fraction: number
  leftFraction: number
}

// Half of CANVAS_PADDING: the padding is expressed as a total (both sides) for
// the fit maths, but the flow needs the one-sided value for scroll offsets.
const EDGE_PAD = PDF_CONFIG.CANVAS_PADDING / 2
const SCROLLEND_FALLBACK_MS = 600
// Where down the viewport the "page you are reading" line sits.
const READING_LINE_RATIO = 0.33

const containerWidth = ref(0)
const containerHeight = ref(0)
const renderRange = ref<{ start: number; end: number }>({ start: 0, end: 0 })
// Which page the fit modes measure themselves against. Deliberately NOT the
// scroll-derived current page — see fitScale().
const fitAnchorPage = ref(0)

// Set while a programmatic (smooth) scroll is in flight so the scroll handler
// doesn't fight it — otherwise "go to page 40" would keep re-deriving
// currentPage from the pages flying past and the sidebar would strobe.
let suppressScrollSync = false
let suppressTimer: ReturnType<typeof setTimeout> | null = null

let rowsRef: ComputedRef<ViewerRow[]> | null = null
let geomRef: ComputedRef<RowGeom[]> | null = null
let fitScaleRef: ComputedRef<number | null> | null = null

function clampZoom(z: number): number {
  return Math.max(PDF_CONFIG.ZOOM_MIN, Math.min(PDF_CONFIG.ZOOM_MAX, z))
}

export function viewerRows(): ComputedRef<ViewerRow[]> {
  if (rowsRef) return rowsRef
  rowsRef = computed<ViewerRow[]>(() => {
    const pdf = usePdfStore()
    const step = pdf.viewMode === 'double' ? 2 : 1
    const rows: ViewerRow[] = []
    for (let i = 0; i < pdf.pageOrder.length; i += step) {
      const pages: ViewerPage[] = []
      for (let k = 0; k < step && i + k < pdf.pageOrder.length; k++) {
        const uiIdx = i + k
        const origIdx = pdf.pageOrder[uiIdx]
        const rotation = pdf.rotationFor(origIdx)
        const size = pageSize(origIdx, rotation)
        pages.push({ uiIdx, origIdx, rotation, width: size.width, height: size.height })
      }
      let width = 0
      let height = 0
      for (const p of pages) {
        width += p.width
        height = Math.max(height, p.height)
      }
      rows.push({
        key: pages.map((p) => p.origIdx).join('-'),
        rowIdx: rows.length,
        pages,
        width,
        height,
        gapPx: pages.length > 1 && pdf.doublePageGap ? PDF_CONFIG.PAGE_GAP_PX : 0,
      })
    }
    return rows
  })
  return rowsRef
}

// Running tops for every row, in scroll-container coordinates.
export function rowGeoms(): ComputedRef<RowGeom[]> {
  if (geomRef) return geomRef
  geomRef = computed<RowGeom[]>(() => {
    const pdf = usePdfStore()
    const rows = viewerRows().value
    const out: RowGeom[] = []
    let top = EDGE_PAD
    for (const row of rows) {
      const height = Math.round(row.height * pdf.zoom)
      out.push({ top, height })
      top += height + PDF_CONFIG.PAGE_GAP_PX
    }
    return out
  })
  return geomRef
}

// Fit-to-width / fit-to-page scale.
//
// Measured against ONE anchor row — the page the user was on when they asked for
// the fit — not against the widest row in the document. Fitting the widest would
// shrink an entire 86-page report to 35% because two landscape pages exist
// somewhere in it; re-measuring on every scroll would instead re-zoom (and so
// reflow) the whole document the moment a differently sized page came into view.
// Anchoring is what pdf.js's own viewer does, and it keeps the scale stable while
// scrolling while still reacting to a resize.
export function fitScale(): ComputedRef<number | null> {
  if (fitScaleRef) return fitScaleRef
  fitScaleRef = computed<number | null>(() => {
    const pdf = usePdfStore()
    if (pdf.fitMode === 'none') return null
    const rows = viewerRows().value
    if (rows.length === 0) return null
    const cw = containerWidth.value
    const ch = containerHeight.value
    if (cw <= 0) return null

    const anchor =
      rows[Math.min(rowIndexForPage(fitAnchorPage.value), rows.length - 1)] ?? rows[0]
    if (!anchor || anchor.width <= 0 || anchor.height <= 0) return null

    const availW = cw - PDF_CONFIG.CANVAS_PADDING - anchor.gapPx
    if (availW <= 0) return null
    const scaleW = availW / anchor.width
    if (pdf.fitMode === 'width') return clampZoom(scaleW)

    const availH = ch - PDF_CONFIG.CANVAS_PADDING
    if (availH <= 0) return clampZoom(scaleW)
    return clampZoom(Math.min(scaleW, availH / anchor.height))
  })
  return fitScaleRef
}

// Re-points the fit modes at a page. Called when the user asks for a fit, when
// the spread layout changes, and when a page is rotated — never from scrolling.
export function setFitAnchor(uiIdx: number): void {
  fitAnchorPage.value = Math.max(0, uiIdx)
}

export function setContainerSize(width: number, height: number): void {
  containerWidth.value = width
  containerHeight.value = height
}

// Module state outlives the editor screen — memory-history routing keeps this
// module loaded across welcome ↔ editor round trips — so opening a second
// document has to clear it.
export function resetViewerScroll(): void {
  renderRange.value = { start: 0, end: 0 }
  containerWidth.value = 0
  containerHeight.value = 0
  fitAnchorPage.value = 0
  suppressScrollSync = false
  if (suppressTimer) {
    clearTimeout(suppressTimer)
    suppressTimer = null
  }
}

export function useViewerScroll() {
  return { renderRange, containerWidth, containerHeight }
}

export function rowIndexForPage(uiIdx: number): number {
  const pdf = usePdfStore()
  return pdf.viewMode === 'double' ? Math.floor(uiIdx / 2) : uiIdx
}

export function firstPageOfRow(rowIdx: number): number {
  const pdf = usePdfStore()
  return pdf.viewMode === 'double' ? rowIdx * 2 : rowIdx
}

// First row whose bottom edge is still below the viewport top.
function firstRowAt(geoms: RowGeom[], scrollTop: number): number {
  let lo = 0
  let hi = geoms.length - 1
  let found = geoms.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (geoms[mid].top + geoms[mid].height > scrollTop) {
      found = mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return Math.max(0, found)
}

// The row the user is "on": whichever one crosses a horizontal reading line a
// third of the way down the viewport.
//
// A "most visible row" rule reads better on paper but is ambiguous whenever the
// viewport shows two or three rows at once, and needs hysteresis to stop the
// readout flickering. The reading line moves monotonically with the scroll, so it
// crosses each boundary exactly once and needs no damping at all.
export function currentRowFromScroll(): number {
  const wrap = useEditorRefs().canvasWrap.value
  const geoms = rowGeoms().value
  if (!wrap || geoms.length === 0) return 0
  // At the very end of the document the line can fall past the last page while
  // the user is plainly looking at it.
  if (wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 2) return geoms.length - 1
  const line = wrap.scrollTop + wrap.clientHeight * READING_LINE_RATIO
  return Math.min(firstRowAt(geoms, line), geoms.length - 1)
}

export function computeRenderRange(): { start: number; end: number } {
  const wrap = useEditorRefs().canvasWrap.value
  const geoms = rowGeoms().value
  if (!wrap || geoms.length === 0) return { start: 0, end: 0 }
  const top = wrap.scrollTop
  const bottom = top + wrap.clientHeight
  const first = firstRowAt(geoms, top)
  let last = first
  while (last + 1 < geoms.length && geoms[last + 1].top < bottom) last++
  return {
    start: Math.max(0, first - PDF_CONFIG.RENDER_OVERSCAN_ROWS),
    end: Math.min(geoms.length - 1, last + PDF_CONFIG.RENDER_OVERSCAN_ROWS),
  }
}

export function refreshRenderRange(): void {
  const next = computeRenderRange()
  const cur = renderRange.value
  if (cur.start !== next.start || cur.end !== next.end) renderRange.value = next
}

function beginProgrammaticScroll(): void {
  suppressScrollSync = true
  if (suppressTimer) clearTimeout(suppressTimer)
  const wrap = useEditorRefs().canvasWrap.value
  function end() {
    suppressScrollSync = false
    if (suppressTimer) clearTimeout(suppressTimer)
    suppressTimer = null
    wrap?.removeEventListener('scrollend', end)
  }
  // scrollend is the accurate signal (Chromium 114+); the timer is the safety net
  // for the case where the target offset equals the current one and no scroll —
  // and therefore no scrollend — ever fires.
  wrap?.addEventListener('scrollend', end, { once: true })
  suppressTimer = setTimeout(end, SCROLLEND_FALLBACK_MS)
}

export function isScrollSyncSuppressed(): boolean {
  return suppressScrollSync
}

export function scrollToPage(uiIdx: number, behavior: ScrollBehavior = 'smooth'): void {
  const wrap = useEditorRefs().canvasWrap.value
  if (!wrap) return
  const geoms = rowGeoms().value
  const rowIdx = rowIndexForPage(uiIdx)
  const g = geoms[rowIdx]
  if (!g) return
  beginProgrammaticScroll()
  wrap.scrollTo({
    top: Math.max(0, g.top - EDGE_PAD),
    left: horizontalTarget(rowIdx, 0.5),
    behavior,
  })
  refreshRenderRange()
}

// Where scrollLeft should sit for a row. A row narrower than the viewport is
// always centred: one landscape page anywhere in the document widens the whole
// flow, and without this every portrait page would sit jammed against an edge.
// Only a row too wide to fit keeps the caller's relative position.
function horizontalTarget(rowIdx: number, fraction: number): number {
  const wrap = useEditorRefs().canvasWrap.value
  const row = viewerRows().value[rowIdx]
  if (!wrap || !row) return 0
  const rowWidth = row.width * usePdfStore().zoom + row.gapPx
  const f = rowWidth <= wrap.clientWidth ? 0.5 : fraction
  return Math.max(0, rowLeftOffset(row) + f * rowWidth - wrap.clientWidth / 2)
}

// Scrolls so that a point given in the page's own scaled CSS pixels sits near the
// top-left of the viewport. Used by bookmark anchors and find-in-document.
export function scrollToPagePoint(uiIdx: number, cx: number, cy: number, margin = 60): void {
  const wrap = useEditorRefs().canvasWrap.value
  if (!wrap) return
  const geoms = rowGeoms().value
  const rows = viewerRows().value
  const rowIdx = rowIndexForPage(uiIdx)
  const g = geoms[rowIdx]
  const row = rows[rowIdx]
  if (!g || !row) return
  const pdf = usePdfStore()

  // Horizontal offset of this page inside its row (the left page of a spread
  // starts at 0, the right one after the left page's width plus the gap).
  let offsetX = 0
  for (const p of row.pages) {
    if (p.uiIdx === uiIdx) break
    offsetX += p.width * pdf.zoom + row.gapPx
  }
  const rowLeft = rowLeftOffset(row)
  beginProgrammaticScroll()
  wrap.scrollTo({
    top: Math.max(0, g.top + cy - margin),
    left: Math.max(0, rowLeft + offsetX + cx - margin),
    behavior: 'smooth',
  })
  refreshRenderRange()
}

// The flow centres each row, so a row narrower than the content box is inset.
function rowLeftOffset(row: ViewerRow): number {
  const pdf = usePdfStore()
  const rows = viewerRows().value
  let widest = 0
  for (const r of rows) {
    const w = r.width * pdf.zoom + r.gapPx
    if (w > widest) widest = w
  }
  const own = row.width * pdf.zoom + row.gapPx
  const wrap = useEditorRefs().canvasWrap.value
  const contentWidth = Math.max(widest, (wrap?.clientWidth ?? 0) - PDF_CONFIG.CANVAS_PADDING)
  return EDGE_PAD + Math.max(0, (contentWidth - own) / 2)
}

export function captureScrollAnchor(): ScrollAnchor | null {
  const wrap = useEditorRefs().canvasWrap.value
  const geoms = rowGeoms().value
  if (!wrap || geoms.length === 0) return null
  const docY = wrap.scrollTop + wrap.clientHeight / 2
  const rowIdx = Math.min(firstRowAt(geoms, docY), geoms.length - 1)
  const g = geoms[rowIdx]
  const fraction = g.height > 0 ? (docY - g.top) / g.height : 0
  const row = viewerRows().value[rowIdx]
  const rowWidth = row ? row.width * usePdfStore().zoom + row.gapPx : 0
  // Horizontal position is captured relative to the row's own box, not to the
  // whole flow: the flow's width is set by the widest page in the document and
  // says nothing about where the reader is inside the page in front of them.
  const leftFraction =
    row && rowWidth > 0
      ? (wrap.scrollLeft + wrap.clientWidth / 2 - rowLeftOffset(row)) / rowWidth
      : 0.5
  return {
    uiIdx: firstPageOfRow(rowIdx),
    fraction,
    leftFraction: Math.max(0, Math.min(1, leftFraction)),
  }
}

// Restores a captured anchor after the flow has been re-laid-out at a new zoom.
// Must run once the DOM has the new row heights, i.e. after nextTick().
export function restoreScrollAnchor(anchor: ScrollAnchor | null): void {
  if (!anchor) return
  const wrap = useEditorRefs().canvasWrap.value
  const geoms = rowGeoms().value
  if (!wrap || geoms.length === 0) return
  // Resolved now, not when the anchor was captured: between the two the rows may
  // have been re-paired into spreads or a page may have been deleted.
  const rowIdx = Math.min(rowIndexForPage(anchor.uiIdx), geoms.length - 1)
  const g = geoms[rowIdx]
  wrap.scrollTop = Math.max(0, g.top + anchor.fraction * g.height - wrap.clientHeight / 2)
  wrap.scrollLeft = horizontalTarget(rowIdx, anchor.leftFraction)
  refreshRenderRange()
}
