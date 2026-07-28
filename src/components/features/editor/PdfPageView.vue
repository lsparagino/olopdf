<script setup lang="ts">
// One page of the continuous flow: the canvas pdf.js paints into, the selectable
// text layer, and the placed-annotation overlay.
//
// The box is sized from props on every scale change so the flow reflows at once;
// the repaint is debounced behind it, which keeps a wheel-zoom smooth (the old
// bitmap stretches, briefly soft, instead of flickering). All three layers are
// filled imperatively — see usePdfRenderer / useTextOverlay — so the template
// only owns the containers.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ensureMeasured } from '@/composables/usePageMetrics'
import { pageElsFromStage } from '@/composables/usePageElements'
import { releasePage, renderPage, sizePageEls } from '@/composables/usePdfRenderer'
import { commitEditorForPage, drawTextOverlays } from '@/composables/useTextOverlay'

const props = defineProps<{
  uiIdx: number
  origIdx: number
  rotation: number
  baseWidth: number
  baseHeight: number
  scale: number
  shouldRender: boolean
}>()

const ZOOM_REPAINT_DEBOUNCE_MS = 140

const stageEl = ref<HTMLDivElement | null>(null)
let repaintTimer: ReturnType<typeof setTimeout> | null = null
let lastScale = 0

function applySize(): void {
  const els = pageElsFromStage(stageEl.value)
  if (!els) return
  // Rounded to whole pixels with the same rule useViewerScroll.rowGeoms uses for
  // the row box — a half-pixel disagreement between them clips the page or opens
  // a hairline gap on every row.
  sizePageEls(
    els,
    Math.round(props.baseWidth * props.scale),
    Math.round(props.baseHeight * props.scale),
  )
}

async function repaint(): Promise<void> {
  const els = pageElsFromStage(stageEl.value)
  if (!els) return
  if (!props.shouldRender) {
    releasePage(els)
    return
  }
  await renderPage(els, {
    origIdx: props.origIdx,
    rotation: props.rotation,
    scale: props.scale,
  })
  // The spans carry positions baked in at the rendered scale; they were hidden
  // when the zoom changed and become trustworthy again only now.
  els.textLayer.style.visibility = ''
  drawTextOverlays(props.uiIdx)
}

function sync(): void {
  ensureMeasured(props.origIdx, props.rotation)
  applySize()
  const scaleChanged = props.scale !== lastScale
  lastScale = props.scale
  if (repaintTimer) {
    clearTimeout(repaintTimer)
    repaintTimer = null
  }
  if (!scaleChanged) {
    void repaint()
    return
  }
  const els = pageElsFromStage(stageEl.value)
  if (els && els.textLayer.childElementCount > 0) els.textLayer.style.visibility = 'hidden'
  repaintTimer = setTimeout(() => {
    repaintTimer = null
    void repaint()
  }, ZOOM_REPAINT_DEBOUNCE_MS)
}

watch(
  () => [
    props.shouldRender,
    props.origIdx,
    props.rotation,
    props.scale,
    props.baseWidth,
    props.baseHeight,
  ],
  sync,
)

onMounted(sync)

onBeforeUnmount(() => {
  if (repaintTimer) clearTimeout(repaintTimer)
  // Save the user's typing before the DOM the editor lives in goes away.
  commitEditorForPage(props.uiIdx)
  const els = pageElsFromStage(stageEl.value)
  if (els) releasePage(els)
})
</script>

<template>
  <div
    ref="stageEl"
    class="canvas-stage"
    :data-ui-idx="uiIdx"
    :data-orig-idx="origIdx"
  >
    <canvas />
    <div class="text-layer" :data-ui-idx="uiIdx" :data-orig-idx="origIdx" />
    <div class="text-overlay" :data-ui-idx="uiIdx" :data-orig-idx="origIdx" />
  </div>
</template>

<style scoped>
/* Pixel-precise page box — the one area CLAUDE.md exempts from Tailwind. The
 * white background stands in for the bitmap while a page is outside the render
 * window and its canvas backing store has been freed. */
.canvas-stage {
  position: relative;
  flex-shrink: 0;
  background: #fff;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  border-radius: 4px;
  overflow: hidden;
}
.canvas-stage canvas {
  display: block;
}
</style>
