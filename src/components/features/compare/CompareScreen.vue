<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import UiButton from '@/components/ui/UiButton.vue'
import { PDF_CONFIG, usePdfStore } from '@/stores/pdf'
import { showLoading, hideLoading } from '@/composables/useLoading'
import { toast } from '@/composables/useToast'
import { ipcInvoke, nodePath, readFileAsArrayBuffer } from '@/utils/electron'
import { usePdfjs } from '@/composables/usePdfEngine'
import {
  diffPageText,
  diffPageVisual,
  flattenHunks,
  unionBox,
  type DiffBox,
  type DiffKind,
  type FlatHunk,
  type PageDiff,
} from '@/composables/useCompareDiff'

defineOptions({ name: 'CompareScreen' })

const router = useRouter()
const route = useRoute()
const pdf = usePdfStore()

interface OpenDialogResult {
  canceled: boolean
  filePaths: string[]
}

interface PdfPageLike {
  getViewport(opts: { scale: number }): {
    width: number
    height: number
    transform: number[]
    scale: number
  }
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): {
    promise: Promise<void>
  }
  getTextContent(): Promise<{
    items: Array<{ str: string; transform: number[]; width?: number }>
  }>
}

const SVG_NS = 'http://www.w3.org/2000/svg'

// Refs to all the panes/canvases — every imperative layout/render reads from these.
const bodyEl = ref<HTMLDivElement | null>(null)
const connectorsEl = ref<SVGSVGElement | null>(null)
const leftPaneEl = ref<HTMLDivElement | null>(null)
const rightPaneEl = ref<HTMLDivElement | null>(null)
const leftWrapEl = ref<HTMLDivElement | null>(null)
const rightWrapEl = ref<HTMLDivElement | null>(null)
const leftStageEl = ref<HTMLDivElement | null>(null)
const rightStageEl = ref<HTMLDivElement | null>(null)
const leftCanvasEl = ref<HTMLCanvasElement | null>(null)
const rightCanvasEl = ref<HTMLCanvasElement | null>(null)
const leftOverlayEl = ref<HTMLDivElement | null>(null)
const rightOverlayEl = ref<HTMLDivElement | null>(null)
const leftEmptyEl = ref<HTMLDivElement | null>(null)
const rightEmptyEl = ref<HTMLDivElement | null>(null)

// Reactive UI state derived from pdf.compare
const totalPages = computed(() => {
  const c = pdf.compare
  return Math.max(c.left ? c.left.numPages : 0, c.right ? c.right.numPages : 0)
})
const summaryAdded = ref(0)
const summaryRemoved = ref(0)
const summaryChanged = ref(0)
const showSummary = ref(false)
const showNav = ref(false)
const zoomLabel = ref('100%')
const leftStatus = ref<DiffKind | null>(null)
const rightStatus = ref<DiffKind | null>(null)

let leftScale = 1
let rightScale = 1
let currentHunkIdx = -1
let connectorRafPending = false

function scheduleDrawConnectors() {
  if (connectorRafPending) return
  connectorRafPending = true
  requestAnimationFrame(() => {
    connectorRafPending = false
    drawConnectors()
  })
}

function clearOverlay(side: 'left' | 'right') {
  const el = side === 'left' ? leftOverlayEl.value : rightOverlayEl.value
  if (el) el.innerHTML = ''
}

function paintOverlay(side: 'left' | 'right', boxes: DiffBox[], scale: number) {
  const overlay = side === 'left' ? leftOverlayEl.value : rightOverlayEl.value
  if (!overlay) return
  overlay.innerHTML = ''
  if (!boxes.length || !scale) return
  const frag = document.createDocumentFragment()
  for (const b of boxes) {
    const el = document.createElement('div')
    el.className = `diff-box ${b.kind}`
    el.style.left = `${b.x * scale}px`
    el.style.top = `${b.y * scale}px`
    el.style.width = `${Math.max(2, b.w * scale)}px`
    el.style.height = `${Math.max(2, b.h * scale)}px`
    frag.appendChild(el)
  }
  overlay.appendChild(frag)
}

function setStatusBadge(side: 'left' | 'right', status: DiffKind | null) {
  if (side === 'left') leftStatus.value = status
  else rightStatus.value = status
}

function computeScale(page: PdfPageLike | null, wrap: HTMLElement | null): number {
  if (!page || !wrap) return 0
  const c = pdf.compare
  if (!c.fitMode) return c.zoom
  const baseViewport = page.getViewport({ scale: 1 })
  const aw = wrap.clientWidth - 32
  const ah = wrap.clientHeight - 32
  const s = Math.min(aw / baseViewport.width, ah / baseViewport.height)
  return isFinite(s) && s > 0 ? s : 1
}

async function renderPageToCanvas(
  page: PdfPageLike,
  side: 'left' | 'right',
  scale?: number,
): Promise<void> {
  const wrap = side === 'left' ? leftWrapEl.value : rightWrapEl.value
  const canvas = side === 'left' ? leftCanvasEl.value : rightCanvasEl.value
  const stage = side === 'left' ? leftStageEl.value : rightStageEl.value
  const empty = side === 'left' ? leftEmptyEl.value : rightEmptyEl.value
  if (!canvas || !stage) return
  if (scale == null) scale = computeScale(page, wrap)
  if (side === 'left') leftScale = scale!
  else rightScale = scale!
  const viewport = page.getViewport({ scale: scale! })
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.floor(viewport.width * dpr)
  canvas.height = Math.floor(viewport.height * dpr)
  canvas.style.width = `${viewport.width}px`
  canvas.style.height = `${viewport.height}px`
  stage.style.width = `${viewport.width}px`
  stage.style.height = `${viewport.height}px`
  stage.classList.remove('empty', 'removed-side', 'added-side')
  if (empty) empty.style.display = 'none'
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, viewport.width, viewport.height)
  await page.render({ canvasContext: ctx, viewport }).promise
}

function showEmptyPane(side: 'left' | 'right', kind: 'added' | 'removed' | null): void {
  const otherCanvas = side === 'left' ? rightCanvasEl.value : leftCanvasEl.value
  const stage = side === 'left' ? leftStageEl.value : rightStageEl.value
  const canvas = side === 'left' ? leftCanvasEl.value : rightCanvasEl.value
  const empty = side === 'left' ? leftEmptyEl.value : rightEmptyEl.value
  if (!stage || !canvas) return
  const w = otherCanvas?.style.width || '400px'
  const h = otherCanvas?.style.height || '500px'
  stage.style.width = w
  stage.style.height = h
  canvas.style.width = w
  canvas.style.height = h
  canvas.width = 1
  canvas.height = 1
  stage.classList.add('empty')
  if (kind === 'removed') stage.classList.add('removed-side')
  if (kind === 'added') stage.classList.add('added-side')
  if (empty) {
    empty.style.display = ''
    empty.textContent =
      kind === 'removed' ? 'Page removed' : kind === 'added' ? 'Page added' : 'No page'
  }
  clearOverlay(side)
}

async function renderSidePreview(side: 'left' | 'right'): Promise<void> {
  const meta = pdf.compare[side]
  if (!meta) return
  const page = (await meta.doc.getPage(1)) as PdfPageLike
  await renderPageToCanvas(page, side)
  clearOverlay(side)
}

function refreshPaneState(): void {
  const c = pdf.compare
  if (leftPaneEl.value) leftPaneEl.value.classList.toggle('empty', !c.left)
  if (rightPaneEl.value) rightPaneEl.value.classList.toggle('empty', !c.right)
}

async function loadPdfForSide(side: 'left' | 'right', filePath: string): Promise<void> {
  try {
    const path = nodePath()
    showLoading(`Loading ${path.basename(filePath)}...`)
    const ab = await readFileAsArrayBuffer(filePath)
    const data = ab.slice(0)
    const pdfjs = usePdfjs()
    const doc = (await pdfjs.getDocument({ data }).promise) as { numPages: number; getPage(n: number): Promise<unknown> }
    // markRaw: pdf.js doc uses private class fields; Pinia's reactive Proxy breaks them.
    pdf.compare[side] = markRaw({
      name: path.basename(filePath),
      doc,
      numPages: doc.numPages,
    })
    pdf.compare.diffs = []
    pdf.compare.currentPage = 0
    currentHunkIdx = -1
    refreshPaneState()
    showSummary.value = false
    showNav.value = false
    drawConnectors()
    await renderSidePreview(side)
  } catch (err) {
    console.error(err)
    const msg = err instanceof Error ? err.message : String(err)
    toast(`Failed to load PDF: ${msg}`, 'error')
  } finally {
    hideLoading()
  }
}

async function pickFile(side: 'left' | 'right'): Promise<void> {
  const r = await ipcInvoke<OpenDialogResult>('dialog:open', {
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (r.canceled || r.filePaths.length === 0) return
  await loadPdfForSide(side, r.filePaths[0])
}

interface FileWithPath extends File {
  path: string
}

function onPaneClick(side: 'left' | 'right') {
  const pane = side === 'left' ? leftPaneEl.value : rightPaneEl.value
  if (!pane?.classList.contains('empty')) return
  void pickFile(side)
}

function onPaneDragEnter(e: DragEvent, side: 'left' | 'right') {
  const pane = side === 'left' ? leftPaneEl.value : rightPaneEl.value
  if (!pane?.classList.contains('empty')) return
  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
    e.preventDefault()
    e.stopPropagation()
    const wrap = side === 'left' ? leftWrapEl.value : rightWrapEl.value
    wrap?.classList.add('dragover')
  }
}

function onPaneDragOver(e: DragEvent, side: 'left' | 'right') {
  onPaneDragEnter(e, side)
}

function onPaneDragLeave(side: 'left' | 'right') {
  const wrap = side === 'left' ? leftWrapEl.value : rightWrapEl.value
  wrap?.classList.remove('dragover')
}

async function onPaneDrop(e: DragEvent, side: 'left' | 'right') {
  e.preventDefault()
  e.stopPropagation()
  const wrap = side === 'left' ? leftWrapEl.value : rightWrapEl.value
  wrap?.classList.remove('dragover')
  const file = (
    e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : []
  ).find((f) => f.name.toLowerCase().endsWith('.pdf')) as FileWithPath | undefined
  if (!file) return
  await loadPdfForSide(side, file.path)
}

function onSwap() {
  const c = pdf.compare
  if (!c.left || !c.right) return
  const tmp = c.left
  c.left = c.right
  c.right = tmp
  c.diffs = []
  currentHunkIdx = -1
  refreshPaneState()
  showSummary.value = false
  showNav.value = false
  clearOverlay('left')
  clearOverlay('right')
  drawConnectors()
  void renderSidePreview('left')
  void renderSidePreview('right')
}

function onTextOnlyChange(e: Event) {
  pdf.compare.textOnly = (e.target as HTMLInputElement).checked
  pdf.compare.diffs = []
  currentHunkIdx = -1
  showSummary.value = false
  showNav.value = false
  clearOverlay('left')
  clearOverlay('right')
  drawConnectors()
}

function updateSummary() {
  let added = 0
  let removed = 0
  let changed = 0
  for (const d of pdf.compare.diffs) {
    if (!d) continue
    added += d.addedCount || 0
    removed += d.removedCount || 0
    if (d.changed) changed++
  }
  summaryAdded.value = added
  summaryRemoved.value = removed
  summaryChanged.value = changed
}

async function runCompare(): Promise<void> {
  const c = pdf.compare
  if (!c.left || !c.right) return
  const max = Math.max(c.left.numPages, c.right.numPages)
  showLoading(c.textOnly ? 'Comparing text...' : 'Comparing visually...')
  try {
    const diffs: PageDiff[] = new Array(max)
    const leftDoc = c.left.doc
    const rightDoc = c.right.doc
    for (let i = 0; i < max; i++) {
      if (i % 3 === 0) await new Promise((r) => setTimeout(r, 0))
      const lp = i < c.left.numPages ? ((await leftDoc.getPage(i + 1)) as PdfPageLike) : null
      const rp = i < c.right.numPages ? ((await rightDoc.getPage(i + 1)) as PdfPageLike) : null
      diffs[i] = c.textOnly ? await diffPageText(lp, rp) : await diffPageVisual(lp, rp)
    }
    c.diffs = diffs
    currentHunkIdx = -1
    updateSummary()
    showSummary.value = true
    showNav.value = true
    const firstChanged = diffs.findIndex((d) => d && d.changed)
    await gotoComparePage(firstChanged >= 0 ? firstChanged : 0)
  } catch (err) {
    console.error(err)
    const msg = err instanceof Error ? err.message : String(err)
    toast(`Compare failed: ${msg}`, 'error')
  } finally {
    hideLoading()
  }
}

async function renderComparePage(): Promise<void> {
  const c = pdf.compare
  const total = totalPages.value
  if (total === 0) return
  const idx = c.currentPage
  const lp =
    c.left && idx < c.left.numPages
      ? ((await c.left.doc.getPage(idx + 1)) as PdfPageLike)
      : null
  const rp =
    c.right && idx < c.right.numPages
      ? ((await c.right.doc.getPage(idx + 1)) as PdfPageLike)
      : null
  leftScale = computeScale(lp, leftWrapEl.value)
  rightScale = computeScale(rp, rightWrapEl.value)

  await Promise.all([
    lp
      ? renderPageToCanvas(lp, 'left', leftScale)
      : Promise.resolve(showEmptyPane('left', rp ? 'added' : null)),
    rp
      ? renderPageToCanvas(rp, 'right', rightScale)
      : Promise.resolve(showEmptyPane('right', lp ? 'removed' : null)),
  ])

  const d = c.diffs[idx]
  if (d) {
    paintOverlay('left', d.leftBoxes, leftScale)
    paintOverlay('right', d.rightBoxes, rightScale)
    setStatusBadge('left', d.leftStatus)
    setStatusBadge('right', d.rightStatus)
  } else {
    clearOverlay('left')
    clearOverlay('right')
    setStatusBadge('left', null)
    setStatusBadge('right', null)
  }

  const shownScale = leftScale || rightScale || 1
  zoomLabel.value = c.fitMode ? 'Fit' : `${Math.round(shownScale * 100)}%`
  drawConnectors()
}

async function gotoComparePage(idx: number): Promise<void> {
  const total = totalPages.value
  if (total === 0) return
  if (idx < 0) idx = 0
  if (idx >= total) idx = total - 1
  pdf.compare.currentPage = idx
  await renderComparePage()
  if (leftWrapEl.value) leftWrapEl.value.scrollTop = 0
  if (rightWrapEl.value) rightWrapEl.value.scrollTop = 0
  drawConnectors()
}

function stepZoom(dir: 1 | -1) {
  const c = pdf.compare
  c.fitMode = false
  c.zoom = Math.max(
    PDF_CONFIG.ZOOM_MIN,
    Math.min(PDF_CONFIG.ZOOM_MAX, c.zoom + dir * PDF_CONFIG.ZOOM_STEP),
  )
  void renderComparePage()
}

async function jumpDiff(direction: 1 | -1): Promise<void> {
  const all = flattenHunks(pdf.compare.diffs)
  if (!all.length) {
    toast('No differences found', 'success')
    return
  }
  if (currentHunkIdx < 0 || currentHunkIdx >= all.length) {
    const page = pdf.compare.currentPage
    const onPage = all.findIndex((h) => h.page === page)
    currentHunkIdx = onPage >= 0 ? onPage : direction > 0 ? -1 : all.length
  }
  let idx = currentHunkIdx + direction
  if (idx < 0) idx = all.length - 1
  if (idx >= all.length) idx = 0
  currentHunkIdx = idx
  const target = all[idx]
  if (target.page !== pdf.compare.currentPage) {
    await gotoComparePage(target.page)
  }
  scrollHunkIntoView(target)
}

function scrollHunkIntoView(target: FlatHunk): void {
  const hunk = target.hunk
  let scale: number
  let stage: HTMLElement | null
  let wrap: HTMLElement | null
  if (hunk.leftBoxes.length) {
    scale = leftScale
    stage = leftStageEl.value
    wrap = leftWrapEl.value
  } else {
    scale = rightScale
    stage = rightStageEl.value
    wrap = rightWrapEl.value
  }
  if (!stage || !wrap) return
  const yPx = stage.offsetTop + target.y * scale
  const inView =
    yPx >= wrap.scrollTop + 12 && yPx + 80 <= wrap.scrollTop + wrap.clientHeight
  if (!inView) {
    wrap.scrollTop = Math.max(0, yPx - wrap.clientHeight * 0.25)
  }
  scheduleDrawConnectors()
}

function drawConnectors(): void {
  // Connector design: thin Bezier curves confined to the gutter between the two panes
  // (X anchored at the panes' inner edges, never over the canvas content). Y matches
  // each hunk's vertical position on its side, clamped to the visible viewport so
  // off-screen hunks terminate at the gutter top/bottom edge instead of bleeding into
  // adjacent UI. Inspired by VSCode/Meld/Beyond Compare diff connectors.
  const svg = connectorsEl.value
  const body = bodyEl.value
  if (!svg || !body) return
  while (svg.firstChild) svg.removeChild(svg.firstChild)

  const c = pdf.compare
  const d = c.diffs[c.currentPage]
  if (!d || !d.hunks || !d.hunks.length) return

  const bRect = body.getBoundingClientRect()
  svg.setAttribute('viewBox', `0 0 ${bRect.width} ${bRect.height}`)

  const lc = leftCanvasEl.value
  const rc = rightCanvasEl.value
  const lw = leftWrapEl.value
  const rw = rightWrapEl.value
  if (!lc || !rc || !lw || !rw) return
  const lcRect = lc.getBoundingClientRect()
  const rcRect = rc.getBoundingClientRect()
  const lwRect = lw.getBoundingClientRect()
  const rwRect = rw.getBoundingClientRect()
  const ls = leftScale || 1
  const rs = rightScale || 1

  // X: pane inner edges (gutter only). Y: hunk position on its side, clamped.
  const lx = lwRect.right - bRect.left
  const rx = rwRect.left - bRect.left
  const lyMin = lwRect.top - bRect.top
  const lyMax = lwRect.bottom - bRect.top
  const ryMin = rwRect.top - bRect.top
  const ryMax = rwRect.bottom - bRect.top

  function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v))
  }

  const frag = document.createDocumentFragment()
  for (const h of d.hunks) {
    const hasL = h.leftBoxes.length
    const hasR = h.rightBoxes.length
    if (!hasL && !hasR) continue
    const kind = h.kind || (hasL && hasR ? 'changed' : hasL ? 'removed' : 'added')

    let leftY: number
    let rightY: number
    if (hasL) {
      const u = unionBox(h.leftBoxes)
      leftY = lcRect.top + (u.y + u.h / 2) * ls - bRect.top
    } else {
      const u = unionBox(h.rightBoxes)
      leftY = rcRect.top + (u.y + u.h / 2) * rs - bRect.top
    }
    if (hasR) {
      const u = unionBox(h.rightBoxes)
      rightY = rcRect.top + (u.y + u.h / 2) * rs - bRect.top
    } else {
      const u = unionBox(h.leftBoxes)
      rightY = lcRect.top + (u.y + u.h / 2) * ls - bRect.top
    }

    // Skip when both ends are fully outside their pane's viewport.
    const lOutside = leftY < lyMin - 4 || leftY > lyMax + 4
    const rOutside = rightY < ryMin - 4 || rightY > ryMax + 4
    if (lOutside && rOutside) continue

    const ly = clamp(leftY, lyMin, lyMax)
    const ry = clamp(rightY, ryMin, ryMax)

    // Horizontal-tangent Bezier through the gutter — very small horizontal span keeps
    // the curve compact and unambiguous about which Y maps to which Y.
    const mx = (lx + rx) / 2
    const path = `M ${lx.toFixed(1)},${ly.toFixed(1)} C ${mx.toFixed(1)},${ly.toFixed(
      1,
    )} ${mx.toFixed(1)},${ry.toFixed(1)} ${rx.toFixed(1)},${ry.toFixed(1)}`
    const el = document.createElementNS(SVG_NS, 'path')
    el.setAttribute('d', path)
    el.setAttribute('class', kind)
    frag.appendChild(el)
  }
  svg.appendChild(frag)
}

function setupScrollSync(): () => void {
  const lw = leftWrapEl.value
  const rw = rightWrapEl.value
  if (!lw || !rw) return () => {}
  let syncing = false
  function onScroll(src: HTMLElement, dst: HTMLElement) {
    if (!syncing) {
      syncing = true
      const srcMax = Math.max(1, src.scrollHeight - src.clientHeight)
      const dstMax = Math.max(0, dst.scrollHeight - dst.clientHeight)
      dst.scrollTop = (src.scrollTop / srcMax) * dstMax
      requestAnimationFrame(() => {
        syncing = false
      })
    }
    scheduleDrawConnectors()
  }
  const onLeft = () => onScroll(lw, rw)
  const onRight = () => onScroll(rw, lw)
  lw.addEventListener('scroll', onLeft, { passive: true })
  rw.addEventListener('scroll', onRight, { passive: true })
  return () => {
    lw.removeEventListener('scroll', onLeft)
    rw.removeEventListener('scroll', onRight)
  }
}

function onKeyDown(e: KeyboardEvent) {
  if (route.name !== 'compare') return
  const t = e.target as HTMLElement
  if (t && /^(INPUT|TEXTAREA)$/.test(t.tagName)) return
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') void gotoComparePage(pdf.compare.currentPage - 1)
  if (e.key === 'ArrowRight' || e.key === 'PageDown')
    void gotoComparePage(pdf.compare.currentPage + 1)
}

function onResize() {
  if (route.name !== 'compare') return
  if (pdf.compare.fitMode) void renderComparePage()
  else drawConnectors()
}

let scrollSyncCleanup: (() => void) | null = null

onMounted(async () => {
  refreshPaneState()
  scrollSyncCleanup = setupScrollSync()
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('resize', onResize)
  // If sides are already loaded (returning to the screen), redraw previews.
  if (pdf.compare.left) await renderSidePreview('left')
  if (pdf.compare.right) await renderSidePreview('right')
  if (pdf.compare.diffs.length > 0) {
    showSummary.value = true
    showNav.value = true
    updateSummary()
    await renderComparePage()
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('resize', onResize)
  scrollSyncCleanup?.()
})

watch(
  () => pdf.compare.zoom,
  () => {
    /* triggered via stepZoom which already calls renderComparePage */
  },
)
</script>

<route lang="json">
{ "name": "compare" }
</route>

<template>
  <section class="compare flex h-full min-h-0 flex-col gap-3 p-4">
    <header class="flex items-center gap-4 px-1">
      <UiButton variant="ghost" size="sm" @click="router.push({ name: 'welcome' })">
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
      <h2
        class="flex-1 text-lg font-semibold tracking-[-0.3px] text-transparent"
        :style="{
          background: 'linear-gradient(135deg, #fff, #c4b5fd)',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
        }"
      >
        Compare PDFs
      </h2>
      <div class="flex items-center gap-3.5">
        <UiButton
          variant="ghost"
          size="icon"
          class="h-8 w-8"
          title="Swap sides"
          :disabled="!(pdf.compare.left && pdf.compare.right)"
          @click="onSwap"
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="17 1 21 5 17 9" />
            <path d="M3 11V9a4 4 0 0 1 4-4h14" />
            <polyline points="7 23 3 19 7 15" />
            <path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
        </UiButton>
        <label
          class="flex cursor-pointer items-center gap-2.5 py-1 text-[13px] text-fg-dim"
          title="Compare only the text content, ignoring visual rendering"
        >
          <input
            type="checkbox"
            :checked="pdf.compare.textOnly"
            class="h-4 w-4 cursor-pointer accent-accent"
            @change="onTextOnlyChange"
          />
          <span>Text only</span>
        </label>
        <UiButton
          variant="primary"
          size="sm"
          :disabled="!(pdf.compare.left && pdf.compare.right)"
          @click="runCompare"
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
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
          Compare
        </UiButton>
      </div>
    </header>

    <div
      v-if="showSummary"
      class="glass flex items-center justify-between gap-4 rounded-[14px] px-3.5 py-2.5"
    >
      <div class="flex flex-wrap items-center gap-3.5 text-xs text-fg-dim" style="font-variant-numeric: tabular-nums">
        <span class="flex items-center gap-1 text-rose-300">
          <span class="font-mono font-bold">−</span><span>{{ summaryRemoved }}</span> removed
        </span>
        <span class="flex items-center gap-1 text-emerald-300">
          <span class="font-mono font-bold">+</span><span>{{ summaryAdded }}</span> added
        </span>
        <span class="flex items-center gap-1 text-fg">
          <span>{{ summaryChanged }}</span> changed pages
        </span>
      </div>
      <div class="flex gap-1.5">
        <UiButton variant="ghost" size="sm" title="Previous difference" @click="jumpDiff(-1)">
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
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Prev diff
        </UiButton>
        <UiButton variant="ghost" size="sm" title="Next difference" @click="jumpDiff(1)">
          Next diff
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
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </UiButton>
      </div>
    </div>

    <div ref="bodyEl" class="compare-body min-h-0 flex-1">
      <div ref="leftPaneEl" class="compare-pane glass empty">
        <div class="compare-pane-header">
          <span class="dot left" />
          <span class="compare-pane-name">{{ pdf.compare.left ? pdf.compare.left.name : 'Original' }}</span>
          <span
            v-show="leftStatus"
            class="badge"
            :class="leftStatus ?? ''"
          >{{ leftStatus ?? '—' }}</span>
        </div>
        <div
          ref="leftWrapEl"
          class="compare-canvas-wrap"
          @click="onPaneClick('left')"
          @dragenter="onPaneDragEnter($event, 'left')"
          @dragover="onPaneDragOver($event, 'left')"
          @dragleave="onPaneDragLeave('left')"
          @drop="onPaneDrop($event, 'left')"
        >
          <div ref="leftStageEl" class="compare-stage">
            <canvas ref="leftCanvasEl" />
            <div ref="leftOverlayEl" class="compare-overlay" />
            <div ref="leftEmptyEl" class="compare-empty-page" style="display: none">No page</div>
          </div>
          <div class="compare-dropzone">
            <svg
              viewBox="0 0 24 24"
              width="56"
              height="56"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <p class="dz-title">Drop the <strong>original</strong> PDF here</p>
            <p class="dz-hint">or click to browse</p>
          </div>
        </div>
      </div>

      <div ref="rightPaneEl" class="compare-pane glass empty">
        <div class="compare-pane-header">
          <span class="dot right" />
          <span class="compare-pane-name">{{ pdf.compare.right ? pdf.compare.right.name : 'Revised' }}</span>
          <span
            v-show="rightStatus"
            class="badge"
            :class="rightStatus ?? ''"
          >{{ rightStatus ?? '—' }}</span>
        </div>
        <div
          ref="rightWrapEl"
          class="compare-canvas-wrap"
          @click="onPaneClick('right')"
          @dragenter="onPaneDragEnter($event, 'right')"
          @dragover="onPaneDragOver($event, 'right')"
          @dragleave="onPaneDragLeave('right')"
          @drop="onPaneDrop($event, 'right')"
        >
          <div ref="rightStageEl" class="compare-stage">
            <canvas ref="rightCanvasEl" />
            <div ref="rightOverlayEl" class="compare-overlay" />
            <div ref="rightEmptyEl" class="compare-empty-page" style="display: none">No page</div>
          </div>
          <div class="compare-dropzone">
            <svg
              viewBox="0 0 24 24"
              width="56"
              height="56"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <p class="dz-title">Drop the <strong>revised</strong> PDF here</p>
            <p class="dz-hint">or click to browse</p>
          </div>
        </div>
      </div>

      <svg ref="connectorsEl" class="compare-connectors" preserveAspectRatio="none" />
    </div>

    <div
      v-if="showNav"
      class="glass flex items-center justify-center gap-2.5 rounded-[14px] px-3.5 py-2"
    >
      <UiButton variant="default" size="icon" title="Previous page" @click="gotoComparePage(pdf.compare.currentPage - 1)">
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
      <span class="min-w-[64px] text-center text-[13px] text-fg-dim" style="font-variant-numeric: tabular-nums">
        {{ pdf.compare.currentPage + 1 }} / {{ totalPages }}
      </span>
      <UiButton variant="default" size="icon" title="Next page" @click="gotoComparePage(pdf.compare.currentPage + 1)">
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
      <UiButton variant="default" size="icon" title="Zoom out" @click="stepZoom(-1)">−</UiButton>
      <span class="min-w-[42px] text-center text-xs text-fg-dim" style="font-variant-numeric: tabular-nums">{{ zoomLabel }}</span>
      <UiButton variant="default" size="icon" title="Zoom in" @click="stepZoom(1)">+</UiButton>
      <UiButton
        variant="default"
        size="icon"
        title="Fit to page"
        @click="
          () => {
            pdf.compare.fitMode = true
            renderComparePage()
          }
        "
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
  </section>
</template>

<style scoped>
.compare-body {
  display: grid;
  grid-template-columns: 1fr 1fr;
  /* Wider gutter so Bezier connectors have room to communicate Y movement clearly. */
  gap: 28px;
  position: relative;
}
@media (max-width: 900px) {
  .compare-body {
    grid-template-columns: 1fr;
  }
}
.compare-pane {
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
  min-width: 0;
}
.compare-pane-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  font-size: 12px;
  font-weight: 600;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  color: var(--color-fg-dim);
}
.compare-pane-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-fg);
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}
.dot.left {
  background: #ef4444;
  box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.18);
}
.dot.right {
  background: #22c55e;
  box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.18);
}
.badge {
  padding: 2px 8px;
  border-radius: 12px;
  background: var(--color-glass-strong);
  border: 1px solid var(--color-glass-border);
  font-size: 11px;
  font-weight: 500;
  color: var(--color-fg);
}
.badge.added {
  color: #86efac;
  border-color: rgba(34, 197, 94, 0.4);
}
.badge.removed {
  color: #fca5a5;
  border-color: rgba(239, 68, 68, 0.4);
}
.badge.changed {
  color: #fde68a;
  border-color: rgba(250, 204, 21, 0.4);
}
.badge.same {
  color: var(--color-fg-mute);
}

.compare-canvas-wrap {
  flex: 1 1 0;
  min-height: 0;
  overflow: auto;
  background: rgba(0, 0, 0, 0.25);
  display: flex;
  align-items: safe flex-start;
  justify-content: safe center;
  padding: 16px;
  position: relative;
  transition: background 0.15s var(--ease-out-soft);
}
.compare-pane.empty .compare-stage {
  display: none;
}
.compare-pane.empty .compare-canvas-wrap {
  cursor: pointer;
  align-items: center;
  justify-content: center;
}
.compare-pane.empty .compare-canvas-wrap:hover .compare-dropzone {
  border-color: var(--color-glass-border-strong);
  color: var(--color-fg);
  background: rgba(255, 255, 255, 0.04);
}
.compare-pane.empty .compare-canvas-wrap.dragover {
  background: rgba(167, 139, 250, 0.06);
}
.compare-pane.empty .compare-canvas-wrap.dragover .compare-dropzone {
  border-color: var(--color-accent);
  color: var(--color-fg);
  background: rgba(167, 139, 250, 0.1);
  transform: scale(1.01);
}
.compare-pane:not(.empty) .compare-dropzone {
  display: none;
}
.compare-dropzone {
  position: absolute;
  inset: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 2px dashed var(--color-glass-border);
  border-radius: 14px;
  color: var(--color-fg-mute);
  text-align: center;
  pointer-events: none;
  transition: border-color 0.18s var(--ease-out-soft), background 0.18s var(--ease-out-soft),
    color 0.18s var(--ease-out-soft), transform 0.18s var(--ease-out-soft);
}
.compare-dropzone svg {
  opacity: 0.7;
}
.compare-dropzone .dz-title {
  font-size: 14px;
  font-weight: 500;
}
.compare-dropzone .dz-title strong {
  color: var(--color-fg);
  font-weight: 600;
}
.compare-dropzone .dz-hint {
  font-size: 12px;
  color: var(--color-fg-mute);
}

.compare-stage {
  position: relative;
  flex-shrink: 0;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  border-radius: 4px;
  overflow: hidden;
}
.compare-stage canvas {
  display: block;
  background: #fff;
}

.compare-empty-page {
  position: absolute;
  inset: 0;
  align-items: center;
  justify-content: center;
  background: repeating-linear-gradient(
    45deg,
    rgba(255, 255, 255, 0.02),
    rgba(255, 255, 255, 0.02) 10px,
    rgba(255, 255, 255, 0.04) 10px,
    rgba(255, 255, 255, 0.04) 20px
  );
  color: var(--color-fg-mute);
  font-size: 13px;
  font-style: italic;
  border: 1px dashed var(--color-glass-border);
  border-radius: 4px;
  z-index: 3;
}
.compare-stage.empty .compare-empty-page {
  display: flex !important;
}
.compare-stage.empty canvas {
  visibility: hidden;
}
.compare-stage.empty.removed-side {
  background: rgba(239, 68, 68, 0.1);
}
.compare-stage.empty.added-side {
  background: rgba(34, 197, 94, 0.1);
}

.compare-connectors {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 5;
  /* hidden so any extreme path geometry never bleeds into adjacent UI (page nav,
   * summary, scrollbars). The drawConnectors fn already clamps Y to pane viewports,
   * so this is belt-and-braces. */
  overflow: hidden;
}
</style>

<style>
.compare-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 2;
}
.compare-overlay .diff-box {
  position: absolute;
  border-radius: 2px;
  animation: diff-pulse 0.6s var(--ease-out-soft);
  mix-blend-mode: multiply;
}
.compare-overlay .diff-box.removed {
  background: rgba(239, 68, 68, 0.45);
  outline: 1px solid rgba(220, 38, 38, 0.9);
}
.compare-overlay .diff-box.added {
  background: rgba(34, 197, 94, 0.45);
  outline: 1px solid rgba(22, 163, 74, 0.9);
}
.compare-overlay .diff-box.changed {
  background: rgba(250, 204, 21, 0.4);
  outline: 1px solid rgba(202, 138, 4, 0.85);
}
@keyframes diff-pulse {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.compare-connectors path {
  fill: none;
  stroke-width: 1.25;
  stroke-linecap: round;
  opacity: 0.85;
}
.compare-connectors path.changed {
  stroke: rgba(250, 204, 21, 0.85);
}
.compare-connectors path.removed {
  stroke: rgba(239, 68, 68, 0.7);
  stroke-dasharray: 3 3;
}
.compare-connectors path.added {
  stroke: rgba(34, 197, 94, 0.7);
  stroke-dasharray: 3 3;
}
</style>
