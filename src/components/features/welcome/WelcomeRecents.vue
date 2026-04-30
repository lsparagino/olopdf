<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useRecents, refreshRecents, removeRecent } from '@/composables/useRecents'
import { basenameOf, dirnameOf, openPdfFromPath } from '@/composables/useOpenPdf'

const { recents } = useRecents()
const route = useRoute()

onMounted(refreshRecents)
// Re-render whenever the welcome route becomes active again, so deleted files vanish.
watch(
  () => route.name,
  (name) => {
    if (name === 'welcome') void refreshRecents()
  },
)

async function onRemove(e: MouseEvent, p: string) {
  e.stopPropagation()
  await removeRecent(p)
}
</script>

<template>
  <section
    v-if="recents.length > 0"
    class="glass rounded-[18px] px-4 py-3.5"
    :style="{ animation: 'card-in 0.5s var(--ease-out-soft) 0.05s both' }"
  >
    <header
      class="mb-2 flex items-center gap-2 border-b border-white/[0.06] px-1 pb-2.5 text-[11px] font-semibold uppercase tracking-[0.6px] text-fg-dim"
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
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
      <span>Recent</span>
    </header>
    <ul class="flex flex-col gap-1">
      <li v-for="p in recents" :key="p">
        <button
          class="group flex w-full items-center gap-3 rounded-[10px] border border-transparent bg-transparent px-3 py-2.5 text-left text-fg transition-[transform,background,border-color] duration-150 hover:translate-x-0.5 hover:border-glass-border hover:bg-glass-strong"
          :title="p"
          @click="openPdfFromPath(p)"
        >
          <span
            class="grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg text-white"
            :style="{
              background:
                'linear-gradient(135deg, rgba(167,139,250,0.25), rgba(236,72,153,0.25))',
            }"
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
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          </span>
          <span class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="truncate text-[13px] font-medium">{{ basenameOf(p) }}</span>
            <span
              class="truncate text-[11px] text-fg-mute"
              dir="rtl"
              style="text-align: left"
            >
              {{ dirnameOf(p) }}
            </span>
          </span>
          <span
            class="grid h-6 w-6 place-items-center rounded-md text-base leading-none text-fg-mute opacity-0 transition-[opacity,background,color] duration-150 group-hover:opacity-100 hover:!bg-[#e81123] hover:!text-white"
            title="Remove from recents"
            @click="(e) => onRemove(e as MouseEvent, p)"
          >
            ×
          </span>
        </button>
      </li>
    </ul>
  </section>
</template>
