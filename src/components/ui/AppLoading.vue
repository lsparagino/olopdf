<script setup lang="ts">
import { useLoading } from '@/composables/useLoading'

const { state } = useLoading()
</script>

<template>
  <Transition name="fade">
    <div
      v-if="state.visible"
      class="fixed inset-0 z-[99] grid place-items-center bg-black/60 backdrop-blur-sm"
    >
      <div class="flex flex-col items-center gap-4">
        <div class="spinner" aria-hidden="true" />
        <p class="text-sm text-fg-dim">{{ state.text }}</p>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.spinner {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 3px solid rgba(255, 255, 255, 0.12);
  border-top-color: var(--color-accent);
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s var(--ease-out-soft);
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
