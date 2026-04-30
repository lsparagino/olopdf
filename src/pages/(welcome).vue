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
          <svg viewBox="0 0 279 191" width="64" height="44" aria-hidden="true">
            <defs>
              <linearGradient id="logoGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#a78bfa" />
                <stop offset="100%" stop-color="#ec4899" />
              </linearGradient>
            </defs>
            <g transform="matrix(1,0,0,1,-2260.506854,-504.891609)">
              <g transform="matrix(0.396442,0,0,0.396442,2059.243189,-133.417302)">
                <path
                  fill="url(#logoGrad)"
                  d="M893.121,1850C893.121,1956.367 806.765,2042.723 700.398,2042.723C594.031,2042.723 507.675,1956.367 507.675,1850C507.675,1743.633 594.031,1657.277 700.398,1657.277C754.753,1657.277 803.883,1679.828 838.934,1716.077C824.402,1735.542 812.955,1757.442 805.321,1781.051C782.861,1746.961 744.238,1724.443 700.398,1724.443C631.101,1724.443 574.841,1780.703 574.841,1850C574.841,1919.297 631.101,1975.557 700.398,1975.557C769.695,1975.557 825.955,1919.297 825.955,1850C825.955,1743.633 912.311,1657.277 1018.678,1657.277C1125.045,1657.277 1211.401,1743.633 1211.401,1850C1211.401,1956.367 1125.045,2042.723 1018.678,2042.723C964.323,2042.723 915.193,2020.172 880.142,1983.923C894.675,1964.458 906.121,1942.558 913.755,1918.949C936.215,1953.039 974.838,1975.557 1018.678,1975.557C1087.975,1975.557 1144.235,1919.297 1144.235,1850C1144.235,1780.703 1087.975,1724.443 1018.678,1724.443C949.381,1724.443 893.121,1780.703 893.121,1850ZM825.955,1664.302L825.955,1610.095L893.121,1610.095L893.121,1665.224C881.281,1673.376 870.262,1682.636 860.213,1692.853C849.784,1682.248 838.309,1672.675 825.955,1664.302ZM893.121,2034.776L893.121,2089.905L825.955,2089.905L825.955,2035.698C838.309,2027.325 849.784,2017.752 860.213,2007.147C870.262,2017.364 881.281,2026.624 893.121,2034.776Z"
                />
              </g>
            </g>
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
