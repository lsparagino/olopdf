<script setup lang="ts">
// Compress screen — pick a PDF, choose a strategy + quality preset, run the
// compression engine, then save the result. State is screen-local (no Pinia
// slice) because nothing outside this screen needs to react to it.
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import UiButton from '@/components/ui/UiButton.vue'
import {
  COMPRESS_PRESETS,
  compressPdf,
  CompressCancelled,
  requestCancel,
  type CompressPreset,
  type CompressProgress,
  type CompressResult,
  type CompressStrategy,
} from '@/composables/useCompress'
import { toast } from '@/composables/useToast'
import {
  ipcInvoke,
  nodePath,
  readFileAsArrayBuffer,
  writeFileBytes,
} from '@/utils/electron'
import { formatBytes } from '@/utils/pdf'

interface OpenDialogResult {
  canceled: boolean
  filePaths: string[]
}
interface SaveDialogResult {
  canceled: boolean
  filePath?: string
}
interface FileWithPath extends File {
  path: string
}

const router = useRouter()

const sourceBytes = ref<ArrayBuffer | null>(null)
const sourceName = ref<string>('')
const sourcePath = ref<string>('')
const sourceSize = ref<number>(0)
const dragover = ref(false)

const strategy = ref<CompressStrategy>('auto')
const preset = ref<CompressPreset>('low')

const running = ref(false)
const progress = ref<CompressProgress | null>(null)
const result = ref<CompressResult | null>(null)

const STRATEGIES: Array<{
  key: CompressStrategy
  label: string
  blurb: string
}> = [
  {
    key: 'auto',
    label: 'Auto (recommended)',
    blurb:
      'Try text-preserving image recompression first; if savings are small (or CMYK images forced a skip), fall back to rasterize and keep whichever output is smaller.',
  },
  {
    key: 'image-only',
    label: 'Image-only recompression',
    blurb:
      'Re-encode embedded JPEG images at lower quality. Preserves text, vectors, and annotations. Best for scan-heavy PDFs.',
  },
  {
    key: 'rasterize',
    label: 'Re-rasterize pages',
    blurb:
      'Render each page as a JPEG. Biggest, most predictable savings. Removes selectable text and flattens vectors.',
  },
]

const PRESET_LIST: Array<{ key: CompressPreset; label: string; hint: string }> = [
  { key: 'low', label: 'Low', hint: `${COMPRESS_PRESETS.low.dpi} DPI · screen` },
  { key: 'medium', label: 'Medium', hint: `${COMPRESS_PRESETS.medium.dpi} DPI · ebook` },
  { key: 'high', label: 'High', hint: `${COMPRESS_PRESETS.high.dpi} DPI · print` },
]

const noopMessage = computed(() => {
  const r = result.value
  if (!r?.noopReason) return ''
  // CMYK-heavy PDFs noop on the image-only path because we don't have a
  // color-managed pipeline to convert them safely. Rasterize is the right
  // tool — pdf.js renders the page through its own color management.
  if ((r.imagesSkippedCmyk ?? 0) > 0 && strategy.value === 'image-only') {
    return `This PDF's images are stored as DeviceCMYK (${r.imagesSkippedCmyk} skipped). Recompressing them without the original color profile would shift colors, so image-only left them alone. Try the rasterize strategy — pdf.js renders the page through its own color pipeline, or use Auto to do this automatically.`
  }
  if (r.noopReason === 'output-larger') {
    if (strategy.value === 'rasterize') {
      return 'Rasterizing this PDF produced a larger file than the original — likely a text-heavy document. Returned the original bytes. Try the image-only strategy instead.'
    }
    if (strategy.value === 'auto') {
      return 'Tried both strategies — neither produced a smaller file than the original. Returned the original bytes; this PDF is already efficient at the chosen quality preset.'
    }
    return 'Recompression produced a larger file than the original. Returned the original bytes.'
  }
  return 'No eligible images to recompress in this PDF. Returned the original bytes. Try the rasterize strategy on scan-heavy PDFs.'
})

// Narrate what Auto actually did, so the result panel isn't a black box when
// the user picked Auto. Only relevant for successful Auto runs (noop is
// handled by noopMessage above).
function autoRasterizeReason(r: CompressResult): string {
  if (!r.autoTriedRasterize) return ''
  const cmyk = r.imagesSkippedCmyk ?? 0
  if (cmyk > 0) {
    const noun = cmyk === 1 ? 'image' : 'images'
    return `image-only skipped ${cmyk} CMYK ${noun} and savings stayed below 5%`
  }
  return 'image-only savings stayed below 5%'
}

const autoChoiceLabel = computed(() => {
  const r = result.value
  if (!r || strategy.value !== 'auto' || r.noopReason) return ''
  if (r.autoChose === 'rasterize') {
    const reason = autoRasterizeReason(r)
    const suffix = reason ? ` — ${reason}` : ''
    return `Auto chose Rasterize${suffix}. Text selection is not preserved in the output.`
  }
  return 'Auto chose Image-only — text selection is preserved.'
})

const hasSource = computed(() => !!sourceBytes.value)

const progressPct = computed(() => {
  const p = progress.value
  if (!p) return 0
  // Auto runs two sub-strategies and sets overallPct explicitly so the bar
  // tracks across both halves without flickering back to 0% at the handoff.
  if (p.overallPct !== undefined) return p.overallPct
  if (p.total === 0) return 0
  return Math.round((p.current / p.total) * 100)
})

const progressLabel = computed(() => {
  const p = progress.value
  if (!p) return ''
  if (p.phase === 'rasterize') return `Rendering page ${p.current + 1} of ${p.total}`
  if (p.phase === 'image-recompress')
    return `Recompressing image ${p.current + 1} of ${p.total}`
  return 'Writing output…'
})

const savingsPct = computed(() => {
  if (!result.value) return 0
  const r = 1 - result.value.ratio
  return Math.max(0, Math.round(r * 100))
})

async function ingestFile(path: string, name?: string): Promise<void> {
  const bytes = await readFileAsArrayBuffer(path)
  sourceBytes.value = bytes
  sourcePath.value = path
  sourceName.value = name ?? nodePath().basename(path)
  sourceSize.value = bytes.byteLength
  result.value = null
  progress.value = null
}

async function onPickFile(): Promise<void> {
  const r = await ipcInvoke<OpenDialogResult>('dialog:open', {
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (r.canceled || r.filePaths.length === 0) return
  await ingestFile(r.filePaths[0])
}

async function onDrop(e: DragEvent): Promise<void> {
  e.preventDefault()
  dragover.value = false
  if (!e.dataTransfer) return
  const files = Array.from(e.dataTransfer.files).filter((f) =>
    f.name.toLowerCase().endsWith('.pdf'),
  ) as FileWithPath[]
  if (files.length === 0) return
  await ingestFile(files[0].path, files[0].name)
}

function onDragEnter(e: DragEvent) {
  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
    dragover.value = true
  }
}
function onDragOver(e: DragEvent) {
  e.preventDefault()
  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
    dragover.value = true
  }
}
function onDragLeave() {
  dragover.value = false
}

function clearSource() {
  sourceBytes.value = null
  sourceName.value = ''
  sourcePath.value = ''
  sourceSize.value = 0
  result.value = null
  progress.value = null
}

async function onCompress() {
  if (!sourceBytes.value || running.value) return
  running.value = true
  result.value = null
  progress.value = { phase: 'rasterize', current: 0, total: 1 }
  try {
    const r = await compressPdf({
      srcBytes: sourceBytes.value,
      strategy: strategy.value,
      preset: preset.value,
      onProgress: (p) => {
        progress.value = p
      },
    })
    result.value = r
    if (r.ratio >= 1) {
      toast('No compression possible at these settings', 'warn')
    } else {
      toast(`Compressed to ${formatBytes(r.compressedSize)}`, 'success')
    }
  } catch (err) {
    if (err instanceof CompressCancelled) {
      toast('Cancelled')
    } else {
      console.error(err)
      const msg = err instanceof Error ? err.message : String(err)
      toast(`Compression failed: ${msg}`, 'error')
    }
  } finally {
    running.value = false
    progress.value = null
  }
}

function onCancel() {
  if (running.value) requestCancel()
}

function defaultSaveName(): string {
  const base = sourceName.value.replace(/\.pdf$/i, '') || 'compressed'
  return `${base}-compressed.pdf`
}

async function onSaveResult() {
  if (!result.value) return
  const r = await ipcInvoke<SaveDialogResult>('dialog:save', {
    defaultPath: defaultSaveName(),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (r.canceled || !r.filePath) return
  try {
    await writeFileBytes(r.filePath, result.value.bytes)
    toast('Saved', 'success')
  } catch (err) {
    console.error(err)
    const msg = err instanceof Error ? err.message : String(err)
    toast(`Save failed: ${msg}`, 'error')
  }
}
</script>

<template>
  <section class="compress flex h-full flex-col gap-4 p-6">
    <header class="flex items-center gap-4 px-1">
      <UiButton variant="ghost" size="sm" @click="router.push({ name: 'welcome' })">
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
          <path d="M19 12H5" />
          <path d="M12 19l-7-7 7-7" />
        </svg>
        Home
      </UiButton>
      <h2
        class="flex-1 text-lg font-semibold tracking-[-0.3px] text-transparent"
        :style="{
          background: 'linear-gradient(135deg, #fff, #c4b5fd)',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
        }"
      >
        Compress PDF
      </h2>
    </header>

    <div
      v-if="!hasSource"
      class="glass relative flex flex-1 flex-col items-center justify-center gap-3 rounded-[14px] p-10 text-fg-dim transition-colors"
      :class="{ dragover }"
      @dragenter.prevent="onDragEnter"
      @dragover="onDragOver"
      @dragleave.prevent="onDragLeave"
      @drop="onDrop"
    >
      <svg
        viewBox="0 0 24 24"
        width="48"
        height="48"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        opacity="0.45"
      >
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
      </svg>
      <p class="text-sm">Drop a PDF here</p>
      <p class="text-xs text-fg-mute">or</p>
      <UiButton variant="primary" @click="onPickFile">Choose file</UiButton>
    </div>

    <div v-else class="flex flex-1 flex-col gap-4 overflow-y-auto">
      <div class="glass flex items-center gap-3 rounded-[14px] p-4">
        <div
          class="grid h-10 w-10 flex-shrink-0 place-items-center rounded-lg text-white"
          :style="{
            background:
              'linear-gradient(135deg, var(--color-accent), var(--color-accent-2))',
          }"
        >
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </div>
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-medium text-fg">{{ sourceName }}</div>
          <div class="text-xs text-fg-mute">{{ formatBytes(sourceSize) }}</div>
        </div>
        <UiButton variant="ghost" size="sm" :disabled="running" @click="clearSource">
          Change…
        </UiButton>
      </div>

      <section class="glass flex flex-col gap-3 rounded-[14px] p-5">
        <h3 class="text-xs font-semibold uppercase tracking-[0.5px] text-fg-dim">
          Strategy
        </h3>
        <div class="grid gap-2 sm:grid-cols-2">
          <label
            v-for="s in STRATEGIES"
            :key="s.key"
            class="opt"
            :class="{ active: strategy === s.key, disabled: running }"
          >
            <input
              v-model="strategy"
              type="radio"
              name="strategy"
              :value="s.key"
              :disabled="running"
            />
            <div class="flex flex-col gap-1">
              <span class="text-sm font-medium text-fg">{{ s.label }}</span>
              <span class="text-xs text-fg-mute">{{ s.blurb }}</span>
            </div>
          </label>
        </div>
      </section>

      <section class="glass flex flex-col gap-3 rounded-[14px] p-5">
        <h3 class="text-xs font-semibold uppercase tracking-[0.5px] text-fg-dim">
          Quality
        </h3>
        <div class="preset-row">
          <button
            v-for="p in PRESET_LIST"
            :key="p.key"
            type="button"
            class="preset-btn"
            :class="{ active: preset === p.key }"
            :disabled="running"
            @click="preset = p.key"
          >
            <span class="preset-label">{{ p.label }}</span>
            <span class="preset-hint">{{ p.hint }}</span>
          </button>
        </div>
        <p class="text-xs text-fg-mute">
          Low → smallest files, visible artifacts.
          High → near-original quality, modest savings.
        </p>
      </section>

      <div v-if="progress" class="glass flex flex-col gap-2 rounded-[14px] p-4">
        <div class="flex items-center justify-between text-xs text-fg-dim">
          <span>{{ progressLabel }}</span>
          <span style="font-variant-numeric: tabular-nums">{{ progressPct }}%</span>
        </div>
        <div class="progress-track">
          <div class="progress-bar" :style="{ width: `${progressPct}%` }" />
        </div>
      </div>

      <div
        v-if="result"
        class="glass flex flex-col gap-3 rounded-[14px] p-5"
      >
        <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div class="flex flex-col">
            <span class="text-[10px] uppercase tracking-[0.5px] text-fg-mute">
              Original
            </span>
            <span class="text-sm text-fg" style="font-variant-numeric: tabular-nums">
              {{ formatBytes(result.originalSize) }}
            </span>
          </div>
          <div class="flex flex-col">
            <span class="text-[10px] uppercase tracking-[0.5px] text-fg-mute">
              Compressed
            </span>
            <span class="text-sm text-fg" style="font-variant-numeric: tabular-nums">
              {{ formatBytes(result.compressedSize) }}
            </span>
          </div>
          <div class="flex flex-col">
            <span class="text-[10px] uppercase tracking-[0.5px] text-fg-mute">
              Savings
            </span>
            <span
              class="text-sm font-semibold"
              style="font-variant-numeric: tabular-nums"
              :class="savingsPct > 0 ? 'text-[#4ade80]' : 'text-fg-mute'"
            >
              {{ savingsPct }}%
            </span>
          </div>
          <div v-if="result.imagesTouched !== undefined" class="flex flex-col">
            <span class="text-[10px] uppercase tracking-[0.5px] text-fg-mute">
              Images
            </span>
            <span class="text-sm text-fg" style="font-variant-numeric: tabular-nums">
              {{ result.imagesTouched }} recompressed
              <template v-if="result.imagesDownsampled">
                · {{ result.imagesDownsampled }} downsampled
              </template>
              <template v-if="result.imagesSkipped">
                · {{ result.imagesSkipped }} skipped
              </template>
              <template v-if="result.imagesSkippedCmyk">
                ({{ result.imagesSkippedCmyk }} CMYK)
              </template>
            </span>
          </div>
          <div v-if="result.metadataStripped" class="flex flex-col">
            <span class="text-[10px] uppercase tracking-[0.5px] text-fg-mute">
              Metadata
            </span>
            <span class="text-sm text-fg">stripped</span>
          </div>
          <div class="flex-1" />
          <UiButton
            variant="primary"
            :disabled="!!result.noopReason"
            @click="onSaveResult"
          >
            Save as…
          </UiButton>
        </div>
        <p v-if="autoChoiceLabel" class="auto-note">{{ autoChoiceLabel }}</p>
        <p v-if="noopMessage" class="warn-note">{{ noopMessage }}</p>
      </div>

      <div class="flex justify-end gap-2">
        <UiButton v-if="running" variant="ghost" @click="onCancel">Cancel</UiButton>
        <UiButton
          v-else
          variant="primary"
          :disabled="!hasSource"
          @click="onCompress"
        >
          Compress
        </UiButton>
      </div>
    </div>
  </section>
</template>

<style scoped>
.compress :global(.dragover) {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px rgba(167, 139, 250, 0.2);
}

.opt {
  display: flex;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--color-glass-border);
  border-radius: 10px;
  background: var(--color-glass);
  cursor: pointer;
  transition: border-color 0.15s var(--ease-out-soft), background 0.15s var(--ease-out-soft);
}
.opt:hover {
  background: var(--color-glass-strong);
}
.opt.active {
  border-color: var(--color-accent);
  background: var(--color-glass-strong);
}
.opt.disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.opt input[type='radio'] {
  margin-top: 3px;
  accent-color: var(--color-accent);
}

.preset-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.preset-btn {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--color-glass-border);
  border-radius: 10px;
  background: var(--color-glass);
  color: var(--color-fg-dim);
  cursor: pointer;
  transition: background 0.15s var(--ease-out-soft), border-color 0.15s var(--ease-out-soft),
    color 0.15s var(--ease-out-soft);
}
.preset-btn:hover:not(:disabled) {
  background: var(--color-glass-strong);
}
.preset-btn.active {
  background: linear-gradient(135deg, rgba(167, 139, 250, 0.32), rgba(236, 72, 153, 0.32));
  border-color: var(--color-accent);
  color: var(--color-fg);
}
.preset-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.preset-label {
  font-size: 13px;
  font-weight: 600;
}
.preset-hint {
  font-size: 11px;
  color: var(--color-fg-mute);
}

.progress-track {
  width: 100%;
  height: 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}
.progress-bar {
  height: 100%;
  background: linear-gradient(90deg, var(--color-accent), var(--color-accent-2));
  border-radius: 4px;
  transition: width 0.2s var(--ease-out-soft);
}

.warn-note {
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(255, 191, 0, 0.1);
  border: 1px solid rgba(255, 191, 0, 0.3);
  font-size: 12px;
  line-height: 1.45;
  color: #fde68a;
}

.auto-note {
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(167, 139, 250, 0.12);
  border: 1px solid rgba(167, 139, 250, 0.3);
  font-size: 12px;
  line-height: 1.45;
  color: #ddd6fe;
}
</style>
