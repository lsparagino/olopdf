import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import type { FontFamily } from '@/utils/pdf'
import type { PageDiff } from '@/composables/useCompareDiff'

export interface TextAnnotation {
  pageOriginalIdx?: number
  x: number
  y: number
  text: string
  size: number
  color: string
  font: FontFamily
  bold: boolean
  italic: boolean
  underline: boolean
}

export interface Bookmark {
  title: string
  pageOriginalIdx: number
  x?: number
  y?: number
  // Outline depth. 0 = top level. A bookmark's level can be at most predecessor.level + 1
  // (no skipping levels). Persisted as part of the user's manual ordering — auto-sort by
  // page is no longer applied once hierarchy is in play.
  level: number
}

export interface MergeFile {
  name: string
  bytes: ArrayBuffer
}

export interface CompareDocLike {
  numPages: number
  getPage(n: number): Promise<unknown>
}

export interface CompareSide {
  name: string
  doc: CompareDocLike
  numPages: number
}

export interface CompareState {
  left: CompareSide | null
  right: CompareSide | null
  textOnly: boolean
  diffs: PageDiff[]
  currentPage: number
  fitMode: boolean
  zoom: number
}

export interface PendingTextPlacement {
  text: string
  size: number
  color: string
  font: FontFamily
  bold: boolean
  italic: boolean
  underline: boolean
  repeat: boolean
}

export interface CapturedSelection {
  text: string
  x: number
  y: number
  pageOriginalIdx: number
}

interface PdfjsDocLike {
  numPages: number
  getPage(pageNumber: number): Promise<unknown>
}

export type InteractionMode = 'select' | 'pan'
export type ViewMode = 'single' | 'double'
// 'width' fits the widest page across the container, 'page' fits a whole page
// (or spread) into the viewport, 'none' means the user pinned an explicit zoom.
// The two fit modes stay active so a window/sidebar resize re-fits.
export type FitMode = 'width' | 'page' | 'none'

export interface PdfStoreState {
  filePath: string | null
  pdfBytes: ArrayBuffer | null
  pdfjsDoc: PdfjsDocLike | null
  pageOrder: number[]
  pageRotations: Record<number, number>
  bookmarks: Bookmark[]
  textAnnotations: TextAnnotation[]
  repeatTexts: TextAnnotation[]
  currentPage: number
  zoom: number
  fitMode: FitMode
  thumbCache: Map<number, string>
  pendingTextPlacement: PendingTextPlacement | null
  capturedSelection: CapturedSelection | null
  gridMode: boolean
  interactionMode: InteractionMode
  // Side-by-side two-page display. The right page is render-only (no
  // overlays / no edit affordances) so editing flows still operate on the
  // single "current page" left side. doublePageGap toggles a visible gap
  // between the two pages.
  viewMode: ViewMode
  doublePageGap: boolean
  mergeFiles: MergeFile[]
  compare: CompareState
}

export const PDF_CONFIG = Object.freeze({
  CURATOR_URL: 'https://olopad.com',
  THUMB_TARGET_WIDTH: 240,
  GRID_THUMB_TARGET_WIDTH: 360,
  RECENTS_LIMIT: 5,
  ZOOM_STEP: 0.15,
  WHEEL_ZOOM_STEP: 0.1,
  ZOOM_MIN: 0.2,
  ZOOM_MAX: 5,
  CANVAS_PADDING: 48,
  // Vertical gap between stacked pages in the continuous flow, and the number of
  // rows painted beyond the viewport on each side so a fast scroll lands on
  // already-rendered pages instead of blanks.
  PAGE_GAP_PX: 16,
  RENDER_OVERSCAN_ROWS: 2,
  TEXT_DRAG_THRESHOLD_PX: 2,
  TOAST_DURATION_MS: 2400,
  COMPARE_VISUAL_RENDER_SCALE: 1.5,
  COMPARE_VISUAL_TILE: 16,
  COMPARE_VISUAL_THRESHOLD: 800,
  COMPARE_TEXT_LCS_LIMIT: 4000,
})

function initialCompareState(): CompareState {
  return {
    left: null,
    right: null,
    textOnly: true,
    diffs: [],
    currentPage: 0,
    fitMode: true,
    zoom: 1.0,
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

export const usePdfStore = defineStore('pdf', {
  state: (): PdfStoreState => ({
    filePath: null,
    pdfBytes: null,
    pdfjsDoc: null,
    pageOrder: [],
    pageRotations: {},
    bookmarks: [],
    textAnnotations: [],
    repeatTexts: [],
    currentPage: 0,
    zoom: 1.0,
    fitMode: 'width',
    thumbCache: new Map(),
    pendingTextPlacement: null,
    capturedSelection: null,
    gridMode: false,
    interactionMode: 'select',
    viewMode: 'single',
    doublePageGap: true,
    mergeFiles: [],
    compare: initialCompareState(),
  }),

  getters: {
    currentOrigIdx(): number | null {
      return this.pageOrder[this.currentPage] ?? null
    },
  },

  actions: {
    resetForNewDocument(
      bytes: ArrayBuffer,
      filePath: string | null,
      doc: PdfjsDocLike,
      numPages: number,
    ) {
      this.pdfBytes = bytes
      this.filePath = filePath
      // markRaw: pdf.js's PDFDocumentProxy uses private class fields (#pagePromises).
      // Pinia's reactive Proxy intercepts access and the private field throws because
      // the Proxy is not the class instance that declared it. Store the raw object so
      // pdf.js methods see their own `this`.
      this.pdfjsDoc = markRaw(doc)
      this.pageOrder = Array.from({ length: numPages }, (_, i) => i)
      this.pageRotations = {}
      this.bookmarks = []
      this.textAnnotations = []
      this.repeatTexts = []
      this.currentPage = 0
      this.zoom = 1.0
      this.fitMode = 'width'
      this.thumbCache = markRaw(new Map())
      this.gridMode = false
      this.pendingTextPlacement = null
      this.capturedSelection = null
    },

    setZoom(z: number) {
      this.zoom = clamp(z, PDF_CONFIG.ZOOM_MIN, PDF_CONFIG.ZOOM_MAX)
    },
    zoomIn() {
      this.fitMode = 'none'
      this.setZoom(this.zoom + PDF_CONFIG.ZOOM_STEP)
    },
    zoomOut() {
      this.fitMode = 'none'
      this.setZoom(this.zoom - PDF_CONFIG.ZOOM_STEP)
    },
    zoomFitPage() {
      this.fitMode = 'page'
    },
    zoomFitWidth() {
      this.fitMode = 'width'
    },
    wheelZoom(direction: 1 | -1) {
      this.fitMode = 'none'
      this.setZoom(this.zoom + direction * PDF_CONFIG.WHEEL_ZOOM_STEP)
    },

    deletePageAt(uiIdx: number): boolean {
      if (this.pageOrder.length <= 1) return false
      const removedOrig = this.pageOrder[uiIdx]
      this.pageOrder.splice(uiIdx, 1)
      this.textAnnotations = this.textAnnotations.filter((a) => a.pageOriginalIdx !== removedOrig)
      this.bookmarks = this.bookmarks.filter((b) => b.pageOriginalIdx !== removedOrig)
      this.normalizeBookmarkLevels()
      delete this.pageRotations[removedOrig]
      this.thumbCache.delete(removedOrig)
      if (this.currentPage >= this.pageOrder.length) this.currentPage = this.pageOrder.length - 1
      return true
    },

    rotatePage(uiIdx: number, dir: 'cw' | 'ccw'): number | null {
      const origIdx = this.pageOrder[uiIdx]
      if (origIdx === undefined) return null
      const current = this.pageRotations[origIdx] ?? 0
      const delta = dir === 'cw' ? 90 : -90
      const next = ((current + delta) % 360 + 360) % 360
      if (next === 0) delete this.pageRotations[origIdx]
      else this.pageRotations[origIdx] = next
      // Thumb cache is keyed on origIdx with no rotation dimension; invalidate it.
      this.thumbCache.delete(origIdx)
      return next
    },

    rotationFor(origIdx: number): number {
      return this.pageRotations[origIdx] ?? 0
    },

    movePageOrder(src: number, dest: number) {
      const [moved] = this.pageOrder.splice(src, 1)
      let target = dest
      if (src < target) target -= 1
      this.pageOrder.splice(target, 0, moved)
      if (this.currentPage === src) this.currentPage = target
      else if (src < this.currentPage && target >= this.currentPage) this.currentPage--
      else if (src > this.currentPage && target <= this.currentPage) this.currentPage++
      // Bookmarks sort by page position; reorder pages → resort bookmarks → re-clamp levels.
      this.sortBookmarks()
      this.normalizeBookmarkLevels()
    },

    setCurrentPage(uiIdx: number) {
      if (uiIdx < 0 || uiIdx >= this.pageOrder.length) return
      this.currentPage = uiIdx
    },
    nextPage() {
      this.setCurrentPage(this.currentPage + 1)
    },
    prevPage() {
      this.setCurrentPage(this.currentPage - 1)
    },

    toggleGridMode(force?: boolean) {
      this.gridMode = typeof force === 'boolean' ? force : !this.gridMode
    },

    setInteractionMode(mode: InteractionMode) {
      this.interactionMode = mode
    },

    setViewMode(mode: ViewMode) {
      this.viewMode = mode
    },
    toggleViewMode() {
      this.viewMode = this.viewMode === 'double' ? 'single' : 'double'
    },
    toggleDoublePageGap() {
      this.doublePageGap = !this.doublePageGap
    },

    addBookmark(b: Bookmark) {
      this.bookmarks.push(b)
      this.sortBookmarks()
      this.normalizeBookmarkLevels()
    },
    removeBookmark(idx: number) {
      this.bookmarks.splice(idx, 1)
      this.normalizeBookmarkLevels()
    },
    renameBookmark(idx: number, title: string) {
      const t = title.trim()
      if (!t) return
      this.bookmarks[idx].title = t
    },
    sortBookmarks() {
      this.bookmarks.sort((a, b) => {
        const pa = this.pageOrder.indexOf(a.pageOriginalIdx)
        const pb = this.pageOrder.indexOf(b.pageOriginalIdx)
        if (pa !== pb) return pa - pb
        const ya = a.y ?? 0
        const yb = b.y ?? 0
        if (ya !== yb) return ya - yb
        return (a.x ?? 0) - (b.x ?? 0)
      })
    },
    setBookmarkLevel(idx: number, level: number) {
      if (idx < 0 || idx >= this.bookmarks.length) return
      this.bookmarks[idx].level = Math.max(0, level)
      this.normalizeBookmarkLevels()
    },
    // Clamp every bookmark's level to (predecessor.level + 1) so the tree never
    // has a gap (a level-2 with no level-1 ancestor). Run after any structural
    // change.
    normalizeBookmarkLevels() {
      let prev = -1
      for (const b of this.bookmarks) {
        const max = prev + 1
        if (b.level > max) b.level = max
        if (b.level < 0) b.level = 0
        prev = b.level
      }
    },

    addTextAnnotation(ann: TextAnnotation) {
      this.textAnnotations.push(ann)
    },
    removeTextAnnotation(ann: TextAnnotation) {
      const i = this.textAnnotations.indexOf(ann)
      if (i >= 0) this.textAnnotations.splice(i, 1)
    },
    addRepeatText(ann: TextAnnotation) {
      this.repeatTexts.push(ann)
    },
    removeRepeatText(ann: TextAnnotation) {
      const i = this.repeatTexts.indexOf(ann)
      if (i >= 0) this.repeatTexts.splice(i, 1)
    },
  },
})
