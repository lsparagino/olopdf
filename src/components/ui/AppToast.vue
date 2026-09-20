<script setup lang="ts">
import { dismissToast, useToast } from '@/composables/useToast'

const { toasts } = useToast()

// A leaving toast goes position:absolute so the rest can slide into its slot,
// but in this bottom-anchored flex column an absolute child snaps to the
// container's start. Pin it where it was, measured from the bottom edge.
function pinLeavingToast(el: Element): void {
  const toastEl = el as HTMLElement
  const stack = toastEl.parentElement
  if (!stack) return
  toastEl.style.bottom = `${stack.clientHeight - toastEl.offsetTop - toastEl.offsetHeight}px`
  toastEl.style.left = `${toastEl.offsetLeft}px`
  toastEl.style.width = `${toastEl.offsetWidth}px`
}
</script>

<template>
  <!-- bottom-20 keeps the stack clear of the editor's bottom toolbar. -->
  <TransitionGroup
    tag="div"
    name="toast"
    class="pointer-events-none fixed bottom-20 left-1/2 z-[100] flex w-[min(640px,calc(100%-48px))] -translate-x-1/2 flex-col items-center gap-2"
    @before-leave="pinLeavingToast"
  >
    <!-- Only sticky toasts take clicks (for their dismiss button and text
         selection); transient ones must not block what's underneath. -->
    <div
      v-for="t in toasts"
      :key="t.id"
      class="glass flex max-w-full items-start gap-3 rounded-2xl px-5 py-3 text-sm shadow-lg"
      :class="[
        t.sticky ? 'pointer-events-auto' : 'pointer-events-none',
        {
          'border-rose-500/60 text-rose-200': t.kind === 'error',
          'border-emerald-500/60 text-emerald-200': t.kind === 'success',
          'border-amber-500/60 text-amber-200': t.kind === 'warn',
        },
      ]"
      :role="t.kind === 'error' ? 'alert' : 'status'"
    >
      <span class="min-w-0 select-text whitespace-pre-line break-words">{{ t.message }}</span>
      <button
        v-if="t.sticky"
        type="button"
        class="-mr-2 grid h-6 w-6 shrink-0 place-items-center rounded text-base leading-none opacity-70 transition-opacity hover:opacity-100"
        aria-label="Dismiss"
        title="Dismiss"
        @click="dismissToast(t.id)"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  </TransitionGroup>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active,
.toast-move {
  transition: opacity 0.2s var(--ease-out-soft), transform 0.2s var(--ease-out-soft);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(12px);
}
.toast-leave-active {
  position: absolute;
}
</style>
