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
  fitMode: boolean
  thumbCache: Map<number, string>
  baseViewport: { width: number; height: number } | null
  renderedZoom: number | null
  pendingTextPlacement: PendingTextPlacement | null
  capturedSelection: CapturedSelection | null
  gridMode: boolean
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
    fitMode: true,
    thumbCache: new Map(),
    baseViewport: null,
    renderedZoom: null,
    pendingTextPlacement: null,
    capturedSelection: null,
    gridMode: false,
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
      this.fitMode = true
      this.thumbCache = markRaw(new Map())
      this.gridMode = false
      this.baseViewport = null
      this.renderedZoom = null
      this.pendingTextPlacement = null
      this.capturedSelection = null
    },

    setZoom(z: number) {
      this.zoom = clamp(z, PDF_CONFIG.ZOOM_MIN, PDF_CONFIG.ZOOM_MAX)
    },
    zoomIn() {
      this.fitMode = false
      this.setZoom(this.zoom + PDF_CONFIG.ZOOM_STEP)
    },
    zoomOut() {
      this.fitMode = false
      this.setZoom(this.zoom - PDF_CONFIG.ZOOM_STEP)
    },
    zoomFit() {
      this.fitMode = true
    },
    wheelZoom(direction: 1 | -1) {
      this.fitMode = false
      this.setZoom(this.zoom + direction * PDF_CONFIG.WHEEL_ZOOM_STEP)
    },

    deletePageAt(uiIdx: number): boolean {
      if (this.pageOrder.length <= 1) return false
      const removedOrig = this.pageOrder[uiIdx]
      this.pageOrder.splice(uiIdx, 1)
      this.textAnnotations = this.textAnnotations.filter((a) => a.pageOriginalIdx !== removedOrig)
      this.bookmarks = this.bookmarks.filter((b) => b.pageOriginalIdx !== removedOrig)
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

    addBookmark(b: Bookmark) {
      this.bookmarks.push(b)
      this.sortBookmarks()
    },
    removeBookmark(idx: number) {
      this.bookmarks.splice(idx, 1)
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
