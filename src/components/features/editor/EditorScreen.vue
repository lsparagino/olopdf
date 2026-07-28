<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import UiButton from '@/components/ui/UiButton.vue'
import PageThumb from '@/components/features/editor/PageThumb.vue'
import PdfPageView from '@/components/features/editor/PdfPageView.vue'
import BookmarkModal from '@/components/features/editor/BookmarkModal.vue'
import SelectionToolbar from '@/components/features/editor/SelectionToolbar.vue'
import SearchBar from '@/components/features/editor/SearchBar.vue'
import {
  PDF_CONFIG,
  usePdfStore,
  type Bookmark,
  type TextAnnotation,
} from '@/stores/pdf'
import { useEditorRefs } from '@/composables/useEditorRefs'
import { measureAllPages, measurePage } from '@/composables/usePageMetrics'
import { waitForPage } from '@/composables/usePdfRenderer'
import { gotoPage, deletePage, movePage, rotatePage } from '@/composables/usePageActions'
import { useZoomPan } from '@/composables/useZoomPan'
import {
  currentRowFromScroll,
  firstPageOfRow,
  isScrollSyncSuppressed,
  refreshRenderRange,
  rowGeoms,
  rowIndexForPage,
  scrollToPage,
  setContainerSize,
  setFitAnchor,
  useViewerScroll,
  viewerRows,
} from '@/composables/useViewerScroll'
import { createPageDragHandlers } from '@/composables/useThumbnails'
import {
  drawTextOverlays,
  editAnnotation,
  startTextPlacement,
  placePendingTextAt,
  isEditorActive,
  cancelEditor,
} from '@/composables/useTextOverlay'
import { captureCanvasSelection, gotoBookmark } from '@/composables/useBookmarks'
import { savePdf } from '@/composables/useSavePdf'
import { basenameOf } from '@/composables/useOpenPdf'
import {
  applyHighlights as applySearchHighlights,
  closeSearch,
  openSearch,
  useTextSearch,
} from '@/composables/useTextSearch'

const router = useRouter()
const route = useRoute()
const pdf = usePdfStore()
const refs = useEditorRefs()

// Rows of the continuous flow — one page per row in single view, one spread in
// double view — and the running top/height of each, which is what makes
// "scroll to page N" a plain arithmetic offset.
const rows = viewerRows()
const geoms = rowGeoms()
const { renderRange } = useViewerScroll()

function shouldRenderRow(rowIdx: number): boolean {
  return rowIdx >= renderRange.value.start && rowIdx <= renderRange.value.end
}

const pageListEl = ref<HTMLDivElement | null>(null)
// TransitionGroup template refs return the component instance, not the DOM node.
// Bridge through a function ref so highlightActiveSidebarThumb can still query the
// rendered <div> directly.
function setPageListEl(el: unknown) {
  if (el && typeof el === 'object' && '$el' in el) {
    pageListEl.value = (el as { $el: HTMLDivElement }).$el
  } else {
    pageListEl.value = (el as HTMLDivElement | null) ?? null
  }
}

const showBookmarkModal = ref(false)
const editingBookmarkIdx = ref<number | null>(null)
const editingBookmarkTitle = ref('')
const search = useTextSearch()
const activeSidebarTab = ref<'bookmarks' | 'texts'>('bookmarks')

interface TextItem {
  ann: TextAnnotation
  isRepeat: boolean
}

const textsCount = computed(
  () => pdf.textAnnotations.length + pdf.repeatTexts.length,
)

const textItems = computed<TextItem[]>(() => {
  const result: TextItem[] = []
  for (const ann of pdf.repeatTexts) result.push({ ann, isRepeat: true })
  for (const ann of pdf.textAnnotations) result.push({ ann, isRepeat: false })
  result.sort((a, b) => {
    if (a.isRepeat !== b.isRepeat) return a.isRepeat ? -1 : 1
    if (a.isRepeat) return 0
    const pa =
      a.ann.pageOriginalIdx !== undefined
        ? pdf.pageOrder.indexOf(a.ann.pageOriginalIdx)
        : -1
    const pb =
      b.ann.pageOriginalIdx !== undefined
        ? pdf.pageOrder.indexOf(b.ann.pageOriginalIdx)
        : -1
    if (pa !== pb) return pa - pb
    if (a.ann.y !== b.ann.y) return a.ann.y - b.ann.y
    return a.ann.x - b.ann.x
  })
  return result
})

function textPageLabel(item: TextItem): string {
  if (item.isRepeat) return '↻'
  if (item.ann.pageOriginalIdx === undefined) return '—'
  const ui = pdf.pageOrder.indexOf(item.ann.pageOriginalIdx)
  return ui >= 0 ? `p.${ui + 1}` : '—'
}

async function onTextItemClick(item: TextItem) {
  let uiIdx = pdf.currentPage
  if (!item.isRepeat && item.ann.pageOriginalIdx !== undefined) {
    const ui = pdf.pageOrder.indexOf(item.ann.pageOriginalIdx)
    if (ui < 0) return
    uiIdx = ui
    await gotoPage(ui)
    // The overlay this annotation lives in only exists once its page is painted.
    await waitForPage(ui)
  }
  editAnnotation(item.ann, item.isRepeat, uiIdx)
}

function removeTextItem(item: TextItem) {
  if (item.isRepeat) pdf.removeRepeatText(item.ann)
  else pdf.removeTextAnnotation(item.ann)
}

const filename = computed(() => basenameOf(pdf.filePath))

const zoom = useZoomPan()

// One rAF per scroll burst: recompute which rows deserve a canvas, then let the
// page readout follow the flow. The programmatic-scroll guard stops a smooth
// "go to page 40" from re-deriving currentPage off every page it flies past.
let scrollRaf: number | null = null
function onScroll() {
  if (scrollRaf !== null) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = null
    refreshRenderRange()
    if (isScrollSyncSuppressed()) return
    const first = firstPageOfRow(currentRowFromScroll())
    if (first !== pdf.currentPage) pdf.setCurrentPage(first)
  })
}

function onMouseDown(e: MouseEvent) {
  if (e.button !== 0 || pdf.gridMode) return
  if (pdf.pendingTextPlacement) {
    e.preventDefault()
    placePendingTextAt(e.clientX, e.clientY)
    return
  }
  // Inline editor active: don't preventDefault — let blur commit the editor cleanly.
  if (isEditorActive()) return
  // Select mode: never start panning — the browser handles text selection on spans,
  // and clicks outside text are inert. Pan mode: always pan (when scrollable).
  if (pdf.interactionMode === 'select') return
  zoom.startPan(e)
}

function onSetSelectMode() {
  pdf.setInteractionMode('select')
}
function onSetPanMode() {
  pdf.setInteractionMode('pan')
}

function onAddText() {
  startTextPlacement()
}

function onRotateLeft() {
  void rotatePage(pdf.currentPage, 'ccw')
}

function onRotateRight() {
  void rotatePage(pdf.currentPage, 'cw')
}

function onAddBookmark() {
  pdf.capturedSelection = captureCanvasSelection()
  showBookmarkModal.value = true
}

async function onToggleReorder() {
  pdf.toggleGridMode()
  if (pdf.gridMode) return
  // The page flow is unmounted in grid mode; put the user back where they were.
  await nextTick()
  refreshRenderRange()
  scrollToPage(pdf.currentPage, 'auto')
}

// A "page" of navigation is a whole spread in double view, which is also exactly
// one row of the continuous flow.
function navStep(): number {
  return pdf.viewMode === 'double' ? 2 : 1
}
function onPrev() {
  void gotoPage(Math.max(0, pdf.currentPage - navStep()))
}
function onNext() {
  void gotoPage(pdf.currentPage + navStep())
}

// A row taller than the viewport pages through itself first; one that already
// fits jumps a whole row — which in double view is a whole spread.
function pageStep(dir: 1 | -1, repeat: boolean) {
  const wrap = refs.canvasWrap.value
  if (!wrap) return
  const g = geoms.value[rowIndexForPage(pdf.currentPage)]
  if (g && g.height > wrap.clientHeight) {
    wrap.scrollBy({ top: dir * (wrap.clientHeight - 40), behavior: repeat ? 'auto' : 'smooth' })
    return
  }
  void gotoPage(pdf.currentPage + dir * navStep())
}

// A spread is twice as wide as a single page, so whatever scale fitted before
// certainly doesn't now: re-anchor the fit on the page in view and, if the user
// had pinned an explicit zoom, fall back to fit-to-width rather than leaving them
// with a spread hanging off both edges. The fitScale watcher applies the new
// scale and keeps the scroll position anchored to the same page.
function refitForSpreadChange() {
  setFitAnchor(pdf.currentPage)
  if (pdf.fitMode === 'none') pdf.zoomFitWidth()
}

function onToggleViewMode() {
  pdf.toggleViewMode()
  if (pdf.viewMode === 'double' && pdf.currentPage % 2 === 1) {
    // Snap to an even left-page so spreads stay aligned across navigation.
    pdf.setCurrentPage(pdf.currentPage - 1)
  }
  refitForSpreadChange()
}

function onToggleDoubleGap() {
  pdf.toggleDoublePageGap()
  refitForSpreadChange()
}

function onKeyDown(e: KeyboardEvent) {
  if (route.name !== 'editor') return
  // Ctrl/Cmd+F opens find — handled BEFORE the input/textarea early-return so it
  // works even when focus is in another text input on the page.
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault()
    openSearch()
    return
  }
  const t = e.target as HTMLElement
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return
  if (t.isContentEditable) return
  const wrap = refs.canvasWrap.value
  // html/body have overflow:hidden and the wrap isn't focusable, so the browser
  // provides no keyboard scrolling of its own — every key below has to move the
  // flow explicitly. Held keys scroll instantly: a smooth animation restarted
  // every ~30ms by key repeat looks frozen.
  if (e.key === 'ArrowLeft') {
    e.preventDefault()
    onPrev()
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    onNext()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    wrap?.scrollBy({ top: -60, behavior: e.repeat ? 'auto' : 'smooth' })
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    wrap?.scrollBy({ top: 60, behavior: e.repeat ? 'auto' : 'smooth' })
  } else if (e.key === 'PageUp') {
    e.preventDefault()
    pageStep(-1, e.repeat)
  } else if (e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) {
    e.preventDefault()
    pageStep(1, e.repeat)
  } else if (e.key === 'Home') {
    e.preventDefault()
    wrap?.scrollTo({ top: 0, behavior: 'smooth' })
  } else if (e.key === 'End') {
    e.preventDefault()
    wrap?.scrollTo({ top: wrap.scrollHeight, behavior: 'smooth' })
  } else if (e.key === 'Escape') {
    if (search.visible.value) {
      closeSearch()
      return
    }
    if (pdf.pendingTextPlacement) {
      pdf.pendingTextPlacement = null
      refs.canvasWrap.value?.classList.remove('placing-text')
    }
    if (isEditorActive()) cancelEditor()
  }
}

function onPageRendered(e: Event) {
  const detail = (e as CustomEvent<{ uiIdx: number }>).detail
  drawTextOverlays(detail?.uiIdx)
  // Text-layer spans were just rebuilt — re-apply any active search highlights.
  applySearchHighlights()
}

// pdf.js TextLayerBuilder#bindMouse, distilled. On mousedown the `endOfContent`
// sentinel is moved so its top edge sits at the press's Y position (as a
// percentage of the layer height). The sentinel covers everything below the press
// and has user-select: none, so once the cursor strays past the bottom of the
// spans the browser can't extend the selection there — it freezes at the last
// valid span. On mouseup we revert. Without this trick, dragging past the text
// snaps the selection to the topmost or bottommost span on the page.
//
// Two deliberate departures from pdf.js: the press is caught on the canvas-wrap
// rather than the layer, so a drag starting in the grey margin beside the page is
// fenced too, and the release is caught on the document, because a text drag very
// often ends outside the layer — pdf.js's layer-bound mouseup then never fires and
// the sentinel stays active with a stale top, poisoning the *next* selection.
//
// With every page stacked in one container, only the page the press landed on is
// fenced. Each page owns its sentinel and each sentinel is clipped to its own
// page, so a drag that runs on into the next page still extends normally there.
function layerUnderPress(e: MouseEvent): HTMLElement | null {
  const target = e.target as Element | null
  const direct = target?.closest<HTMLElement>('.text-layer')
  if (direct) return direct
  // Pressed in the grey margin: fence whichever page the pointer is level with.
  const wrap = refs.canvasWrap.value
  if (!wrap) return null
  for (const stage of wrap.querySelectorAll<HTMLElement>('.canvas-stage[data-rendered="1"]')) {
    const r = stage.getBoundingClientRect()
    if (e.clientY >= r.top && e.clientY <= r.bottom) {
      return stage.querySelector<HTMLElement>('.text-layer')
    }
  }
  return null
}

function onSelectionFenceDown(e: MouseEvent) {
  if (e.button !== 0 || pdf.gridMode) return
  const layer = layerUnderPress(e)
  if (!layer) return
  const end = layer.querySelector<HTMLDivElement>('.end-of-content')
  if (!end) return
  const rect = layer.getBoundingClientRect()
  // Anchor the fence at the cursor only when the press landed on a text run. A
  // press on bare layer (the gaps between runs) or outside it altogether has no
  // trustworthy anchor, so it falls back to `.active`'s top: 0 and fences the
  // whole layer — the spans paint above the sentinel, so they stay selectable
  // either way; only the empty space between them stops attracting the selection.
  if (e.target !== layer && layer.contains(e.target as Node) && rect.height > 0) {
    const r = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
    end.style.top = `${(r * 100).toFixed(2)}%`
  }
  end.classList.add('active')
}

function onSelectionFenceUp() {
  const wrap = refs.canvasWrap.value
  if (!wrap) return
  for (const end of wrap.querySelectorAll<HTMLDivElement>('.end-of-content')) {
    end.style.top = ''
    end.classList.remove('active')
  }
}

function highlightActiveSidebarThumb() {
  const list = pageListEl.value
  if (!list) return
  const active = list.querySelector(`[data-ui-idx="${pdf.currentPage}"]`) as HTMLElement | null
  if (!active) return
  // Only recentre once the active thumb has actually left the visible box. The
  // current page is now derived from scrolling, so an unconditional recentre
  // fires continuously and makes the strip impossible to browse by hand.
  const offset = active.offsetTop - list.scrollTop
  if (offset >= 0 && offset + active.clientHeight <= list.clientHeight) return
  const target = active.offsetTop - list.clientHeight / 2 + active.clientHeight / 2
  const max = list.scrollHeight - list.clientHeight
  list.scrollTop = Math.max(0, Math.min(target, max))
}

const sidebarDrag = createPageDragHandlers('y', (src, dest) => {
  void movePage(src, dest)
})
const gridDrag = createPageDragHandlers('x', (src, dest) => {
  void movePage(src, dest)
})

function onSidebarThumbClick(uiIdx: number) {
  if (pdf.gridMode) pdf.toggleGridMode(false)
  void gotoPage(uiIdx)
}

function onGridThumbDoubleClick(uiIdx: number) {
  pdf.toggleGridMode(false)
  void gotoPage(uiIdx)
}

function onBookmarkClick(b: Bookmark) {
  if (bookmarkDragMoved) return
  void gotoBookmark(b)
}

// Right sidebar width is user-resizable; persisted across sessions so a
// well-tuned width sticks. The inline CSS variable on the section drives the
// grid track.
const SIDEBAR_KEY = 'olopdf:right-sidebar-width'
const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 600
const SIDEBAR_DEFAULT = 280
const rightSidebarWidth = ref<number>(loadSidebarWidth())

function loadSidebarWidth(): number {
  try {
    const v = Number(localStorage.getItem(SIDEBAR_KEY))
    if (Number.isFinite(v) && v >= SIDEBAR_MIN && v <= SIDEBAR_MAX) return v
  } catch {
    /* ignore */
  }
  return SIDEBAR_DEFAULT
}

function onSidebarResizeStart(e: MouseEvent) {
  if (e.button !== 0) return
  e.preventDefault()
  const startX = e.clientX
  const startW = rightSidebarWidth.value
  document.body.classList.add('resizing-sidebar')
  function onMove(ev: MouseEvent) {
    // Dragging the handle leftwards widens the sidebar (the handle lives on
    // its left edge, and the panel is anchored to the right of the screen).
    const next = Math.max(
      SIDEBAR_MIN,
      Math.min(SIDEBAR_MAX, startW - (ev.clientX - startX)),
    )
    rightSidebarWidth.value = next
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    document.body.classList.remove('resizing-sidebar')
    try {
      localStorage.setItem(SIDEBAR_KEY, String(rightSidebarWidth.value))
    } catch {
      /* ignore */
    }
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// Bookmark hierarchy: order is auto-sorted by page position (page → y → x), so
// the only thing the user controls is each bookmark's outline level. They can
// either click the indent/outdent buttons or drag the row horizontally — one
// tier per BOOKMARK_INDENT_PX of cursor X movement, clamped to the predecessor's
// level + 1 so the tree never grows a gap.
const BOOKMARK_INDENT_PX = 22
const BOOKMARK_BASE_PADDING = 12
const DRAG_THRESHOLD_PX = 4
const dragSrcIdx = ref<number | null>(null)
const dragPreviewLevel = ref<number | null>(null)
const dragGhost = ref<{ x: number; y: number; title: string } | null>(null)

let bookmarkDragMoved = false

function bookmarkPaddingPx(level: number): number {
  return BOOKMARK_BASE_PADDING + level * BOOKMARK_INDENT_PX
}

function maxLevelAt(idx: number): number {
  if (idx <= 0) return 0
  return pdf.bookmarks[idx - 1].level + 1
}

function indentBookmark(i: number) {
  const cur = pdf.bookmarks[i].level
  const cap = maxLevelAt(i)
  if (cur >= cap) return
  pdf.setBookmarkLevel(i, cur + 1)
}
function outdentBookmark(i: number) {
  const cur = pdf.bookmarks[i].level
  if (cur <= 0) return
  pdf.setBookmarkLevel(i, cur - 1)
}

function onBookmarkMouseDown(e: MouseEvent, i: number) {
  if (e.button !== 0) return
  const tgt = e.target as HTMLElement
  if (tgt.closest('.bm-action, .bm-title-input')) return
  if (editingBookmarkIdx.value !== null) return

  const startX = e.clientX
  const startY = e.clientY
  const startLevel = pdf.bookmarks[i].level
  bookmarkDragMoved = false
  let armed = false

  function onMove(ev: MouseEvent) {
    const dx = ev.clientX - startX
    const dy = ev.clientY - startY
    if (!armed) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
      armed = true
      bookmarkDragMoved = true
      dragSrcIdx.value = i
    }
    dragGhost.value = { x: ev.clientX, y: ev.clientY, title: pdf.bookmarks[i].title }
    const deltaTiers = Math.round(dx / BOOKMARK_INDENT_PX)
    const target = Math.max(0, Math.min(maxLevelAt(i), startLevel + deltaTiers))
    dragPreviewLevel.value = target
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    if (armed) {
      const next = dragPreviewLevel.value
      if (typeof next === 'number' && next !== startLevel) {
        pdf.setBookmarkLevel(i, next)
      }
      // Swallow the trailing `click` so the drag doesn't navigate.
      const blockClick = (clickEv: Event) => {
        clickEv.stopPropagation()
        clickEv.preventDefault()
        document.removeEventListener('click', blockClick, true)
      }
      document.addEventListener('click', blockClick, true)
      setTimeout(() => {
        bookmarkDragMoved = false
      }, 0)
    }
    dragSrcIdx.value = null
    dragGhost.value = null
    dragPreviewLevel.value = null
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

function startBookmarkEdit(idx: number, b: Bookmark) {
  editingBookmarkIdx.value = idx
  editingBookmarkTitle.value = b.title
  void nextTick(() => {
    document.querySelector<HTMLInputElement>('.bm-title-input')?.focus()
  })
}

function commitBookmarkEdit() {
  if (editingBookmarkIdx.value === null) return
  pdf.renameBookmark(editingBookmarkIdx.value, editingBookmarkTitle.value)
  editingBookmarkIdx.value = null
}

function cancelBookmarkEdit() {
  editingBookmarkIdx.value = null
}

function onBookmarkInputKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    commitBookmarkEdit()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancelBookmarkEdit()
  }
  e.stopPropagation()
}

// The thumb strip follows whichever page the flow has settled on.
watch(() => pdf.currentPage, highlightActiveSidebarThumb)

// Row geometry changes for every reason that matters — zoom, page count, single
// vs double view, a page measurement landing — so this is the single place that
// keeps the render window honest.
watch(geoms, refreshRenderRange, { flush: 'post' })

// Placed annotations are positioned imperatively in scaled pixels, so they follow
// a zoom change immediately rather than waiting for the debounced repaint.
watch(
  () => pdf.zoom,
  () => drawTextOverlays(),
)

onMounted(async () => {
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('pdf:page-rendered', onPageRendered)
  refs.canvasWrap.value?.addEventListener('mousedown', onSelectionFenceDown)
  document.addEventListener('mouseup', onSelectionFenceUp)

  // If the user landed on /editor without a loaded doc, bounce back to welcome.
  if (!pdf.pdfjsDoc) {
    void router.replace({ name: 'welcome' })
    return
  }
  // Size the container before the first fit is computed, otherwise the document
  // paints one frame at 100% before the ResizeObserver reports and fit-to-width
  // lands — a visible lurch on open.
  const wrap = refs.canvasWrap.value
  if (wrap) setContainerSize(wrap.clientWidth, wrap.clientHeight)
  // Likewise pay for the first page's real box up front: fitting to the 612×792
  // placeholder and then correcting is a visible jump on any non-Letter document.
  const first = pdf.pageOrder[0]
  if (first !== undefined) await measurePage(first, pdf.rotationFor(first))
  // The rest stream in and the flow settles as they land.
  void measureAllPages()
  await nextTick()
  refreshRenderRange()
  highlightActiveSidebarThumb()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('pdf:page-rendered', onPageRendered)
  refs.canvasWrap.value?.removeEventListener('mousedown', onSelectionFenceDown)
  document.removeEventListener('mouseup', onSelectionFenceUp)
  if (scrollRaf !== null) cancelAnimationFrame(scrollRaf)
})
</script>

<template>
  <section
    class="editor grid h-full grid-rows-1 gap-3 p-3"
    :style="{
      '--right-sidebar-width': `${rightSidebarWidth}px`,
      '--page-gap': `${PDF_CONFIG.PAGE_GAP_PX}px`,
      '--page-pad': `${PDF_CONFIG.CANVAS_PADDING / 2}px`,
    }"
  >
    <aside
      class="glass left-sidebar flex min-h-0 flex-col overflow-hidden rounded-[14px]"
    >
      <div
        class="flex items-center justify-between border-b border-white/[0.06] px-4 py-3.5 text-xs font-semibold uppercase tracking-[0.5px] text-fg-dim"
      >
        <span>Pages</span>
        <span
          class="rounded-xl border border-glass-border bg-glass-strong px-2 py-0.5 text-[11px] font-medium text-fg"
        >
          {{ pdf.pageOrder.length }}
        </span>
      </div>
      <TransitionGroup
        :ref="setPageListEl"
        tag="div"
        name="page-reorder"
        class="page-list flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3"
      >
        <PageThumb
          v-for="(origIdx, ui) in pdf.pageOrder"
          :key="origIdx"
          :ui-idx="ui"
          :orig-idx="origIdx"
          :active="ui === pdf.currentPage"
          :target-width="PDF_CONFIG.THUMB_TARGET_WIDTH"
          variant="sidebar"
          @click="onSidebarThumbClick(ui)"
          @delete="deletePage(ui)"
          @dragstart="sidebarDrag.onDragStart($event, ui)"
          @dragend="sidebarDrag.onDragEnd"
          @dragover="sidebarDrag.onDragOver($event, ui)"
          @dragleave="sidebarDrag.onDragLeave"
          @drop="sidebarDrag.onDrop($event, ui, 'y')"
        />
      </TransitionGroup>
    </aside>

    <main class="flex min-h-0 min-w-0 flex-col gap-3">
      <div class="glass flex items-center gap-2 rounded-[14px] px-3 py-2">
        <UiButton
          variant="ghost"
          size="icon"
          title="Back to home"
          @click="router.push({ name: 'welcome' })"
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M19 12H5" />
            <path d="M12 19l-7-7 7-7" />
          </svg>
        </UiButton>
        <span class="min-w-0 flex-1 truncate px-2 text-[13px] text-fg-dim">{{ filename }}</span>
        <div class="flex flex-shrink-0 gap-1.5">
          <UiButton
            variant="ghost"
            size="icon"
            :toggled="pdf.gridMode"
            :title="pdf.gridMode ? 'Done reordering' : 'Reorder pages'"
            @click="onToggleReorder"
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
            </svg>
          </UiButton>
          <UiButton variant="ghost" size="icon" title="Rotate page left" @click="onRotateLeft">
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
          </UiButton>
          <UiButton variant="ghost" size="icon" title="Rotate page right" @click="onRotateRight">
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </UiButton>
          <UiButton variant="ghost" size="icon" title="Add text" @click="onAddText">
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="4 7 4 4 20 4 20 7" />
              <line x1="9" y1="20" x2="15" y2="20" />
              <line x1="12" y1="4" x2="12" y2="20" />
            </svg>
          </UiButton>
          <UiButton
            variant="ghost"
            size="icon"
            :toggled="pdf.viewMode === 'double'"
            :title="pdf.viewMode === 'double' ? 'Single-page view' : 'Two-page view'"
            @click="onToggleViewMode"
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect x="3" y="4" width="8" height="16" rx="1" />
              <rect x="13" y="4" width="8" height="16" rx="1" />
            </svg>
          </UiButton>
          <UiButton
            v-if="pdf.viewMode === 'double'"
            variant="ghost"
            size="icon"
            :toggled="pdf.doublePageGap"
            :title="pdf.doublePageGap ? 'Hide gap between pages' : 'Show gap between pages'"
            @click="onToggleDoubleGap"
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect x="2" y="5" width="8" height="14" rx="1" />
              <rect x="14" y="5" width="8" height="14" rx="1" />
              <line x1="12" y1="5" x2="12" y2="19" stroke-dasharray="2 2" />
            </svg>
          </UiButton>
          <UiButton
            variant="ghost"
            size="icon"
            data-search-toggle
            :toggled="search.visible.value"
            title="Find in document (Ctrl+F)"
            @click="search.visible.value ? closeSearch() : openSearch()"
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="20" y1="20" x2="16.65" y2="16.65" />
            </svg>
          </UiButton>
          <UiButton variant="ghost" size="icon" title="Bookmark current page" @click="onAddBookmark">
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
          </UiButton>
          <UiButton variant="primary" size="icon" title="Save PDF" @click="savePdf">
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
          </UiButton>
        </div>
      </div>

      <!-- Wrapper exists so the mode-toggle can be positioned absolutely without
           living inside the scroll container — otherwise it scrolls out of view
           when the user zooms in and the canvas overflows. -->
      <div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          :ref="refs.canvasWrap"
          class="canvas-wrap"
          :class="[{ 'grid-mode': pdf.gridMode }, `mode-${pdf.interactionMode}`]"
          @scroll.passive="onScroll"
          @mousedown="onMouseDown"
        >
          <!-- Every page of the document is mounted, so the scroll height is
               real and the browser does the scrolling. Only rows near the
               viewport get a painted canvas — see shouldRenderRow. -->
          <div v-if="!pdf.gridMode" class="page-flow">
            <div
              v-for="row in rows"
              :key="row.key"
              class="page-row"
              :style="{
                height: `${geoms[row.rowIdx]?.height ?? 0}px`,
                gap: `${row.gapPx}px`,
              }"
            >
              <PdfPageView
                v-for="p in row.pages"
                :key="p.origIdx"
                :ui-idx="p.uiIdx"
                :orig-idx="p.origIdx"
                :rotation="p.rotation"
                :base-width="p.width"
                :base-height="p.height"
                :scale="pdf.zoom"
                :should-render="shouldRenderRow(row.rowIdx)"
              />
            </div>
          </div>
          <TransitionGroup
            v-if="pdf.gridMode"
            tag="div"
            name="page-reorder"
            class="grid-view"
          >
            <PageThumb
              v-for="(origIdx, ui) in pdf.pageOrder"
              :key="origIdx"
              :ui-idx="ui"
              :orig-idx="origIdx"
              :active="ui === pdf.currentPage"
              :target-width="PDF_CONFIG.GRID_THUMB_TARGET_WIDTH"
              variant="grid"
              @dblclick="onGridThumbDoubleClick(ui)"
              @delete="deletePage(ui)"
              @dragstart="gridDrag.onDragStart($event, ui)"
              @dragend="gridDrag.onDragEnd"
              @dragover="gridDrag.onDragOver($event, ui)"
              @dragleave="gridDrag.onDragLeave"
              @drop="gridDrag.onDrop($event, ui, 'x')"
            />
          </TransitionGroup>
        </div>

        <SearchBar v-if="!pdf.gridMode" />

        <div
          v-if="!pdf.gridMode"
          class="mode-toggle"
          @mousedown.stop
        >
          <button
            type="button"
            class="mode-btn"
            :class="{ active: pdf.interactionMode === 'select' }"
            title="Select text"
            @click="onSetSelectMode"
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <line x1="4" y1="5" x2="12" y2="5" />
              <line x1="20" y1="5" x2="12" y2="5" />
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="4" y1="19" x2="12" y2="19" />
              <line x1="20" y1="19" x2="12" y2="19" />
            </svg>
          </button>
          <button
            type="button"
            class="mode-btn"
            :class="{ active: pdf.interactionMode === 'pan' }"
            title="Pan"
            @click="onSetPanMode"
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M18 11V6.5a1.5 1.5 0 0 0-3 0V11" />
              <path d="M15 10.5V4.5a1.5 1.5 0 0 0-3 0v6.5" />
              <path d="M12 10.5V5.5a1.5 1.5 0 0 0-3 0v8" />
              <path d="M9 13.5V8.5a1.5 1.5 0 0 0-3 0V16l1.5 3a5.5 5.5 0 0 0 5 3h2a5.5 5.5 0 0 0 5.5-5.5V11a1.5 1.5 0 0 0-3 0" />
            </svg>
          </button>
        </div>
      </div>

      <div
        class="glass flex items-center justify-center gap-2.5 rounded-[14px] px-3.5 py-2"
      >
        <UiButton
          variant="default"
          size="icon"
          title="Previous page"
          :disabled="pdf.currentPage <= 0"
          @click="onPrev"
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </UiButton>
        <span
          class="min-w-[72px] text-center text-[13px] text-fg-dim"
          style="font-variant-numeric: tabular-nums"
        >
          <template
            v-if="pdf.viewMode === 'double' && pdf.currentPage + 1 < pdf.pageOrder.length"
          >
            {{ pdf.currentPage + 1 }}–{{ pdf.currentPage + 2 }} / {{ pdf.pageOrder.length }}
          </template>
          <template v-else>
            {{ pdf.currentPage + 1 }} / {{ pdf.pageOrder.length }}
          </template>
        </span>
        <UiButton
          variant="default"
          size="icon"
          title="Next page"
          :disabled="pdf.currentPage + (pdf.viewMode === 'double' ? 2 : 1) > pdf.pageOrder.length - 1"
          @click="onNext"
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </UiButton>
        <span class="mx-1 h-[18px] w-px bg-glass-border" />
        <UiButton variant="default" size="icon" title="Zoom out" @click="zoom.onZoomOutClick">−</UiButton>
        <span
          class="min-w-[42px] text-center text-xs text-fg-dim"
          style="font-variant-numeric: tabular-nums"
        >
          {{ refs.zoomLabel.value }}
        </span>
        <UiButton variant="default" size="icon" title="Zoom in" @click="zoom.onZoomInClick">+</UiButton>
        <UiButton
          variant="default"
          size="icon"
          title="Fit to width"
          :toggled="pdf.fitMode === 'width'"
          @click="zoom.onZoomFitWidthClick"
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <line x1="3" y1="5" x2="3" y2="19" />
            <line x1="21" y1="5" x2="21" y2="19" />
            <line x1="7" y1="12" x2="17" y2="12" />
            <polyline points="10 9 7 12 10 15" />
            <polyline points="14 9 17 12 14 15" />
          </svg>
        </UiButton>
        <UiButton
          variant="default"
          size="icon"
          title="Fit to page"
          :toggled="pdf.fitMode === 'page'"
          @click="zoom.onZoomFitPageClick"
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <polyline points="9 4 4 4 4 9" />
            <polyline points="15 4 20 4 20 9" />
            <polyline points="4 15 4 20 9 20" />
            <polyline points="20 15 20 20 15 20" />
          </svg>
        </UiButton>
      </div>
    </main>

    <aside
      class="glass right-sidebar relative flex min-h-0 flex-col overflow-hidden rounded-[14px]"
    >
      <div
        class="right-sidebar-resize"
        title="Drag to resize"
        @mousedown="onSidebarResizeStart"
      />
      <div class="sidebar-tabs">
        <button
          type="button"
          class="sidebar-tab"
          :class="{ active: activeSidebarTab === 'bookmarks' }"
          @click="activeSidebarTab = 'bookmarks'"
        >
          <span>Bookmarks</span>
          <span class="tab-count">{{ pdf.bookmarks.length }}</span>
        </button>
        <button
          type="button"
          class="sidebar-tab"
          :class="{ active: activeSidebarTab === 'texts' }"
          @click="activeSidebarTab = 'texts'"
        >
          <span>Texts</span>
          <span class="tab-count">{{ textsCount }}</span>
        </button>
      </div>
      <div
        v-if="activeSidebarTab === 'bookmarks' && pdf.bookmarks.length > 1"
        class="px-4 pt-2 text-[10px] text-fg-mute"
        title="Drag a row right/left or use the indent buttons to change its outline level."
      >
        drag to nest
      </div>
      <div
        v-if="activeSidebarTab === 'bookmarks'"
        class="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2.5"
      >
        <div
          v-if="pdf.bookmarks.length === 0"
          class="px-4 py-6 text-center text-xs text-fg-mute"
        >
          No bookmarks yet
        </div>
        <div
          v-for="(b, i) in pdf.bookmarks"
          :key="`bm-${i}-${b.title}`"
          class="bookmark-item"
          :class="{
            editing: editingBookmarkIdx === i,
            dragging: dragSrcIdx === i,
          }"
          :style="{
            paddingLeft: `${bookmarkPaddingPx(
              dragSrcIdx === i && dragPreviewLevel !== null ? dragPreviewLevel : b.level,
            )}px`,
          }"
          :data-bm-idx="i"
          @mousedown="onBookmarkMouseDown($event, i)"
          @click="onBookmarkClick(b)"
          @dblclick.stop="startBookmarkEdit(i, b)"
        >
          <span
            v-for="k in (dragSrcIdx === i && dragPreviewLevel !== null ? dragPreviewLevel : b.level)"
            :key="`g${k}`"
            class="bm-guide"
            :style="{ left: `${BOOKMARK_BASE_PADDING + (k - 1) * BOOKMARK_INDENT_PX + 4}px` }"
            aria-hidden="true"
          />
          <span
            v-if="b.x !== undefined"
            class="bm-anchor"
            title="Anchored to text"
          >“</span>
          <input
            v-if="editingBookmarkIdx === i"
            v-model="editingBookmarkTitle"
            type="text"
            class="bm-title-input"
            @click.stop
            @blur="commitBookmarkEdit"
            @keydown="onBookmarkInputKeydown"
          />
          <span v-else class="bm-title">{{ b.title }}</span>
          <span class="bm-page">
            {{
              pdf.pageOrder.indexOf(b.pageOriginalIdx) >= 0
                ? `p.${pdf.pageOrder.indexOf(b.pageOriginalIdx) + 1}`
                : '—'
            }}
          </span>
          <button
            type="button"
            class="bm-action bm-outdent"
            title="Outdent"
            :disabled="b.level === 0"
            @click.stop="outdentBookmark(i)"
            @mousedown.stop
          >
            <svg
              viewBox="0 0 24 24"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="11 17 6 12 11 7" />
              <line x1="18" y1="12" x2="6" y2="12" />
            </svg>
          </button>
          <button
            type="button"
            class="bm-action bm-indent"
            title="Indent"
            :disabled="b.level >= maxLevelAt(i)"
            @click.stop="indentBookmark(i)"
            @mousedown.stop
          >
            <svg
              viewBox="0 0 24 24"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="13 17 18 12 13 7" />
              <line x1="6" y1="12" x2="18" y2="12" />
            </svg>
          </button>
          <button
            type="button"
            class="bm-action bm-edit"
            title="Rename"
            @click.stop="startBookmarkEdit(i, b)"
            @mousedown.stop
          >
            <svg
              viewBox="0 0 24 24"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
            </svg>
          </button>
          <button
            type="button"
            class="bm-action bm-del"
            title="Remove"
            @click.stop="pdf.removeBookmark(i)"
            @mousedown.stop
          >
            ×
          </button>
        </div>
      </div>

      <div
        v-if="activeSidebarTab === 'texts'"
        class="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2.5"
      >
        <div
          v-if="textItems.length === 0"
          class="px-4 py-6 text-center text-xs text-fg-mute"
        >
          No inserted text yet.<br />
          Click the “Text” icon in the toolbar to add some.
        </div>
        <div
          v-for="(item, i) in textItems"
          :key="`txt-${i}`"
          class="text-item"
          @click="onTextItemClick(item)"
        >
          <span
            class="txt-badge"
            :class="{ repeat: item.isRepeat }"
            :title="item.isRepeat ? 'Repeats on every page' : 'Page'"
          >
            {{ textPageLabel(item) }}
          </span>
          <span class="txt-preview">{{ item.ann.text || '(empty)' }}</span>
          <button
            type="button"
            class="txt-del"
            title="Remove"
            @click.stop="removeTextItem(item)"
            @mousedown.stop
          >
            ×
          </button>
        </div>
      </div>
    </aside>

    <!-- Overlays live inside the single root <section> (so the route transition has
         exactly one element to animate) but teleport their DOM to <body> so they
         escape the editor's stacking context and z-index. -->
    <Teleport to="body">
      <BookmarkModal v-model:open="showBookmarkModal" />
    </Teleport>
    <Teleport to="body">
      <SelectionToolbar @bookmark="onAddBookmark" />
    </Teleport>
    <Teleport to="body">
      <div
        v-if="dragGhost"
        class="bookmark-ghost"
        :style="{ left: `${dragGhost.x + 14}px`, top: `${dragGhost.y - 12}px` }"
      >
        {{ dragGhost.title }}
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.editor {
  grid-template-columns: 240px 1fr var(--right-sidebar-width, 280px);
}
@media (max-width: 1100px) {
  .editor {
    grid-template-columns: 200px 1fr var(--right-sidebar-width, 240px);
  }
}
@media (max-width: 900px) {
  .editor {
    grid-template-columns: 180px 1fr;
  }
  .right-sidebar {
    display: none;
  }
}

/* Vertical drag-handle on the left edge of the right sidebar. Starts subtle
 * (just a cursor change on hover) and lights up while actively dragging. */
.right-sidebar-resize {
  position: absolute;
  top: 6px;
  bottom: 6px;
  left: 0;
  width: 6px;
  cursor: ew-resize;
  z-index: 5;
  transition: background 0.15s var(--ease-out-soft);
}
.right-sidebar-resize::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 1px;
  width: 2px;
  height: 28px;
  border-radius: 2px;
  transform: translateY(-50%);
  background: transparent;
  transition: background 0.15s var(--ease-out-soft);
}
.right-sidebar-resize:hover::before,
:global(body.resizing-sidebar) .right-sidebar-resize::before {
  background: var(--color-accent);
}

/* Tab strip in the right sidebar. Two pill buttons sit side-by-side; the
 * active tab gets the accent gradient. Counts hang on the right of each label
 * so the user can see how many bookmarks/texts the document has at a glance. */
.sidebar-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 8px 0 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.sidebar-tab {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 10px 9px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--color-fg-mute);
  border-radius: 8px 8px 0 0;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  cursor: pointer;
  transition: color 0.15s var(--ease-out-soft), background 0.15s var(--ease-out-soft),
    border-color 0.15s var(--ease-out-soft);
}
.sidebar-tab:hover {
  color: var(--color-fg-dim);
  background: rgba(255, 255, 255, 0.04);
}
.sidebar-tab.active {
  color: var(--color-fg);
  border-bottom-color: var(--color-accent);
}
.tab-count {
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 16px;
  padding: 0 5px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
  color: var(--color-fg-dim);
}
.sidebar-tab.active .tab-count {
  background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
  color: #fff;
}

/* Texts list (right sidebar, "Texts" tab). Mirrors the bookmark row layout
 * but simpler — no hierarchy, no drag-to-nest. Click navigates to the page
 * containing the annotation and opens the inline editor for it. */
.text-item {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 8px 8px 10px;
  border-radius: 8px;
  background: var(--color-glass);
  border: 1px solid transparent;
  cursor: pointer;
  transition: background 0.15s var(--ease-out-soft), border-color 0.15s var(--ease-out-soft);
}
.text-item:hover {
  background: var(--color-glass-strong);
  border-color: var(--color-glass-border);
}
.txt-badge {
  flex-shrink: 0;
  display: inline-grid;
  place-items: center;
  min-width: 30px;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 10px;
  font-weight: 600;
  color: var(--color-fg-dim);
  font-variant-numeric: tabular-nums;
  margin-top: 1px;
}
.txt-badge.repeat {
  background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
  color: #fff;
  font-size: 12px;
}
.txt-preview {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--color-fg);
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.txt-del {
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border-radius: 5px;
  flex-shrink: 0;
  color: var(--color-fg-dim);
  font-size: 14px;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.15s var(--ease-out-soft), background 0.15s var(--ease-out-soft),
    color 0.15s var(--ease-out-soft);
}
.text-item:hover .txt-del {
  opacity: 1;
}
.txt-del:hover {
  background: #e81123;
  color: #fff;
}

/* Canvas-wrap — the scroll container for the continuous page flow. Pixel-precise
 * positioning, so this stays hand-written CSS rather than Tailwind. */
.canvas-wrap {
  flex: 1 1 0;
  min-height: 0;
  border-radius: 14px;
  overflow: auto;
  /* Reserve the scrollbar track at all times. Otherwise fit-to-width depends on
   * whether a vertical scrollbar happens to be showing — which is decided by the
   * very scale being computed, a loop that oscillates by the scrollbar's width. */
  scrollbar-gutter: stable;
  overscroll-behavior: contain;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--color-glass-border);
  position: relative;
}

/* The flow's gap and padding are the CSS half of the geometry computed in
 * useViewerScroll — a disagreement of either lands every scroll-to-page off by
 * that much — so both come straight from PDF_CONFIG via the custom properties
 * bound on the root element rather than being repeated as literals here. */
.page-flow {
  display: flex;
  flex-direction: column;
  /* "safe" keeps the top-left corner of an over-wide page reachable instead of
   * letting centring push it past the scroll origin. */
  align-items: safe center;
  gap: var(--page-gap);
  /* Padding sits on the flow, not on the scroll container: Chromium drops a
   * scroll container's end padding once its content overflows. */
  padding: var(--page-pad);
  width: max-content;
  min-width: 100%;
}

.page-row {
  display: flex;
  align-items: flex-start;
  flex-shrink: 0;
}

/* Floating mode toggle, pinned to the top-left of the canvas-wrap. Stays in viewport
 * while the page scrolls because canvas-wrap is the scroll container; we want the
 * toggle to scroll with the page if content overflows, so position: absolute (not
 * sticky) is the right choice — it sits flush with the inner padding box. */
.mode-toggle {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 4;
  display: flex;
  gap: 2px;
  padding: 3px;
  background: rgba(20, 20, 32, 0.78);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--color-glass-border);
  border-radius: 9px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
}
.mode-btn {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  background: transparent;
  color: var(--color-fg-dim);
  cursor: pointer;
  transition: background 0.12s var(--ease-out-soft), color 0.12s var(--ease-out-soft);
}
.mode-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--color-fg);
}
.mode-btn.active {
  background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
  color: #fff;
}
.grid-view {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 18px;
  padding: 24px;
  width: 100%;
  align-content: start;
}

/* Page reorder FLIP animation (Vue's <TransitionGroup>).
 * Why: instant reordering on text-heavy thumbnails is hard to perceive — the user
 * doesn't see the swap. Animating each thumb to its new position via FLIP makes the
 * movement obvious without delaying the actual state change. Keys are origIdx so
 * Vue treats reorders as moves, not destroy + create. */
.page-reorder-move {
  transition: transform 0.32s cubic-bezier(0.22, 1, 0.36, 1);
}
/* Suppress the move animation on the dragged thumb so the ghost+drop indicator
 * lead the action; everything else settles into its new spot. */
.page-reorder-move.dragging {
  transition: none;
}

/* Bookmark items. paddingLeft is set inline from the outline level so children
 * sit visibly under their parent. Order is auto-sorted by page position; the
 * only thing the user controls per-row is its outline level — by dragging the
 * row horizontally or by clicking the indent / outdent action buttons. */
.bookmark-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 8px 8px 12px;
  border-radius: 8px;
  background: var(--color-glass);
  border: 1px solid transparent;
  cursor: grab;
  transition: padding-left 0.12s var(--ease-out-soft),
    background 0.15s var(--ease-out-soft), border-color 0.15s var(--ease-out-soft);
}
.bookmark-item:active {
  cursor: grabbing;
}
.bookmark-item:hover {
  background: var(--color-glass-strong);
  border-color: var(--color-glass-border);
}
.bookmark-item.dragging {
  opacity: 0.35;
  background: var(--color-glass);
  border-color: transparent;
}
/* Indent guide: one thin vertical rail per ancestor level. Drawn as a low-
 * contrast gradient that fades at the very top and bottom — softer than a hard
 * solid line, and extending past the row gap so the rails on consecutive
 * sibling rows blend into a continuous tree spine. */
.bm-guide {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 1px;
  background: linear-gradient(
    to bottom,
    transparent 0%,
    rgba(167, 139, 250, 0.18) 18%,
    rgba(167, 139, 250, 0.18) 82%,
    transparent 100%
  );
  pointer-events: none;
}
.bookmark-item:hover .bm-guide,
.bookmark-item.dragging .bm-guide {
  background: linear-gradient(
    to bottom,
    transparent 0%,
    rgba(167, 139, 250, 0.4) 18%,
    rgba(167, 139, 250, 0.4) 82%,
    transparent 100%
  );
}
/* Floating label that follows the cursor while dragging. Gives a clear "you
 * are dragging this thing" cue independent of the row's own state. */
.bookmark-ghost {
  position: fixed;
  z-index: 200;
  padding: 5px 10px;
  background: rgba(20, 20, 32, 0.94);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--color-accent);
  border-radius: 6px;
  font-size: 12px;
  color: var(--color-fg);
  pointer-events: none;
  white-space: nowrap;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
}
.bm-title {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.35;
}
.bm-title-input {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  line-height: 1.35;
  padding: 4px 6px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid var(--color-glass-border-strong);
  border-radius: 6px;
  color: var(--color-fg);
  outline: none;
}
.bm-title-input:focus {
  border-color: var(--color-accent);
}
.bm-page {
  font-size: 11px;
  color: var(--color-fg-mute);
  flex-shrink: 0;
  margin-top: 2px;
}
.bm-action {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  flex-shrink: 0;
  color: var(--color-fg-dim);
  transition: opacity 0.15s var(--ease-out-soft), background 0.15s var(--ease-out-soft),
    color 0.15s var(--ease-out-soft);
  line-height: 1;
  opacity: 0;
}
.bookmark-item:hover .bm-action,
.bookmark-item.editing .bm-action {
  opacity: 1;
}
.bm-action:disabled {
  cursor: not-allowed;
  opacity: 0.25 !important;
}
.bm-action:not(:disabled):hover {
  background: var(--color-glass-strong);
  color: var(--color-fg);
}
.bm-indent:not(:disabled):hover,
.bm-outdent:not(:disabled):hover,
.bm-edit:not(:disabled):hover {
  color: var(--color-accent);
}
.bm-del {
  font-size: 14px;
}
.bm-del:not(:disabled):hover {
  background: #e81123;
  color: #fff;
}
.bm-anchor {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--color-accent), var(--color-accent-3));
  color: #fff;
  font-size: 9px;
  margin-right: 6px;
}
</style>

<style>
/* Global rules — these target imperatively-rendered DOM (text-layer spans, placed-text overlay,
   inline editor, drag highlight classes) so they can't live in <style scoped>. They mirror the
   legacy editor.css verbatim, with var(--color-*) tokens swapped in for var(--*) tokens. */

body.text-dragging,
body.text-dragging * {
  cursor: var(--cursor-grabbing) !important;
  user-select: none !important;
}

body.resizing-sidebar,
body.resizing-sidebar * {
  cursor: ew-resize !important;
  user-select: none !important;
}

/* Cursor overrides for the page area. The tokens are defined in main.css; they
 * exist because a machine configured with a white system pointer has no visible
 * cursor over a white PDF page. */
.canvas-wrap {
  cursor: var(--cursor-default);
}
.canvas-wrap.panning,
.canvas-wrap.panning * {
  cursor: var(--cursor-grabbing) !important;
  user-select: none !important;
}
.canvas-wrap.placing-text,
.canvas-wrap.placing-text * {
  cursor: var(--cursor-crosshair) !important;
}

/* Text layer — selectable text over the canvas */
.text-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  opacity: 1;
  line-height: 1;
  pointer-events: auto;
  z-index: 2;
  cursor: var(--cursor-text);
  forced-color-adjust: none;
  user-select: text !important;
  -webkit-user-select: text !important;
}
/* The <br> siblings mark visual line ends so a multi-line selection copies out
 * with its line breaks intact. They're absolutely positioned for the same reason
 * pdf.js does it: out of flow they can't push the spans around, and Chromium
 * still serialises them as newlines. */
.text-layer span,
.text-layer br {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: var(--cursor-text);
  transform-origin: 0% 0%;
  user-select: text !important;
  -webkit-user-select: text !important;
}

/* Pan mode: text-layer must not capture mousedowns or show a text cursor — the user
 * wants to drag, not select. Disabling pointer-events lets clicks fall through to the
 * canvas-wrap mousedown handler, which starts the pan. */
.canvas-wrap.mode-pan {
  cursor: var(--cursor-grab);
}
/* pdf.js endOfContent technique. The sentinel sits below the spans (z-index: -1)
 * with user-select: none. On mousedown its top is set to the click's Y % so it
 * covers everything below the click; if the cursor strays past the bottom of the
 * spans during the drag, it lands on this sentinel and the browser can't extend
 * the selection — the selection freezes at the last valid span instead of
 * snapping all the way to the end of the page. */
.text-layer .end-of-content {
  display: block;
  position: absolute;
  inset: 100% 0 0;
  z-index: -1;
  cursor: var(--cursor-default);
  user-select: none !important;
  -webkit-user-select: none !important;
}
.text-layer .end-of-content.active {
  top: 0;
}

.canvas-wrap.mode-pan .text-layer,
.canvas-wrap.mode-pan .text-layer span,
.canvas-wrap.mode-pan .text-layer br {
  pointer-events: none;
  cursor: var(--cursor-grab);
  user-select: none !important;
  -webkit-user-select: none !important;
}

.text-layer ::selection {
  background: rgba(167, 139, 250, 0.55);
  color: transparent;
}
.text-layer ::-moz-selection {
  background: rgba(167, 139, 250, 0.55);
  color: transparent;
}

/* Search highlights — applied as classes on the existing text-layer spans by
 * useTextSearch.applyHighlights(). The "current" match gets a stronger color so
 * it's visible while you cycle through results with Enter / Shift+Enter. */
.text-layer span.search-hit {
  background-color: rgba(255, 213, 79, 0.45);
  border-radius: 1px;
}
.text-layer span.search-current {
  background-color: rgba(255, 145, 0, 0.78);
  border-radius: 1px;
  box-shadow: 0 0 0 1px rgba(255, 145, 0, 0.95);
}

/* Placed-text overlay (user-added annotations) */
.text-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 3;
}
.text-overlay .placed-text {
  position: absolute;
  white-space: pre;
  pointer-events: auto;
  cursor: var(--cursor-grab);
  user-select: none;
  transition: outline-color 0.15s var(--ease-out-soft), box-shadow 0.15s var(--ease-out-soft);
  outline: 1px dashed transparent;
  outline-offset: 3px;
  line-height: 1;
}
.text-overlay .placed-text:hover {
  outline-color: var(--color-accent);
}
.text-overlay .placed-text.dragging {
  cursor: var(--cursor-grabbing);
  outline-color: var(--color-accent-2);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.text-overlay .placed-text-del {
  position: absolute;
  top: -9px;
  right: -9px;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  background: #e81123;
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: 50%;
  font-size: 11px;
  line-height: 1;
  cursor: var(--cursor-pointer);
  opacity: 0;
  transform: scale(0.7);
  transition: opacity 0.15s var(--ease-out-soft), transform 0.15s var(--ease-out-soft);
}
.text-overlay .placed-text:hover .placed-text-del,
.text-overlay .placed-text.dragging .placed-text-del {
  opacity: 1;
  transform: scale(1);
}
.text-overlay .inline-text-editor {
  position: absolute;
  pointer-events: auto;
  white-space: pre;
  outline: 1.5px solid var(--color-accent);
  outline-offset: 4px;
  background: transparent;
  caret-color: var(--color-accent);
  min-width: 1ch;
  line-height: 1;
  user-select: text;
  z-index: 4;
}
.text-overlay .inline-text-editor::selection {
  background: rgba(167, 139, 250, 0.45);
}

.text-overlay .inline-text-toolbar {
  position: absolute;
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: rgba(20, 20, 32, 0.92);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid var(--color-glass-border);
  border-radius: 10px;
  font-size: 12px;
  color: var(--color-fg);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  z-index: 5;
  user-select: none;
  white-space: nowrap;
}
.inline-text-toolbar .tb-input {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--color-glass-border);
  border-radius: 6px;
  color: var(--color-fg);
  padding: 4px 6px;
  font-size: 12px;
  outline: none;
  font-family: inherit;
}
.inline-text-toolbar select.tb-input {
  padding-right: 4px;
  cursor: var(--cursor-pointer);
}
.inline-text-toolbar select.tb-input option {
  background: #1a1a2e;
  color: var(--color-fg);
}
.inline-text-toolbar .tb-size {
  width: 52px;
  -moz-appearance: textfield;
}
.inline-text-toolbar .tb-size::-webkit-inner-spin-button,
.inline-text-toolbar .tb-size::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.inline-text-toolbar .tb-color {
  width: 26px;
  height: 26px;
  padding: 0;
  border-radius: 6px;
  border: 1px solid var(--color-glass-border);
  background: transparent;
  cursor: var(--cursor-pointer);
  overflow: hidden;
}
.inline-text-toolbar .tb-color::-webkit-color-swatch-wrapper {
  padding: 2px;
}
.inline-text-toolbar .tb-color::-webkit-color-swatch {
  border: none;
  border-radius: 4px;
}
.inline-text-toolbar .tb-btn {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  background: transparent;
  border: 1px solid transparent;
  color: var(--color-fg-dim);
  font-size: 12px;
  line-height: 1;
  cursor: var(--cursor-pointer);
  transition: background 0.12s var(--ease-out-soft), color 0.12s var(--ease-out-soft);
}
.inline-text-toolbar .tb-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--color-fg);
}
.inline-text-toolbar .tb-btn.active {
  background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
  color: #fff;
}
.inline-text-toolbar .tb-style {
  font-size: 13px;
}
.inline-text-toolbar .tb-done {
  color: #4ade80;
}
.inline-text-toolbar .tb-done:hover {
  background: rgba(74, 222, 128, 0.18);
  color: #4ade80;
}
.inline-text-toolbar .tb-cancel {
  font-size: 16px;
}
.inline-text-toolbar .tb-cancel:hover {
  background: #e81123;
  color: #fff;
}
.inline-text-toolbar .tb-check {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--color-fg-dim);
  padding: 0 4px;
  cursor: var(--cursor-pointer);
  white-space: nowrap;
}
.inline-text-toolbar .tb-check input {
  margin: 0;
  cursor: var(--cursor-pointer);
}

.text-overlay .placed-text-badge {
  position: absolute;
  top: -8px;
  left: -8px;
  width: 16px;
  height: 16px;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, var(--color-accent), var(--color-accent-2));
  color: #fff;
  border-radius: 50%;
  font-size: 9px;
  line-height: 1;
  pointer-events: none;
  box-shadow: 0 2px 6px rgba(167, 139, 250, 0.5);
}
</style>
