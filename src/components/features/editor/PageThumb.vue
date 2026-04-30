<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { paintThumb } from '@/composables/useThumbnails'
import { usePdfStore } from '@/stores/pdf'

interface Props {
  uiIdx: number
  origIdx: number
  active: boolean
  targetWidth: number
  variant: 'sidebar' | 'grid'
}

const props = defineProps<Props>()

const emit = defineEmits<{
  click: []
  dblclick: []
  delete: []
  dragstart: [e: DragEvent]
  dragend: [e: DragEvent]
  dragover: [e: DragEvent]
  dragleave: [e: DragEvent]
  drop: [e: DragEvent]
}>()

const canvasEl = ref<HTMLCanvasElement | null>(null)
const pdf = usePdfStore()
const rotation = computed(() => pdf.pageRotations[props.origIdx] ?? 0)

onMounted(() => {
  if (canvasEl.value) void paintThumb(canvasEl.value, props.origIdx, props.targetWidth)
})

watch(rotation, () => {
  if (canvasEl.value) void paintThumb(canvasEl.value, props.origIdx, props.targetWidth)
})

function onDelete(e: MouseEvent) {
  e.stopPropagation()
  emit('delete')
}
</script>

<template>
  <div
    :class="[
      variant === 'sidebar' ? 'page-thumb' : 'grid-item',
      { active },
    ]"
    :data-ui-idx="uiIdx"
    draggable="true"
    @click="emit('click')"
    @dblclick="emit('dblclick')"
    @dragstart="emit('dragstart', $event)"
    @dragend="emit('dragend', $event)"
    @dragover="emit('dragover', $event)"
    @dragleave="emit('dragleave', $event)"
    @drop="emit('drop', $event)"
  >
    <canvas ref="canvasEl" />
    <div :class="variant === 'sidebar' ? 'page-thumb-num' : 'grid-item-num'">
      {{ uiIdx + 1 }}
    </div>
    <button
      type="button"
      :class="variant === 'sidebar' ? 'page-thumb-del' : 'grid-item-del'"
      title="Delete page"
      @click="onDelete"
    >
      ×
    </button>
  </div>
</template>

<style scoped>
.page-thumb {
  position: relative;
  flex-shrink: 0;
  width: 100%;
  aspect-ratio: 1 / 1.414;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.25);
  border: 2px solid transparent;
  cursor: pointer;
  overflow: hidden;
  transition: transform 0.18s var(--ease-out-soft), border-color 0.18s var(--ease-out-soft),
    box-shadow 0.18s var(--ease-out-soft);
}
.page-thumb canvas {
  display: block;
  width: 100%;
  height: 100%;
}
.page-thumb:hover {
  border-color: var(--color-glass-border-strong);
  transform: translateY(-1px);
  box-shadow: 0 8px 18px rgba(0, 0, 0, 0.4);
}
.page-thumb.active {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px rgba(167, 139, 250, 0.18);
}
.page-thumb.dragging {
  opacity: 0.4;
}
.page-thumb.drop-before {
  box-shadow: -3px 0 0 0 var(--color-accent), 0 0 0 3px rgba(167, 139, 250, 0.18);
}
.page-thumb.drop-after {
  box-shadow: 3px 0 0 0 var(--color-accent), 0 0 0 3px rgba(167, 139, 250, 0.18);
}
.page-thumb-num {
  position: absolute;
  bottom: 6px;
  left: 6px;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  font-size: 10px;
  font-weight: 500;
  padding: 2px 6px;
  border-radius: 4px;
}
.page-thumb-del {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  border-radius: 50%;
  font-size: 14px;
  line-height: 1;
  opacity: 0;
  transform: scale(0.8);
  transition: opacity 0.15s var(--ease-out-soft), transform 0.15s var(--ease-out-soft),
    background 0.15s var(--ease-out-soft);
}
.page-thumb:hover .page-thumb-del {
  opacity: 1;
  transform: scale(1);
}
.page-thumb-del:hover {
  background: #e81123;
}

.grid-item {
  position: relative;
  background: rgba(0, 0, 0, 0.3);
  border: 2px solid transparent;
  border-radius: 12px;
  overflow: hidden;
  cursor: grab;
  transition: transform 0.18s var(--ease-out-soft), border-color 0.18s var(--ease-out-soft),
    box-shadow 0.18s var(--ease-out-soft);
}
.grid-item canvas {
  display: block;
  width: 100%;
  height: auto;
  background: #fff;
}
.grid-item:hover {
  border-color: var(--color-glass-border-strong);
  transform: translateY(-3px);
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.4);
}
.grid-item.active {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px rgba(167, 139, 250, 0.18);
}
.grid-item.dragging {
  opacity: 0.4;
  cursor: grabbing;
}
.grid-item.drop-before {
  box-shadow: -4px 0 0 0 var(--color-accent), 0 0 0 3px rgba(167, 139, 250, 0.18);
}
.grid-item.drop-after {
  box-shadow: 4px 0 0 0 var(--color-accent), 0 0 0 3px rgba(167, 139, 250, 0.18);
}
.grid-item-num {
  position: absolute;
  top: 8px;
  left: 8px;
  background: rgba(0, 0, 0, 0.8);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 6px;
}
.grid-item-del {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.75);
  color: #fff;
  border-radius: 50%;
  font-size: 14px;
  line-height: 1;
  opacity: 0;
  transform: scale(0.85);
  transition: opacity 0.15s var(--ease-out-soft), transform 0.15s var(--ease-out-soft),
    background 0.15s var(--ease-out-soft);
}
.grid-item:hover .grid-item-del {
  opacity: 1;
  transform: scale(1);
}
.grid-item-del:hover {
  background: #e81123;
}
</style>
