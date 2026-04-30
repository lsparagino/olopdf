<script setup lang="ts">
import { openExternal } from '@/utils/electron'
import { PDF_CONFIG } from '@/stores/pdf'
// Vite injects __APP_VERSION__ at build time (see vite.config.ts).
declare const __APP_VERSION__: string
const version = `v${__APP_VERSION__}`

function go(e: MouseEvent) {
  e.preventDefault()
  openExternal(PDF_CONFIG.CURATOR_URL)
}
</script>

<template>
  <a
    href="#"
    class="curator self-center"
    :title="`curated by Olopad — ${PDF_CONFIG.CURATOR_URL.replace(/^https?:\/\//, '')}`"
    @click="go"
  >
    <span
      class="grid place-items-center"
      style="filter: drop-shadow(0 2px 8px rgba(0, 255, 204, 0.45))"
    >
      <svg viewBox="0 0 73 46" width="34" height="22" aria-hidden="true">
        <path
          fill="#00FFCC"
          d="M36.674,22.826c0,10.12 -8.216,18.337 -18.337,18.337c-10.12,0 -18.337,-8.216 -18.337,-18.337c0,-10.12 8.216,-18.337 18.337,-18.337c5.172,0 9.846,2.146 13.181,5.595c-1.383,1.852 -2.472,3.936 -3.198,6.182c-2.137,-3.244 -5.812,-5.386 -9.983,-5.386c-6.593,0 -11.946,5.353 -11.946,11.946c0,6.593 5.353,11.946 11.946,11.946c6.593,0 11.946,-5.353 11.946,-11.946c0,-10.12 8.216,-18.337 18.337,-18.337c10.12,0 18.337,8.216 18.337,18.337c0,10.12 -8.216,18.337 -18.337,18.337c-5.172,-0 -9.846,-2.146 -13.181,-5.595c1.383,-1.852 2.472,-3.936 3.198,-6.182c2.137,3.244 5.812,5.386 9.983,5.386c6.593,0 11.946,-5.353 11.946,-11.946c0,-6.593 -5.353,-11.946 -11.946,-11.946c-6.593,0 -11.946,5.353 -11.946,11.946Zm-6.391,-17.668l0,-5.158l6.391,0l0,5.245c-1.127,0.776 -2.175,1.657 -3.131,2.629c-0.992,-1.009 -2.084,-1.92 -3.26,-2.717Zm6.391,35.249l-0,5.245l-6.391,0l0,-5.158c1.175,-0.797 2.267,-1.708 3.26,-2.717c0.956,0.972 2.004,1.853 3.131,2.629Z"
        />
      </svg>
    </span>
    <span class="flex flex-col leading-[1.1]">
      <span class="text-[9px] uppercase tracking-[0.7px] text-fg-mute">curated by</span>
      <span class="text-sm font-semibold tracking-[-0.3px] text-white">olopad</span>
    </span>
    <span
      class="border-l border-glass-border pl-3 text-[11px] text-fg-mute"
      style="font-variant-numeric: tabular-nums"
    >
      {{ version }}
    </span>
  </a>
</template>

<style scoped>
.curator {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 6px 14px 6px 6px;
  border-radius: 100px;
  background: var(--color-glass);
  border: 1px solid var(--color-glass-border);
  text-decoration: none;
  color: var(--color-fg-dim);
  cursor: pointer;
  transition: transform 0.18s var(--ease-out-soft), background 0.18s var(--ease-out-soft),
    border-color 0.18s var(--ease-out-soft), box-shadow 0.18s var(--ease-out-soft);
  margin-top: 4px;
  animation: card-in 0.5s var(--ease-out-soft) 0.1s both;
}
.curator:hover {
  background: var(--color-glass-strong);
  border-color: var(--color-glass-border-strong);
  transform: translateY(-1px);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.3);
}
</style>
