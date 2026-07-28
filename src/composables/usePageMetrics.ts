// Per-page geometry cache for the continuous viewer.
//
// A stacked page flow has to know how tall every page is *before* it paints any
// of them, otherwise the scroll height would grow under the user's cursor as
// pages stream in. pdf.js only exposes page dimensions through
// getPage()/getViewport(), so we measure each page once and cache the result
// keyed by (originalIdx, rotation) — the very same pair the renderer hands to
// getViewport, so a cached measurement can never disagree with what ends up on
// the canvas.

import { effectScope, reactive, ref, watch } from 'vue'
import { usePdfStore } from '@/stores/pdf'

export interface PageSize {
  width: number
  height: number
}

interface PdfPageLike {
  getViewport(opts: { scale: number; rotation?: number }): { width: number; height: number }
}

const MEASURE_CHUNK = 24

const sizes = reactive(new Map<string, PageSize>())
const pagePromises = new Map<number, Promise<PdfPageLike | null>>()
const inFlight = new Set<string>()

// Stand-in for pages that have not been measured yet, so the flow has a
// plausible height for every row from the first frame. Real-world documents are
// almost always uniform, so this is usually already the exact answer.
const fallbackSize = ref<PageSize | null>(null)

let measureRun = 0
let docWatcherInstalled = false
// Detached so the watcher survives the editor screen unmounting. Installing it
// from a lifecycle hook would otherwise bind it to that component's scope, and a
// document opened after a round-trip through the welcome screen would keep the
// previous document's page sizes.
const metricsScope = effectScope(true)

function sizeKey(origIdx: number, rotation: number): string {
  return `${origIdx}:${rotation}`
}

function installDocWatcher(): void {
  if (docWatcherInstalled) return
  docWatcherInstalled = true
  const pdf = usePdfStore()
  metricsScope.run(() => {
    watch(
      () => pdf.pdfjsDoc,
      () => {
        resetPageMetrics()
        void measureAllPages()
      },
    )
  })
}

export function resetPageMetrics(): void {
  measureRun++
  sizes.clear()
  pagePromises.clear()
  inFlight.clear()
  fallbackSize.value = null
}

// Loads (and caches) a PDFPageProxy. pdf.js keeps its own page cache, but going
// through the store's doc handle on every call still costs a worker round-trip
// for the promise plumbing, and the continuous viewer asks for the same page on
// every scroll frame.
export function loadPage(origIdx: number): Promise<PdfPageLike | null> {
  const cached = pagePromises.get(origIdx)
  if (cached) return cached
  const pdf = usePdfStore()
  const doc = pdf.pdfjsDoc
  if (!doc) return Promise.resolve(null)
  const p = Promise.resolve(doc.getPage(origIdx + 1))
    .then((page) => page as PdfPageLike)
    .catch(() => null)
  pagePromises.set(origIdx, p)
  return p
}

// Cached dimensions, or the document-wide fallback while the real measurement is
// still in flight. Pure — safe to call from a render function.
export function pageSize(origIdx: number, rotation: number): PageSize {
  const hit = sizes.get(sizeKey(origIdx, rotation))
  if (hit) return hit
  const fb = fallbackSize.value
  if (!fb) return { width: 612, height: 792 }
  // A rotation the fallback was not measured at still flips the aspect ratio, so
  // the placeholder row keeps roughly the right shape.
  const quarter = (((Math.round(rotation / 90) % 4) + 4) % 4)
  if (quarter === 1 || quarter === 3) return { width: fb.height, height: fb.width }
  return fb
}

export function hasPageSize(origIdx: number, rotation: number): boolean {
  return sizes.has(sizeKey(origIdx, rotation))
}

export async function measurePage(origIdx: number, rotation: number): Promise<PageSize | null> {
  const key = sizeKey(origIdx, rotation)
  const hit = sizes.get(key)
  if (hit) return hit
  if (inFlight.has(key)) return null
  inFlight.add(key)
  try {
    const page = await loadPage(origIdx)
    if (!page) return null
    const vp = page.getViewport({ scale: 1, rotation })
    const size: PageSize = { width: vp.width, height: vp.height }
    sizes.set(key, size)
    if (!fallbackSize.value) fallbackSize.value = size
    return size
  } catch {
    return null
  } finally {
    inFlight.delete(key)
  }
}

// Fire-and-forget measurement, for callers that only need the layout to settle
// eventually (a page view mounting, a rotation landing).
export function ensureMeasured(origIdx: number, rotation: number): void {
  if (hasPageSize(origIdx, rotation)) return
  void measurePage(origIdx, rotation)
}

// A rotation changes the page's box, and the thumbnail/render caches key on
// origIdx alone — drop every rotation variant we hold for the page.
export function invalidatePage(origIdx: number): void {
  for (const key of [...sizes.keys()]) {
    if (key.startsWith(`${origIdx}:`)) sizes.delete(key)
  }
}

// Measures the whole document, first page first so the fallback is available
// immediately, then the rest in chunks that yield to the event loop. A 1000-page
// document would otherwise block the first paint for seconds.
export async function measureAllPages(): Promise<void> {
  installDocWatcher()
  const run = ++measureRun
  const pdf = usePdfStore()
  if (!pdf.pdfjsDoc) return
  const order = [...pdf.pageOrder]
  if (order.length === 0) return

  await measurePage(order[0], pdf.rotationFor(order[0]))
  if (run !== measureRun) return

  for (let i = 1; i < order.length; i += MEASURE_CHUNK) {
    const chunk = order.slice(i, i + MEASURE_CHUNK)
    await Promise.all(chunk.map((origIdx) => measurePage(origIdx, pdf.rotationFor(origIdx))))
    if (run !== measureRun) return
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (run !== measureRun) return
  }
}

export function usePageMetrics() {
  installDocWatcher()
  return { sizes, fallbackSize }
}
