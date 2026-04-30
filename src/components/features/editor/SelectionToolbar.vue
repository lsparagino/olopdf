<script setup lang="ts">
// Floating toolbar that appears above a text selection in the canvas. Buttons: copy, bookmark.
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useEditorRefs } from '@/composables/useEditorRefs'
import { toast } from '@/composables/useToast'

const emit = defineEmits<{ bookmark: [] }>()

const visible = ref(false)
const top = ref(0)
const left = ref(0)
const lastText = ref('')
const tbEl = ref<HTMLDivElement | null>(null)

function getCanvasSelection(): { range: Range; text: string } | null {
  const refs = useEditorRefs()
  const layer = refs.textLayer.value
  if (!layer) return null
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  if (!layer.contains(range.startContainer)) return null
  const text = sel.toString().trim()
  if (!text) return null
  return { range, text }
}

function showAtSelection() {
  const s = getCanvasSelection()
  if (!s) {
    hide()
    return
  }
  const rect = s.range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) {
    hide()
    return
  }
  lastText.value = s.text
  visible.value = true
  // Measure after toggling visibility so offsetWidth/Height are accurate.
  requestAnimationFrame(() => {
    const tb = tbEl.value
    if (!tb) return
    const tw = tb.offsetWidth
    const th = tb.offsetHeight
    let l = rect.left + rect.width / 2
    let t = rect.top - th - 10
    if (t < 8) t = rect.bottom + 10
    const minLeft = 8 + tw / 2
    const maxLeft = window.innerWidth - 8 - tw / 2
    if (l < minLeft) l = minLeft
    if (l > maxLeft) l = maxLeft
    left.value = l
    top.value = t
  })
}

function hide() {
  visible.value = false
  lastText.value = ''
}

function onMouseUp() {
  setTimeout(showAtSelection, 0)
}

function onSelectionChange() {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) hide()
}

function onPageRendered() {
  hide()
}

async function copyText() {
  const text = lastText.value
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    toast('Copied')
  } catch {
    toast('Copy failed', 'error')
  }
  hide()
}

function bookmark() {
  emit('bookmark')
  hide()
}

onMounted(() => {
  document.addEventListener('mouseup', onMouseUp)
  document.addEventListener('selectionchange', onSelectionChange)
  window.addEventListener('pdf:page-rendered', onPageRendered)
  const refs = useEditorRefs()
  refs.canvasWrap.value?.addEventListener('scroll', hide)
})

onBeforeUnmount(() => {
  document.removeEventListener('mouseup', onMouseUp)
  document.removeEventListener('selectionchange', onSelectionChange)
  window.removeEventListener('pdf:page-rendered', onPageRendered)
  const refs = useEditorRefs()
  refs.canvasWrap.value?.removeEventListener('scroll', hide)
})
</script>

<template>
  <div
    v-show="visible"
    ref="tbEl"
    class="selection-toolbar"
    :style="{ top: `${top}px`, left: `${left}px` }"
    @mousedown.prevent
  >
    <button type="button" class="sel-btn" title="Copy" @click="copyText">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
    </button>
    <button type="button" class="sel-btn" title="Add bookmark" @click="bookmark">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.selection-toolbar {
  position: fixed;
  z-index: 50;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  background: rgba(20, 20, 32, 0.95);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid var(--color-glass-border);
  border-radius: 8px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.5);
  transform: translateX(-50%);
  pointer-events: auto;
  user-select: none;
  animation: sel-in 0.12s var(--ease-out-soft);
}
.sel-btn {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  background: transparent;
  color: var(--color-fg);
  cursor: pointer;
  transition: background 0.12s var(--ease-out-soft), color 0.12s var(--ease-out-soft);
}
.sel-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--color-accent);
}
.sel-btn svg {
  width: 16px;
  height: 16px;
}
@keyframes sel-in {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}
</style>
