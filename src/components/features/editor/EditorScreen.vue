<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import UiButton from '@/components/ui/UiButton.vue'
import PageThumb from '@/components/features/editor/PageThumb.vue'
import BookmarkModal from '@/components/features/editor/BookmarkModal.vue'
import SelectionToolbar from '@/components/features/editor/SelectionToolbar.vue'
import { PDF_CONFIG, usePdfStore, type Bookmark } from '@/stores/pdf'
import { useEditorRefs } from '@/composables/useEditorRefs'
import { renderCurrentPage } from '@/composables/usePdfRenderer'
import { gotoPage, deletePage, movePage, rotatePage } from '@/composables/usePageActions'
import { useZoomPan } from '@/composables/useZoomPan'
import { createPageDragHandlers } from '@/composables/useThumbnails'
import {
  drawTextOverlays,
  startTextPlacement,
  placePendingTextAt,
  isEditorActive,
  cancelEditor,
} from '@/composables/useTextOverlay'
import { captureCanvasSelection, gotoBookmark } from '@/composables/useBookmarks'
import { savePdf } from '@/composables/useSavePdf'
import { basenameOf } from '@/composables/useOpenPdf'

const router = useRouter()
const route = useRoute()
const pdf = usePdfStore()
const refs = useEditorRefs()

const canvasWrapEl = ref<HTMLDivElement | null>(null)
const canvasStageEl = ref<HTMLDivElement | null>(null)
const pdfCanvasEl = ref<HTMLCanvasElement | null>(null)
const textLayerEl = ref<HTMLDivElement | null>(null)
const textOverlayEl = ref<HTMLDivElement | null>(null)
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
  // A click inside a text-layer span belongs to the browser's text selection.
  const layer = textLayerEl.value
  if (layer && layer !== e.target && layer.contains(e.target as Node)) return
  zoom.startPan(e)
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

function onPrev() {
  void gotoPage(pdf.currentPage - 1)
}
function onNext() {
  void gotoPage(pdf.currentPage + 1)
}

function onKeyDown(e: KeyboardEvent) {
  if (route.name !== 'editor') return
  const t = e.target as HTMLElement
  if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return
  if (t.isContentEditable) return
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') onPrev()
  else if (e.key === 'ArrowRight' || e.key === 'PageDown') onNext()
  else if (e.key === 'Escape') {
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
  void gotoBookmark(b)
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
  pdf.sortBookmarks()
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

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('pdf:page-rendered', onPageRendered)

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
  // Clear refs so other screens don't accidentally read stale DOM.
  refs.canvasWrap.value = null
  refs.canvasStage.value = null
  refs.pdfCanvas.value = null
  refs.textLayer.value = null
  refs.textOverlay.value = null
})
</script>

<template>
  <section class="editor grid h-full grid-rows-1 gap-3 p-3">
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
      <div class="glass flex items-center gap-3 rounded-[14px] px-3 py-2">
        <UiButton variant="ghost" size="sm" title="Back to home" @click="router.push({ name: 'welcome' })">
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
          Home
        </UiButton>
        <span class="flex-1 truncate px-2 text-[13px] text-fg-dim">{{ filename }}</span>
        <div class="flex gap-2">
          <UiButton
            variant="ghost"
            size="sm"
            :toggled="pdf.gridMode"
            title="Toggle grid reorder view"
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
            <span>{{ pdf.gridMode ? 'Done' : 'Reorder' }}</span>
          </UiButton>
          <UiButton variant="ghost" size="sm" title="Rotate page left" @click="onRotateLeft">
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
          <UiButton variant="ghost" size="sm" title="Rotate page right" @click="onRotateRight">
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
          <UiButton variant="ghost" size="sm" title="Add text" @click="onAddText">
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
            Text
          </UiButton>
          <UiButton variant="ghost" size="sm" title="Bookmark current page" @click="onAddBookmark">
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
            Bookmark
          </UiButton>
          <UiButton variant="primary" size="sm" @click="savePdf">
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
            Save
          </UiButton>
        </div>
      </div>

      <div
        ref="canvasWrapEl"
        class="canvas-wrap"
        :class="{ 'grid-mode': pdf.gridMode }"
        @wheel="zoom.onWheel"
        @mousedown="onMouseDown"
      >
        <div ref="canvasStageEl" class="canvas-stage">
          <canvas ref="pdfCanvasEl" />
          <div ref="textLayerEl" class="text-layer" />
          <div ref="textOverlayEl" class="text-overlay" />
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
          class="min-w-[64px] text-center text-[13px] text-fg-dim"
          style="font-variant-numeric: tabular-nums"
        >
          {{ pdf.currentPage + 1 }} / {{ pdf.pageOrder.length }}
        </span>
        <UiButton
          variant="default"
          size="icon"
          title="Next page"
          :disabled="pdf.currentPage >= pdf.pageOrder.length - 1"
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
      class="glass right-sidebar flex min-h-0 flex-col overflow-hidden rounded-[14px]"
    >
      <div
        class="border-b border-white/[0.06] px-4 py-3.5 text-xs font-semibold uppercase tracking-[0.5px] text-fg-dim"
      >
        Bookmarks
      </div>
      <div class="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2.5">
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
          :class="{ editing: editingBookmarkIdx === i }"
          @click="onBookmarkClick(b)"
          @dblclick.stop="startBookmarkEdit(i, b)"
        >
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
            class="bm-edit"
            title="Rename"
            @click.stop="startBookmarkEdit(i, b)"
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
            class="bm-del"
            title="Remove"
            @click.stop="pdf.removeBookmark(i)"
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
  </section>
</template>

<style scoped>
.editor {
  grid-template-columns: 240px 1fr 280px;
}
@media (max-width: 1100px) {
  .editor {
    grid-template-columns: 200px 1fr 240px;
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
.canvas-wrap.grid-mode .canvas-stage {
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

/* Bookmark items */
.bookmark-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--color-glass);
  border: 1px solid transparent;
  cursor: pointer;
  transition: transform 0.15s var(--ease-out-soft), background 0.15s var(--ease-out-soft),
    border-color 0.15s var(--ease-out-soft);
}
.bookmark-item:hover {
  background: var(--color-glass-strong);
  border-color: var(--color-glass-border);
  transform: translateX(2px);
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
.bm-edit,
.bm-del {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  opacity: 0;
  flex-shrink: 0;
  transition: opacity 0.15s var(--ease-out-soft), background 0.15s var(--ease-out-soft);
  line-height: 1;
}
.bm-del {
  font-size: 14px;
}
.bookmark-item:hover .bm-edit,
.bookmark-item:hover .bm-del,
.bookmark-item.editing .bm-edit,
.bookmark-item.editing .bm-del {
  opacity: 1;
}
.bm-edit:hover {
  background: var(--color-glass-strong);
  color: var(--color-accent);
}
.bm-del:hover {
  background: #e81123;
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

/* Text layer — selectable text over the canvas */
.text-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  opacity: 1;
  line-height: 1;
  pointer-events: auto;
  z-index: 2;
  cursor: grab;
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
.text-layer ::selection {
  background: rgba(167, 139, 250, 0.55);
  color: transparent;
}
.text-layer ::-moz-selection {
  background: rgba(167, 139, 250, 0.55);
  color: transparent;
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
