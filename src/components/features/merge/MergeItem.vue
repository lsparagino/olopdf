<script setup lang="ts">
import { formatBytes } from '@/utils/pdf'

interface Props {
  idx: number
  name: string
  byteLength: number
}

defineProps<Props>()

const emit = defineEmits<{
  remove: []
  dragstart: [e: DragEvent]
  dragend: [e: DragEvent]
  dragover: [e: DragEvent]
  dragleave: [e: DragEvent]
  drop: [e: DragEvent]
}>()
</script>

<template>
  <div
    class="merge-item"
    draggable="true"
    @dragstart="emit('dragstart', $event)"
    @dragend="emit('dragend', $event)"
    @dragover="emit('dragover', $event)"
    @dragleave="emit('dragleave', $event)"
    @drop="emit('drop', $event)"
  >
    <span class="grip text-fg-mute" style="cursor: grab">⋮⋮</span>
    <span class="name flex-1 truncate text-[13px]">{{ name }}</span>
    <span class="meta text-[11px] text-fg-mute">{{ formatBytes(byteLength) }}</span>
    <button
      type="button"
      class="remove grid h-[26px] w-[26px] place-items-center rounded-md text-base leading-none text-fg-dim transition-colors hover:!bg-[#e81123] hover:!text-white"
      title="Remove"
      @click.stop="emit('remove')"
    >
      ×
    </button>
  </div>
</template>

<style scoped>
.merge-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: var(--color-glass-strong);
  border: 1px solid var(--color-glass-border);
  border-radius: 8px;
  cursor: grab;
  transition: transform 0.15s var(--ease-out-soft), border-color 0.15s var(--ease-out-soft),
    background 0.15s var(--ease-out-soft);
}
.merge-item:hover {
  border-color: var(--color-glass-border-strong);
  background: rgba(255, 255, 255, 0.1);
}
.merge-item.dragging {
  opacity: 0.4;
  cursor: grabbing;
}
.merge-item.drop-before {
  box-shadow: 0 -2px 0 0 var(--color-accent);
}
.merge-item.drop-after {
  box-shadow: 0 2px 0 0 var(--color-accent);
}
</style>
