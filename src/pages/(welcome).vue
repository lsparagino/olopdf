<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import UiButton from '@/components/ui/UiButton.vue'
import WelcomeRecents from '@/components/features/welcome/WelcomeRecents.vue'
import CuratorPill from '@/components/features/welcome/CuratorPill.vue'
import { pickAndOpenPdf, openPdfFromPath } from '@/composables/useOpenPdf'
import { usePdfStore } from '@/stores/pdf'
import { readFileAsArrayBuffer } from '@/utils/electron'

defineOptions({ name: 'WelcomePage' })

const router = useRouter()
const pdf = usePdfStore()
const dragover = ref(false)

interface FileWithPath extends File {
  path: string
}

async function onDrop(e: DragEvent) {
  e.preventDefault()
  dragover.value = false
  if (!e.dataTransfer) return
  const files = Array.from(e.dataTransfer.files).filter((f) =>
    f.name.toLowerCase().endsWith('.pdf'),
  ) as FileWithPath[]
  if (files.length === 0) return
  if (files.length === 1) {
    await openPdfFromPath(files[0].path)
    return
  }
  pdf.mergeFiles = []
  for (const f of files) {
    pdf.mergeFiles.push({ name: f.name, bytes: await readFileAsArrayBuffer(f.path) })
  }
  await router.push({ name: 'merge' })
}

function onMerge() {
  pdf.mergeFiles = []
  void router.push({ name: 'merge' })
}

function onCompare() {
  void router.push({ name: 'compare' })
}
</script>

<route lang="json">
{ "name": "welcome" }
</route>

<template>
  <section class="flex h-full items-center justify-center overflow-y-auto p-10">
    <div class="flex w-[min(560px,100%)] flex-col gap-4">
      <div
        class="glass relative w-[min(560px,100%)] rounded-3xl px-12 py-14 text-center transition-[transform,border-color,box-shadow] duration-300"
        :class="{
          'scale-[1.01] border-accent': dragover,
          'shadow-[0_0_0_4px_rgba(167,139,250,0.15),0_8px_32px_rgba(0,0,0,0.35)]': dragover,
        }"
        :style="{ animation: 'card-in 0.6s var(--ease-out-soft)' }"
        @dragenter.prevent="dragover = true"
        @dragover.prevent="dragover = true"
        @dragleave.prevent="dragover = false"
        @drop="onDrop"
      >
        <div
          class="mx-auto mb-5 grid h-24 w-24 place-items-center rounded-3xl border border-glass-border"
          :style="{
            background:
              'linear-gradient(135deg, rgba(167,139,250,0.15), rgba(236,72,153,0.15))',
            animation: 'pulse-ring 3s ease-in-out infinite',
          }"
        >
          <svg
            viewBox="0 0 24 24"
            width="64"
            height="64"
            fill="none"
            stroke="url(#welcomeGrad)"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <defs>
              <linearGradient id="welcomeGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#a78bfa" />
                <stop offset="100%" stop-color="#ec4899" />
              </linearGradient>
            </defs>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </div>
        <h1
          class="mb-1.5 text-[32px] font-semibold tracking-[-0.5px] text-transparent"
          :style="{
            background: 'linear-gradient(135deg, #fff, #c4b5fd)',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
          }"
        >
          OloPDF
        </h1>
        <p class="mb-6 text-fg-dim">Modern, portable, beautiful</p>
        <p class="mb-7 text-[13px] text-fg-mute">Drop a PDF anywhere or pick an action below</p>

        <div class="flex flex-wrap justify-center gap-3">
          <UiButton variant="primary" @click="pickAndOpenPdf">
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
              <path
                d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
              />
            </svg>
            Open PDF
          </UiButton>
          <UiButton @click="onMerge">
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
              <path d="M8 3v3a2 2 0 0 1-2 2H3" />
              <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
              <path d="M3 16h3a2 2 0 0 1 2 2v3" />
              <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
            </svg>
            Merge PDFs
          </UiButton>
          <UiButton @click="onCompare">
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
            Compare PDFs
          </UiButton>
        </div>
      </div>

      <WelcomeRecents />
      <CuratorPill />
    </div>
  </section>
</template>
