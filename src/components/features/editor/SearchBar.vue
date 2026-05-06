<script setup lang="ts">
// Floating find-in-document bar, opened with Ctrl+F. Positioned at the top
// right of the canvas viewport. Enter / Shift+Enter move to next / previous
// match; Esc closes the bar and clears highlights. Search runs through the
// useTextSearch composable, which builds a per-page text index lazily and
// toggles classes on the existing text-layer spans for highlighting.
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  closeSearch,
  nextMatch,
  prevMatch,
  runSearch,
  useTextSearch,
} from '@/composables/useTextSearch'

const search = useTextSearch()
const inputEl = ref<HTMLInputElement | null>(null)
const barEl = ref<HTMLDivElement | null>(null)
const localQuery = ref('')

watch(
  () => search.visible.value,
  async (v) => {
    if (v) {
      await nextTick()
      inputEl.value?.focus()
      inputEl.value?.select()
    } else {
      localQuery.value = ''
    }
  },
)

// Close the bar when the user presses anywhere outside it. The toolbar's Find
// toggle is opted out via [data-search-toggle] so its own click handler keeps
// the open/close behavior — otherwise this listener would fire first and the
// click would re-open it on the same gesture.
function onDocMouseDown(e: MouseEvent) {
  if (!search.visible.value) return
  const target = e.target as Element | null
  if (!target) return
  if (barEl.value?.contains(target)) return
  if (target.closest('[data-search-toggle]')) return
  closeSearch()
}

onMounted(() => {
  document.addEventListener('mousedown', onDocMouseDown)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMouseDown)
})

let debounceTimer: ReturnType<typeof setTimeout> | null = null
function onInput() {
  if (debounceTimer) clearTimeout(debounceTimer)
  const q = localQuery.value
  debounceTimer = setTimeout(() => {
    void runSearch(q)
  }, 160)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    if (e.shiftKey) void prevMatch()
    else void nextMatch()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}

function close() {
  closeSearch()
}
</script>

<template>
  <Transition name="search-bar">
    <div v-if="search.visible.value" ref="barEl" class="search-bar" @mousedown.stop>
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="text-fg-dim"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <line x1="20" y1="20" x2="16.65" y2="16.65" />
      </svg>
      <input
        ref="inputEl"
        v-model="localQuery"
        type="text"
        class="search-input"
        placeholder="Find in document"
        spellcheck="false"
        @input="onInput"
        @keydown="onKeydown"
      />
      <span class="count" :class="{ none: search.matchCount.value === 0 && localQuery }">
        <template v-if="!localQuery">&nbsp;</template>
        <template v-else-if="search.matchCount.value === 0">No results</template>
        <template v-else>
          {{ search.currentMatchIdx.value + 1 }} / {{ search.matchCount.value }}
        </template>
      </span>
      <button
        type="button"
        class="nav-btn"
        title="Previous (Shift+Enter)"
        :disabled="search.matchCount.value === 0"
        @click="prevMatch()"
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
        >
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </button>
      <button
        type="button"
        class="nav-btn"
        title="Next (Enter)"
        :disabled="search.matchCount.value === 0"
        @click="nextMatch()"
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
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <button type="button" class="close-btn" title="Close (Esc)" @click="close">
        ×
      </button>
    </div>
  </Transition>
</template>

<style scoped>
.search-bar {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 7;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 10px;
  min-width: 320px;
  /* Solid-dark background — the translucent glass utility produced poor
   * contrast against busy PDF pages, especially over white text content. */
  background: rgba(20, 20, 32, 0.92);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid var(--color-glass-border);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.5);
}

.search-bar-enter-active,
.search-bar-leave-active {
  transition: transform 0.18s var(--ease-out-soft), opacity 0.18s var(--ease-out-soft);
}
.search-bar-enter-from,
.search-bar-leave-to {
  transform: translateY(-8px);
  opacity: 0;
}

.search-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  padding: 4px 2px;
  font-size: 13px;
  color: var(--color-fg);
}
.search-input::placeholder {
  color: var(--color-fg-mute);
}

.count {
  font-size: 11px;
  color: var(--color-fg-dim);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  min-width: 36px;
  text-align: right;
}
.count.none {
  color: #f87171;
}

.nav-btn,
.close-btn {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  color: var(--color-fg-dim);
  transition: background 0.12s var(--ease-out-soft), color 0.12s var(--ease-out-soft);
  flex-shrink: 0;
}
.nav-btn:not(:disabled):hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--color-fg);
}
.nav-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.close-btn {
  font-size: 16px;
  line-height: 1;
}
.close-btn:hover {
  background: #e81123;
  color: #fff;
}
</style>
