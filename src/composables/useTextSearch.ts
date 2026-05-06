// Document-wide text search. Builds a per-page text index lazily (concatenating
// pdf.js TextContent items into one string with item-boundary offsets), runs
// case-insensitive substring matching, and tracks a current match index for
// next/prev navigation. Highlights are applied by toggling classes on the
// existing text-layer spans — the layer is rebuilt on every page render, so
// applyHighlights() must be re-invoked after each render.
//
// The cache is keyed on pageOriginalIdx; reordering / deleting pages leaves
// existing entries valid. Loading a different document does invalidate them,
// so we watch pdf.pdfjsDoc and clear on switch.

import { computed, ref, watch } from 'vue'
import { usePdfStore } from '@/stores/pdf'
import { useEditorRefs } from '@/composables/useEditorRefs'
import { gotoPage } from '@/composables/usePageActions'

interface PageTextIndex {
  joinedText: string
  itemBoundaries: number[]
}

export interface SearchMatch {
  pageOriginalIdx: number
  itemIndices: number[]
}

interface PdfPageLike {
  getTextContent(): Promise<{ items: Array<{ str: string }> }>
}

const query = ref('')
const matches = ref<SearchMatch[]>([])
const currentMatchIdx = ref(-1)
const visible = ref(false)
const isSearching = ref(false)
const cache = new Map<number, PageTextIndex>()

const matchCount = computed(() => matches.value.length)

let docWatcherInstalled = false

function installDocWatcher(): void {
  if (docWatcherInstalled) return
  docWatcherInstalled = true
  const pdf = usePdfStore()
  watch(
    () => pdf.pdfjsDoc,
    () => {
      cache.clear()
      matches.value = []
      currentMatchIdx.value = -1
      query.value = ''
      visible.value = false
    },
  )
}

async function getPageIndex(pageOriginalIdx: number): Promise<PageTextIndex> {
  const cached = cache.get(pageOriginalIdx)
  if (cached) return cached
  const pdf = usePdfStore()
  const empty: PageTextIndex = { joinedText: '', itemBoundaries: [0] }
  if (!pdf.pdfjsDoc) return empty
  const page = (await pdf.pdfjsDoc.getPage(pageOriginalIdx + 1)) as PdfPageLike
  const tc = await page.getTextContent()
  const boundaries: number[] = [0]
  let joined = ''
  for (const it of tc.items) {
    const s = it.str ?? ''
    joined += s + ' '
    boundaries.push(joined.length)
  }
  const result: PageTextIndex = { joinedText: joined.toLowerCase(), itemBoundaries: boundaries }
  cache.set(pageOriginalIdx, result)
  return result
}

export async function runSearch(q: string): Promise<void> {
  installDocWatcher()
  query.value = q
  const trimmed = q.trim().toLowerCase()
  if (!trimmed) {
    matches.value = []
    currentMatchIdx.value = -1
    applyHighlights()
    return
  }
  const pdf = usePdfStore()
  isSearching.value = true
  const result: SearchMatch[] = []
  for (const origIdx of pdf.pageOrder) {
    const idx = await getPageIndex(origIdx)
    let pos = 0
    while (true) {
      const f = idx.joinedText.indexOf(trimmed, pos)
      if (f < 0) break
      const end = f + trimmed.length
      const itemIndices: number[] = []
      for (let i = 0; i < idx.itemBoundaries.length - 1; i++) {
        const s = idx.itemBoundaries[i]
        const e = idx.itemBoundaries[i + 1]
        if (e > f && s < end) itemIndices.push(i)
      }
      if (itemIndices.length > 0) {
        result.push({ pageOriginalIdx: origIdx, itemIndices })
      }
      pos = f + Math.max(1, trimmed.length)
    }
  }
  matches.value = result
  isSearching.value = false
  currentMatchIdx.value = result.length > 0 ? 0 : -1
  applyHighlights()
  if (currentMatchIdx.value >= 0) await scrollToCurrentMatch()
}

export function applyHighlights(): void {
  const refs = useEditorRefs()
  const layer = refs.textLayer.value
  if (!layer) return
  const spans = layer.querySelectorAll<HTMLSpanElement>(':scope > span')
  spans.forEach((s) => s.classList.remove('search-hit', 'search-current'))
  if (matches.value.length === 0) return
  const pdf = usePdfStore()
  const origIdx = pdf.pageOrder[pdf.currentPage]
  for (let m = 0; m < matches.value.length; m++) {
    const match = matches.value[m]
    if (match.pageOriginalIdx !== origIdx) continue
    const cls = m === currentMatchIdx.value ? 'search-current' : 'search-hit'
    for (const i of match.itemIndices) {
      const span = spans[i]
      if (span) span.classList.add(cls)
    }
  }
}

async function scrollToCurrentMatch(): Promise<void> {
  if (currentMatchIdx.value < 0) return
  const m = matches.value[currentMatchIdx.value]
  const pdf = usePdfStore()
  const ui = pdf.pageOrder.indexOf(m.pageOriginalIdx)
  if (ui < 0) return
  if (ui !== pdf.currentPage) {
    await gotoPage(ui)
  }
  applyHighlights()
  const refs = useEditorRefs()
  const layer = refs.textLayer.value
  const wrap = refs.canvasWrap.value
  if (!layer || !wrap) return
  const spans = layer.querySelectorAll<HTMLSpanElement>(':scope > span')
  const span = spans[m.itemIndices[0]]
  if (!span) return
  const sr = span.getBoundingClientRect()
  const wr = wrap.getBoundingClientRect()
  const targetTop =
    wrap.scrollTop + (sr.top - wr.top) - wrap.clientHeight / 2 + sr.height / 2
  const targetLeft =
    wrap.scrollLeft + (sr.left - wr.left) - wrap.clientWidth / 2 + sr.width / 2
  wrap.scrollTo({
    top: Math.max(0, targetTop),
    left: Math.max(0, targetLeft),
    behavior: 'smooth',
  })
}

export async function nextMatch(): Promise<void> {
  if (matches.value.length === 0) return
  currentMatchIdx.value = (currentMatchIdx.value + 1) % matches.value.length
  await scrollToCurrentMatch()
}

export async function prevMatch(): Promise<void> {
  if (matches.value.length === 0) return
  currentMatchIdx.value =
    (currentMatchIdx.value - 1 + matches.value.length) % matches.value.length
  await scrollToCurrentMatch()
}

export function openSearch(): void {
  installDocWatcher()
  visible.value = true
}

export function closeSearch(): void {
  visible.value = false
  matches.value = []
  currentMatchIdx.value = -1
  query.value = ''
  applyHighlights()
}

export function useTextSearch() {
  return {
    query,
    matches,
    matchCount,
    currentMatchIdx,
    visible,
    isSearching,
  }
}
