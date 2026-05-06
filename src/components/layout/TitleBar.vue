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
      <svg
        viewBox="0 0 1024 1024"
        width="22"
        height="22"
        aria-hidden="true"
        class="flex-shrink-0"
      >
        <g transform="translate(205, 302) scale(2.2007)">
          <g transform="matrix(1,0,0,1,-2260.506854,-504.891609)">
            <g transform="matrix(0.396442,0,0,0.396442,2059.243189,-133.417302)">
              <path
                d="M893.121,1850C893.121,1956.367 806.765,2042.723 700.398,2042.723C594.031,2042.723 507.675,1956.367 507.675,1850C507.675,1743.633 594.031,1657.277 700.398,1657.277C754.753,1657.277 803.883,1679.828 838.934,1716.077C824.402,1735.542 812.955,1757.442 805.321,1781.051C782.861,1746.961 744.238,1724.443 700.398,1724.443C631.101,1724.443 574.841,1780.703 574.841,1850C574.841,1919.297 631.101,1975.557 700.398,1975.557C769.695,1975.557 825.955,1919.297 825.955,1850C825.955,1743.633 912.311,1657.277 1018.678,1657.277C1125.045,1657.277 1211.401,1743.633 1211.401,1850C1211.401,1956.367 1125.045,2042.723 1018.678,2042.723C964.323,2042.723 915.193,2020.172 880.142,1983.923C894.675,1964.458 906.121,1942.558 913.755,1918.949C936.215,1953.039 974.838,1975.557 1018.678,1975.557C1087.975,1975.557 1144.235,1919.297 1144.235,1850C1144.235,1780.703 1087.975,1724.443 1018.678,1724.443C949.381,1724.443 893.121,1780.703 893.121,1850ZM825.955,1664.302L825.955,1610.095L893.121,1610.095L893.121,1665.224C881.281,1673.376 870.262,1682.636 860.213,1692.853C849.784,1682.248 838.309,1672.675 825.955,1664.302ZM893.121,2034.776L893.121,2089.905L825.955,2089.905L825.955,2035.698C838.309,2027.325 849.784,2017.752 860.213,2007.147C870.262,2017.364 881.281,2026.624 893.121,2034.776Z"
                fill="var(--color-accent)"
              />
            </g>
          </g>
        </g>
      </svg>
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
