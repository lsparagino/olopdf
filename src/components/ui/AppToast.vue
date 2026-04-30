<script setup lang="ts">
import { useToast } from '@/composables/useToast'

const { state } = useToast()
</script>

<template>
  <Transition name="toast">
    <div
      v-if="state.visible"
      class="glass pointer-events-none fixed bottom-6 left-1/2 z-[100] -translate-x-1/2 rounded-full px-5 py-3 text-sm shadow-lg"
      :class="{
        'border-rose-500/60 text-rose-200': state.kind === 'error',
        'border-emerald-500/60 text-emerald-200': state.kind === 'success',
        'border-amber-500/60 text-amber-200': state.kind === 'warn',
      }"
      role="status"
    >
      {{ state.message }}
    </div>
  </Transition>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s var(--ease-out-soft), transform 0.2s var(--ease-out-soft);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 12px);
}
</style>
