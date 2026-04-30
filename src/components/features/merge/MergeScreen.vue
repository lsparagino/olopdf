<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import UiButton from '@/components/ui/UiButton.vue'
import MergeItem from '@/components/features/merge/MergeItem.vue'
import { usePdfStore } from '@/stores/pdf'
import {
  appendFilesFromDrop,
  moveMergeItem,
  performMerge,
  pickAndAppendFiles,
} from '@/composables/useMerge'

const router = useRouter()
const pdf = usePdfStore()
const dragover = ref(false)
let dragSrc: number | null = null

async function onDrop(e: DragEvent) {
  e.preventDefault()
  dragover.value = false
  // Disambiguate: drag from the OS (files) vs internal item reorder.
  if (!e.dataTransfer) return
  const types = Array.from(e.dataTransfer.types)
  if (!types.includes('Files')) return
  if (e.dataTransfer.files) {
    await appendFilesFromDrop(e.dataTransfer.files)
  }
}

function onDragEnter(e: DragEvent) {
  e.preventDefault()
  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
    dragover.value = true
  }
}

function onDragOver(e: DragEvent) {
  e.preventDefault()
  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
    dragover.value = true
  }
}

function onDragLeave() {
  dragover.value = false
}

function onItemDragStart(e: DragEvent, idx: number) {
  dragSrc = idx
  ;(e.currentTarget as HTMLElement).classList.add('dragging')
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    try {
      e.dataTransfer.setData('text/plain', String(idx))
    } catch {
      /* ignore */
    }
  }
}
function onItemDragEnd(e: DragEvent) {
  ;(e.currentTarget as HTMLElement).classList.remove('dragging')
  document
    .querySelectorAll('.drop-before, .drop-after')
    .forEach((r) => r.classList.remove('drop-before', 'drop-after'))
  dragSrc = null
}
function onItemDragOver(e: DragEvent) {
  if (dragSrc === null) return
  e.preventDefault()
  e.stopPropagation()
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  const before = e.clientY - r.top < r.height / 2
  el.classList.toggle('drop-before', before)
  el.classList.toggle('drop-after', !before)
}
function onItemDragLeave(e: DragEvent) {
  ;(e.currentTarget as HTMLElement).classList.remove('drop-before', 'drop-after')
}
function onItemDrop(e: DragEvent, idx: number) {
  if (dragSrc === null) return
  e.preventDefault()
  e.stopPropagation()
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  const before = e.clientY - r.top < r.height / 2
  const dest = before ? idx : idx + 1
  el.classList.remove('drop-before', 'drop-after')
  if (dragSrc === idx) return
  moveMergeItem(dragSrc, dest)
}

function removeAt(i: number) {
  pdf.mergeFiles.splice(i, 1)
}
</script>

<template>
  <section class="merge flex h-full flex-col gap-4 p-6">
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
        Merge PDFs
      </h2>
      <UiButton variant="primary" :disabled="pdf.mergeFiles.length < 2" @click="performMerge">
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
        </svg>
        Merge & Save
      </UiButton>
    </header>

    <div
      class="merge-body glass relative flex flex-1 flex-col gap-3 overflow-hidden rounded-[14px] p-5 transition-colors"
      :class="{ dragover }"
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <div class="flex flex-1 flex-col gap-2 overflow-y-auto">
        <MergeItem
          v-for="(f, i) in pdf.mergeFiles"
          :key="`${f.name}-${i}`"
          :idx="i"
          :name="f.name"
          :byte-length="f.bytes.byteLength"
          @remove="removeAt(i)"
          @dragstart="onItemDragStart($event, i)"
          @dragend="onItemDragEnd"
          @dragover="onItemDragOver"
          @dragleave="onItemDragLeave"
          @drop="onItemDrop($event, i)"
        />
      </div>

      <div
        v-if="pdf.mergeFiles.length === 0"
        class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-fg-dim"
      >
        <svg
          viewBox="0 0 24 24"
          width="44"
          height="44"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          opacity="0.5"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <p class="text-sm">Drop PDF files here</p>
        <p class="text-xs text-fg-mute">Drag to reorder. Click × to remove.</p>
      </div>

      <UiButton class="self-start" @click="pickAndAppendFiles">
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
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        Add PDF
      </UiButton>
    </div>
  </section>
</template>

<style scoped>
.merge-body.dragover {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px rgba(167, 139, 250, 0.2);
}
</style>
