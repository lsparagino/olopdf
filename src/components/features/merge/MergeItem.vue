<script setup lang="ts">
import type { MergeFileStatus } from '@/stores/pdf'
import { formatBytes } from '@/utils/pdf'

interface Props {
  name: string
  byteLength: number
  status: MergeFileStatus
  pageCount?: number
  unlocked?: boolean
  repaired?: boolean
  error?: string
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
    :class="{ '!border-rose-500/50 !bg-rose-500/10': status === 'error' }"
    :draggable="status !== 'error'"
    @dragstart="emit('dragstart', $event)"
    @dragend="emit('dragend', $event)"
    @dragover="emit('dragover', $event)"
    @dragleave="emit('dragleave', $event)"
    @drop="emit('drop', $event)"
  >
    <span class="grip text-fg-mute" :style="{ cursor: status === 'error' ? 'default' : 'grab' }">⋮⋮</span>
    <div class="flex min-w-0 flex-1 flex-col gap-1">
      <span class="name truncate text-[13px]" :title="name">{{ name }}</span>
      <span v-if="status === 'checking'" class="flex items-center gap-1.5 text-[11px] text-fg-mute">
        <svg class="animate-spin" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3">
          <path d="M21 12a9 9 0 1 1-6.2-8.56" stroke-linecap="round" />
        </svg>
        Checking…
      </span>
      <span v-else-if="status === 'ready'" class="flex items-center gap-2 text-[11px] text-fg-mute">
        {{ pageCount }} {{ pageCount === 1 ? 'page' : 'pages' }}
        <span
          v-if="unlocked"
          class="inline-flex items-center gap-1 rounded-full border border-amber-500/40 px-1.5 py-px text-amber-200"
          title="This PDF had an owner password restricting editing or copying. The restriction is removed in the merged file."
        >
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 7.5-2" />
          </svg>
          Unlocked
        </span>
        <span
          v-if="repaired"
          class="inline-flex items-center gap-1 rounded-full border border-accent-3/40 px-1.5 py-px text-accent-3"
          title="This PDF's page structure was damaged. OloPDF rebuilt it so the file can be merged."
        >
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3" />
          </svg>
          Repaired
        </span>
      </span>
      <span v-else class="select-text break-words text-[12px] text-rose-300">
        Can't be merged: {{ error }}
      </span>
    </div>
    <span class="meta text-[11px] text-fg-mute">{{ formatBytes(byteLength) }}</span>
    <button
      type="button"
      class="remove grid h-[26px] w-[26px] shrink-0 place-items-center rounded-md text-base leading-none text-fg-dim transition-colors hover:!bg-[#e81123] hover:!text-white"
      aria-label="Remove"
      title="Remove"
      @click.stop="emit('remove')"
    >
      <span aria-hidden="true">×</span>
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
.merge-item[draggable='false'] {
  cursor: default;
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
