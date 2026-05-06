<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import UiButton from '@/components/ui/UiButton.vue'
import PageThumb from '@/components/features/editor/PageThumb.vue'
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
import { renderCurrentPage } from '@/composables/usePdfRenderer'
import { gotoPage, deletePage, movePage, rotatePage } from '@/composables/usePageActions'
import { useZoomPan } from '@/composables/useZoomPan'
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

const canvasWrapEl = ref<HTMLDivElement | null>(null)
const canvasStageEl = ref<HTMLDivElement | null>(null)
const pdfCanvasEl = ref<HTMLCanvasElement | null>(null)
const textLayerEl = ref<HTMLDivElement | null>(null)
const textOverlayEl = ref<HTMLDivElement | null>(null)
// Second-page render targets, used in 2-page (double) view. The right page is
// canvas-only; no text-layer / no annotation overlay so editing flows still
// operate on the single "current page" left side.
const canvasStage2El = ref<HTMLDivElement | null>(null)
const pdfCanvas2El = ref<HTMLCanvasElement | null>(null)
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
  if (!item.isRepeat && item.ann.pageOriginalIdx !== undefined) {
    const ui = pdf.pageOrder.indexOf(item.ann.pageOriginalIdx)
    if (ui < 0) return
    if (ui !== pdf.currentPage) await gotoPage(ui)
  }
  editAnnotation(item.ann, item.isRepeat)
}

function removeTextItem(item: TextItem) {
  if (item.isRepeat) pdf.removeRepeatText(item.ann)
  else pdf.removeTextAnnotation(item.ann)
}

const filename = computed(() => basenameOf(pdf.filePath))

const zoom = useZoomPan(() => canvasWrapEl.value)

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

function onToggleReorder() {
  pdf.toggleGridMode()
  if (!pdf.gridMode) void renderCurrentPage()
}

function navStep(): number {
  return pdf.viewMode === 'double' ? 2 : 1
}
function onPrev() {
  void gotoPage(Math.max(0, pdf.currentPage - navStep()))
}
function onNext() {
  void gotoPage(pdf.currentPage + navStep())
}

function onToggleViewMode() {
  pdf.toggleViewMode()
  if (pdf.viewMode === 'double' && pdf.currentPage % 2 === 1) {
    // Snap to an even left-page so spreads stay aligned across navigation.
    pdf.setCurrentPage(pdf.currentPage - 1)
  }
  pdf.fitMode = true
  void renderCurrentPage()
}

function onToggleDoubleGap() {
  pdf.toggleDoublePageGap()
  pdf.fitMode = true
  void renderCurrentPage()
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
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') onPrev()
  else if (e.key === 'ArrowRight' || e.key === 'PageDown') onNext()
  else if (e.key === 'Escape') {
    if (search.visible.value) {
      closeSearch()
      return
    }
    if (pdf.pendingTextPlacement) {
      pdf.pendingTextPlacement = null
      canvasWrapEl.value?.classList.remove('placing-text')
    }
    if (isEditorActive()) cancelEditor()
  }
}

function onPageRendered() {
  drawTextOverlays()
  highlightActiveSidebarThumb()
  // Text-layer spans were just rebuilt — re-apply any active search highlights.
  applySearchHighlights()
}

// pdf.js TextLayerBuilder#bindMouse, distilled. On mousedown inside the layer the
// `endOfContent` sentinel is moved so its top edge sits at the click's Y position
// (as a percentage of the layer height). The sentinel covers everything below the
// click and has user-select: none, so once the cursor strays past the bottom of
// the spans the browser can't extend the selection there — it freezes at the last
// valid span. On mouseup we revert. Without this trick, dragging past the text
// snaps the selection to the topmost or bottommost span on the page.
function onTextLayerMouseDown(e: MouseEvent) {
  if (e.button !== 0) return
  const layer = textLayerEl.value
  if (!layer) return
  const end = layer.querySelector<HTMLDivElement>('.end-of-content')
  if (!end) return
  // adjustTop is only meaningful when the click landed on a text run (not the
  // empty layer); in Firefox the -moz-user-select check skips the dynamic
  // positioning since user-select: none on the sentinel is enough there.
  let adjustTop = e.target !== layer
  adjustTop &&=
    getComputedStyle(end).getPropertyValue('-moz-user-select') !== 'none'
  if (adjustTop) {
    const layerRect = layer.getBoundingClientRect()
    const r = Math.max(0, (e.pageY - layerRect.top) / layerRect.height)
    end.style.top = `${(r * 100).toFixed(2)}%`
  }
  end.classList.add('active')
}

function onTextLayerMouseUp() {
  const layer = textLayerEl.value
  if (!layer) return
  const end = layer.querySelector<HTMLDivElement>('.end-of-content')
  if (!end) return
  end.style.top = ''
  end.classList.remove('active')
}

function highlightActiveSidebarThumb() {
  const list = pageListEl.value
  if (!list) return
  const active = list.querySelector(`[data-ui-idx="${pdf.currentPage}"]`) as HTMLElement | null
  if (!active) return
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

// When grid-mode toggles back to single-page, the canvas may need a fit re-render
watch(
  () => pdf.gridMode,
  (next) => {
    if (!next) void renderCurrentPage()
  },
)

onMounted(async () => {
  // Wire the editor refs to the actual DOM nodes for the imperative composables.
  refs.canvasWrap.value = canvasWrapEl.value
  refs.canvasStage.value = canvasStageEl.value
  refs.pdfCanvas.value = pdfCanvasEl.value
  refs.textLayer.value = textLayerEl.value
  refs.textOverlay.value = textOverlayEl.value
  refs.canvasStage2.value = canvasStage2El.value
  refs.pdfCanvas2.value = pdfCanvas2El.value

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('pdf:page-rendered', onPageRendered)
  textLayerEl.value?.addEventListener('mousedown', onTextLayerMouseDown)
  textLayerEl.value?.addEventListener('mouseup', onTextLayerMouseUp)

  // If the user landed on /editor without a loaded doc, bounce back to welcome.
  if (!pdf.pdfjsDoc) {
    void router.replace({ name: 'welcome' })
    return
  }
  // First render
  await renderCurrentPage()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('pdf:page-rendered', onPageRendered)
  textLayerEl.value?.removeEventListener('mousedown', onTextLayerMouseDown)
  textLayerEl.value?.removeEventListener('mouseup', onTextLayerMouseUp)
  // Clear refs so other screens don't accidentally read stale DOM.
  refs.canvasWrap.value = null
  refs.canvasStage.value = null
  refs.pdfCanvas.value = null
  refs.textLayer.value = null
  refs.textOverlay.value = null
  refs.canvasStage2.value = null
  refs.pdfCanvas2.value = null
})
</script>

<template>
  <section
    class="editor grid h-full grid-rows-1 gap-3 p-3"
    :style="{ '--right-sidebar-width': `${rightSidebarWidth}px` }"
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
          ref="canvasWrapEl"
          class="canvas-wrap"
          :class="[
            { 'grid-mode': pdf.gridMode },
            { 'view-double': pdf.viewMode === 'double', 'gap-on': pdf.doublePageGap },
            `mode-${pdf.interactionMode}`,
          ]"
          @wheel="zoom.onWheel"
          @mousedown="onMouseDown"
        >
          <div class="spread">
            <div ref="canvasStageEl" class="canvas-stage">
              <canvas ref="pdfCanvasEl" />
              <div ref="textLayerEl" class="text-layer" />
              <div ref="textOverlayEl" class="text-overlay" />
            </div>
            <div
              v-show="pdf.viewMode === 'double'"
              ref="canvasStage2El"
              class="canvas-stage canvas-stage-right"
            >
              <canvas ref="pdfCanvas2El" />
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
        <UiButton variant="default" size="icon" title="Fit to page" @click="zoom.onZoomFitClick">
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

/* Canvas-wrap — precise positioning is required, scoped block holds the legacy CSS verbatim. */
.canvas-wrap {
  flex: 1 1 0;
  min-height: 0;
  border-radius: 14px;
  overflow: auto;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--color-glass-border);
  display: flex;
  align-items: safe flex-start;
  justify-content: safe center;
  padding: 24px;
  position: relative;
}
.canvas-wrap.placing-text,
.canvas-wrap.placing-text * {
  cursor: crosshair !important;
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
/* Spread = the wrapper that holds the left page (and the right page in
 * 2-page view). In single mode it contains one stage and behaves the same as
 * before; in double mode it lays out the two stages side by side and the
 * gap-on modifier inserts a visible gap between them. */
.spread {
  display: flex;
  align-items: flex-start;
  flex-shrink: 0;
}
.canvas-wrap.view-double.gap-on .spread {
  gap: 16px;
}

.canvas-stage {
  position: relative;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  border-radius: 4px;
  overflow: hidden;
  flex-shrink: 0;
}
.canvas-stage :deep(canvas#pdfCanvas),
.canvas-stage :deep(canvas) {
  display: block;
  background: #fff;
}
.canvas-stage.panning,
.canvas-stage.panning * {
  cursor: grabbing !important;
  user-select: none !important;
}
.canvas-wrap.grid-mode {
  padding: 24px;
  align-items: flex-start;
}
.canvas-wrap.grid-mode .canvas-stage,
.canvas-wrap.grid-mode .spread {
  display: none;
}
.grid-view {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 18px;
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
  cursor: grabbing !important;
  user-select: none !important;
}

body.resizing-sidebar,
body.resizing-sidebar * {
  cursor: ew-resize !important;
  user-select: none !important;
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
  cursor: text;
  forced-color-adjust: none;
  user-select: text !important;
  -webkit-user-select: text !important;
}
.text-layer span {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
  user-select: text !important;
  -webkit-user-select: text !important;
}

/* Pan mode: text-layer must not capture mousedowns or show a text cursor — the user
 * wants to drag, not select. Disabling pointer-events lets clicks fall through to the
 * canvas-wrap mousedown handler, which starts the pan. */
.canvas-wrap.mode-pan {
  cursor: grab;
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
  cursor: default;
  user-select: none !important;
  -webkit-user-select: none !important;
}
.text-layer .end-of-content.active {
  top: 0;
}

.canvas-wrap.mode-pan .text-layer,
.canvas-wrap.mode-pan .text-layer span {
  pointer-events: none;
  cursor: grab;
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
  cursor: grab;
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
  cursor: grabbing;
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
  cursor: pointer;
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
  cursor: pointer;
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
  cursor: pointer;
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
  cursor: pointer;
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
  cursor: pointer;
  white-space: nowrap;
}
.inline-text-toolbar .tb-check input {
  margin: 0;
  cursor: pointer;
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
