<script setup lang="ts">
import { onMounted } from 'vue'
import { ipcSend } from '@/utils/electron'
import { useChromeZoomDefense } from '@/composables/useChromeZoomDefense'

useChromeZoomDefense()

onMounted(() => {
  // Layer 1 of the zoom defense: lock the renderer's base zoom factor.
  // Reason: Chromium leaks zoom through any single defense; main.js has the others.
  const { webFrame } = window.require('electron') as typeof import('electron')
  try {
    webFrame.setZoomFactor(1)
    webFrame.setVisualZoomLevelLimits(1, 1)
  } catch {}
})

function minimize() {
  ipcSend('win:min')
}
function toggleMax() {
  ipcSend('win:max')
}
function close() {
  ipcSend('win:close')
}
</script>

<template>
  <header
    class="relative z-50 flex h-9 items-center justify-between border-b border-white/[0.04] pl-3"
  >
    <div class="app-drag flex h-full flex-1 items-center gap-2.5 text-fg-dim">
      <div
        class="grid h-[22px] w-[22px] place-items-center rounded-md text-white shadow-[0_4px_12px_rgba(167,139,250,0.4)]"
        :style="{
          background: 'linear-gradient(135deg, var(--color-accent), var(--color-accent-2))',
        }"
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
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="9" y1="14" x2="15" y2="14" />
          <line x1="9" y1="18" x2="13" y2="18" />
        </svg>
      </div>
      <span class="text-xs font-medium tracking-[0.2px]">OloPDF</span>
    </div>

    <div class="no-drag flex">
      <button
        class="grid h-9 w-[46px] place-items-center text-fg-dim transition-colors hover:bg-white/10 hover:text-fg"
        title="Minimize"
        @click="minimize"
      >
        <svg viewBox="0 0 12 12" width="10" height="10">
          <line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </button>
      <button
        class="grid h-9 w-[46px] place-items-center text-fg-dim transition-colors hover:bg-white/10 hover:text-fg"
        title="Maximize"
        @click="toggleMax"
      >
        <svg viewBox="0 0 12 12" width="10" height="10">
          <rect
            x="2.5"
            y="2.5"
            width="7"
            height="7"
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
          />
        </svg>
      </button>
      <button
        class="grid h-9 w-[46px] place-items-center text-fg-dim transition-colors hover:bg-[#e81123] hover:text-white"
        title="Close"
        @click="close"
      >
        <svg viewBox="0 0 12 12" width="10" height="10">
          <line x1="3" y1="3" x2="9" y2="9" stroke="currentColor" stroke-width="1.2" />
          <line x1="9" y1="3" x2="3" y2="9" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </button>
    </div>
  </header>
</template>
