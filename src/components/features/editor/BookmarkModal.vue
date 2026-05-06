<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import UiButton from '@/components/ui/UiButton.vue'
import { usePdfStore } from '@/stores/pdf'
import { toast } from '@/composables/useToast'

const open = defineModel<boolean>('open', { default: false })

const pdf = usePdfStore()
const title = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

const pageNumber = computed(() => pdf.currentPage + 1)
const isAnchored = computed(() => !!pdf.capturedSelection)

watch(open, (v) => {
  if (!v) return
  title.value = pdf.capturedSelection ? pdf.capturedSelection.text.slice(0, 80) : ''
  void nextTick(() => {
    setTimeout(() => inputEl.value?.focus(), 50)
  })
})

function close() {
  open.value = false
  pdf.capturedSelection = null
}

function add() {
  const t = title.value.trim()
  if (!t) {
    toast('Enter a title', 'error')
    return
  }
  const sel = pdf.capturedSelection
  pdf.addBookmark({
    title: t,
    pageOriginalIdx: pdf.pageOrder[pdf.currentPage],
    level: 0,
    ...(sel ? { x: sel.x, y: sel.y } : {}),
  })
  pdf.capturedSelection = null
  open.value = false
  toast('Bookmark added', 'success')
}

function onBackgroundClick(e: MouseEvent) {
  if (e.target === e.currentTarget) close()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    add()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}
</script>

<template>
  <Transition name="modal">
    <div
      v-if="open"
      class="fixed inset-0 z-[100] flex items-center justify-center bg-black/30"
      @click="onBackgroundClick"
    >
      <div
        class="modal-card flex w-[min(420px,90%)] flex-col gap-4 rounded-[18px] p-7"
        @click.stop
      >
        <h3 class="text-base font-semibold text-fg">Add Bookmark</h3>
        <input
          ref="inputEl"
          v-model="title"
          type="text"
          placeholder="Bookmark title"
          class="rounded-lg border border-glass-border bg-black/30 px-3 py-2.5 text-[13px] text-fg outline-none transition-colors focus:border-accent focus:shadow-[0_0_0_3px_rgba(167,139,250,0.18)]"
          @keydown="onKeydown"
        />
        <p class="text-xs text-fg-mute">
          <template v-if="isAnchored">
            Anchored to selected text on page <span>{{ pageNumber }}</span
            >.
          </template>
          <template v-else>
            Tip: select text on the page first to anchor the bookmark to it. Otherwise it will
            point to page <span>{{ pageNumber }}</span
            >.
          </template>
        </p>
        <div class="mt-1 flex justify-end gap-2.5">
          <UiButton variant="ghost" size="sm" @click="close">Cancel</UiButton>
          <UiButton variant="primary" size="sm" @click="add">Add</UiButton>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* Solid-dark surface — matches the SearchBar / SelectionToolbar / inline-text
 * toolbar pattern. The translucent glass utility had poor contrast over busy
 * page content. */
.modal-card {
  background: rgba(20, 20, 32, 0.96);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid var(--color-glass-border);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.6);
}

.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s var(--ease-out-soft);
}
.modal-enter-active .modal-card,
.modal-leave-active .modal-card {
  transition: transform 0.25s var(--ease-out-soft);
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .modal-card,
.modal-leave-to .modal-card {
  transform: scale(0.95) translateY(8px);
}
</style>
