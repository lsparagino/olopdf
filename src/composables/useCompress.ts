// PDF compression — two strategies:
//
// 1. RASTERIZE: render each source page with pdf.js at a preset DPI, encode the
//    canvas as JPEG, embed into a fresh pdf-lib document with one page per
//    rendered image. Predictable, large savings. Destroys text selection and
//    flattens all annotations/vectors into a bitmap.
//
// 2. IMAGE-ONLY: load the source PDF with pdf-lib, walk every indirect object,
//    find image XObjects encoded with the DCTDecode (JPEG) filter, decode +
//    re-encode each at a lower quality, and assign the new raw stream back to
//    the same ref. Preserves text, vectors, and annotations. Savings depend on
//    how much of the document is JPEG image data — text-only PDFs see almost
//    nothing, scan-heavy PDFs see most of the win the rasterizer would get.
//
// Both strategies are CPU-bound and process pages/images sequentially. They
// expose a progress callback and check a shared cancel flag between items so
// the UI can show a meaningful progress bar and abort cleanly.

import { ref } from 'vue'
import { usePdfjs } from '@/composables/usePdfEngine'

const pdfLib = (window as unknown as { require: (m: string) => typeof import('pdf-lib') }).require(
  'pdf-lib',
)
const { PDFDocument, PDFName, PDFNumber, PDFRawStream } = pdfLib

export type CompressStrategy = 'auto' | 'rasterize' | 'image-only'
export type CompressPreset = 'low' | 'medium' | 'high'

// Auto strategy threshold: image-only must save at least this fraction of the
// source size on its own, otherwise we also run rasterize as a fallback and
// pick whichever output is smaller. 5% is the smallest savings that's worth
// destroying text selection for; below it the user is better off keeping the
// text-preserving result.
const AUTO_IMAGE_ONLY_MIN_SAVINGS = 0.05

interface PresetSettings {
  dpi: number
  jpegQuality: number
  // Cap the longest pixel dimension of any embedded image. A typical PDF page
  // at the preset's DPI is roughly this many pixels wide, so anything bigger
  // is over-resolved for the target output and gets downsampled — the biggest
  // single source of bloat in scan-heavy PDFs.
  maxImagePx: number
}

// DPI presets mirror Ghostscript's pdfwrite -dPDFSETTINGS profiles, which are
// the de facto industry baseline:
//   /screen   72 DPI  → email / on-screen viewing
//   /ebook    150 DPI → balanced
//   /printer  300 DPI → print-quality
// maxImagePx is sized so a full-page image at 1.5× the preset's DPI still
// fits without downsampling — covers the common "image scaled larger than
// page" case while still catching genuinely over-resolved scans.
export const COMPRESS_PRESETS: Record<CompressPreset, PresetSettings> = {
  low: { dpi: 72, jpegQuality: 0.55, maxImagePx: 1200 },
  medium: { dpi: 150, jpegQuality: 0.72, maxImagePx: 2400 },
  high: { dpi: 300, jpegQuality: 0.85, maxImagePx: 4800 },
}

export interface CompressProgress {
  phase: 'rasterize' | 'image-recompress' | 'save'
  current: number
  total: number
  // 0-100 progress for the whole compress run. For single-strategy runs the
  // UI can derive this from current/total directly; the Auto strategy sets it
  // explicitly so the bar tracks across two sequential sub-strategies (each
  // mapped to its own half of the bar) without flickering back to 0%.
  overallPct?: number
}

export interface CompressResult {
  bytes: Uint8Array
  originalSize: number
  compressedSize: number
  ratio: number
  imagesTouched?: number
  imagesSkipped?: number
  imagesDownsampled?: number
  // Subset of imagesSkipped that were skipped specifically because the source
  // image was DeviceCMYK. Surfaced so the UI can recommend rasterize when a
  // run noops on a CMYK-heavy PDF.
  imagesSkippedCmyk?: number
  metadataStripped?: boolean
  // Set when the strategy produced an output larger than the input and we
  // returned the original bytes instead. The UI surfaces this so the user
  // knows the source PDF is already efficient at this strategy.
  noopReason?: 'output-larger' | 'no-eligible-images'
  // Auto-strategy bookkeeping. autoChose is which sub-strategy's output we
  // actually kept; autoTriedRasterize is true if image-only's savings fell
  // below the threshold and we ran rasterize as a fallback (even if rasterize
  // didn't end up winning). The UI uses both to narrate what Auto did so it
  // isn't a black box.
  autoChose?: 'image-only' | 'rasterize'
  autoTriedRasterize?: boolean
}

export class CompressCancelled extends Error {
  constructor() {
    super('Compression cancelled')
    this.name = 'CompressCancelled'
  }
}

// Single shared cancel flag so the UI can wire one Cancel button regardless of
// strategy. The composable resets it at the start of each run.
const cancelRequested = ref(false)

export function requestCancel(): void {
  cancelRequested.value = true
}

export function isCancelRequested(): boolean {
  return cancelRequested.value
}

function checkCancel(): void {
  if (cancelRequested.value) throw new CompressCancelled()
}

// pdfjs's default user-space unit is 1/72 inch; scale = dpi/72 produces a
// viewport at the target DPI.
function dpiToScale(dpi: number): number {
  return dpi / 72
}

interface PdfjsPageLike {
  getViewport(opts: { scale: number; rotation?: number }): {
    width: number
    height: number
  }
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): {
    promise: Promise<void>
    cancel(): void
  }
  rotate?: number
}

interface PdfjsDocLike {
  numPages: number
  getPage(n: number): Promise<PdfjsPageLike>
}

async function canvasToJpegBytes(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', quality)
  })
  if (!blob) throw new Error('Canvas encoding failed')
  return new Uint8Array(await blob.arrayBuffer())
}

// Compute the downsampled output dimensions for an image. If the longest side
// is already at or below `maxPx`, leaves the dimensions untouched. Otherwise
// scales proportionally so the longest side hits `maxPx`. Returned width and
// height are always >= 1 to satisfy canvas APIs.
function computeTargetSize(
  srcW: number,
  srcH: number,
  maxPx: number,
): { w: number; h: number; downsampled: boolean } {
  const longest = Math.max(srcW, srcH)
  if (longest <= maxPx) return { w: srcW, h: srcH, downsampled: false }
  const scale = maxPx / longest
  return {
    w: Math.max(1, Math.round(srcW * scale)),
    h: Math.max(1, Math.round(srcH * scale)),
    downsampled: true,
  }
}

type ColorSpaceKind = 'rgb' | 'gray' | 'cmyk' | 'other'

// Classify the image XObject's /ColorSpace. Only handles the three Device
// spaces; arrays (Indexed, ICCBased, CalRGB, etc.) all fall through to
// 'other'. DeviceCMYK is detected so we can count it for diagnostics, but
// it's treated as unsafe — see isSafeImageStream below.
function classifyColorSpace(stream: import('pdf-lib').PDFRawStream): ColorSpaceKind {
  const cs = stream.dict.lookup(PDFName.of('ColorSpace'))
  if (!cs) return 'rgb' // absent → defaults to DeviceRGB for image XObjects
  const text = cs.toString().trim()
  if (text === '/DeviceRGB') return 'rgb'
  if (text === '/DeviceGray') return 'gray'
  if (text === '/DeviceCMYK') return 'cmyk'
  return 'other'
}

async function rasterizeCompress(
  srcBytes: ArrayBuffer,
  preset: PresetSettings,
  onProgress: (p: CompressProgress) => void,
): Promise<Uint8Array> {
  const pdfjs = usePdfjs()
  // pdf.js transfers the buffer; pass a copy so the caller keeps the original.
  const srcDoc = (await pdfjs.getDocument({ data: srcBytes.slice(0) }).promise) as PdfjsDocLike
  const out = await PDFDocument.create()
  const scale = dpiToScale(preset.dpi)

  for (let i = 0; i < srcDoc.numPages; i++) {
    checkCancel()
    onProgress({ phase: 'rasterize', current: i, total: srcDoc.numPages })

    const page = await srcDoc.getPage(i + 1)
    const rotation = page.rotate ?? 0
    // Render with the page's existing rotation so the JPEG matches how the
    // user sees the page; we then create an output page sized to that
    // rotated viewport. No /Rotate entry on the output page.
    const baseVp = page.getViewport({ scale: 1, rotation })
    const renderVp = page.getViewport({ scale, rotation })

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(renderVp.width))
    canvas.height = Math.max(1, Math.floor(renderVp.height))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D context unavailable')
    // White-fill so transparent PDFs don't render with a black background in
    // the JPEG (JPEG has no alpha channel).
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    const task = page.render({ canvasContext: ctx, viewport: renderVp })
    await task.promise

    const jpeg = await canvasToJpegBytes(canvas, preset.jpegQuality)
    const image = await out.embedJpg(jpeg)
    const outPage = out.addPage([baseVp.width, baseVp.height])
    outPage.drawImage(image, {
      x: 0,
      y: 0,
      width: baseVp.width,
      height: baseVp.height,
    })

    // Help the GC reclaim large canvases between iterations on big docs.
    canvas.width = 0
    canvas.height = 0
  }

  checkCancel()
  onProgress({ phase: 'save', current: srcDoc.numPages, total: srcDoc.numPages })
  return out.save({ useObjectStreams: true })
}

// Read the /Filter entry on an image XObject. PDF spec allows a single name or
// an array of names; normalize to an array of decoded filter names.
function readFilters(stream: import('pdf-lib').PDFRawStream): string[] {
  const filter = stream.dict.lookup(PDFName.of('Filter'))
  if (!filter) return []
  const text = filter.toString()
  // Names are "/Foo" or "[/Foo /Bar]" — strip slashes and brackets, split.
  return text
    .replace(/[[\]]/g, ' ')
    .split(/\s+/)
    .map((s) => s.replace(/^\//, '').trim())
    .filter(Boolean)
}

interface DecodedJpeg {
  canvas: HTMLCanvasElement
  naturalW: number
  naturalH: number
}

// Decode a JPEG (any color space the browser supports — RGB, Gray, CMYK) and
// render it onto a canvas. When `target` is provided the image is drawn at
// those dimensions with high-quality smoothing, producing the downsample in a
// single step. Browsers convert CMYK JPEGs to RGB during decode, so the
// resulting canvas always carries RGB pixel data — callers updating the dict
// should rewrite /ColorSpace to /DeviceRGB to match.
async function decodeJpegBytesToCanvas(
  jpegBytes: Uint8Array,
  target?: { w: number; h: number },
): Promise<DecodedJpeg> {
  // Cast — recent dom lib types tightened BlobPart to ArrayBufferView<ArrayBuffer>
  // and our Uint8Array can carry an ArrayBufferLike. The runtime accepts both.
  const blob = new Blob([jpegBytes as BlobPart], { type: 'image/jpeg' })
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Failed to decode image'))
      img.src = url
    })
    const naturalW = img.naturalWidth
    const naturalH = img.naturalHeight
    const w = target?.w ?? naturalW
    const h = target?.h ?? naturalH
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D context unavailable')
    if (target) {
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
    }
    ctx.drawImage(img, 0, 0, w, h)
    return { canvas, naturalW, naturalH }
  } finally {
    URL.revokeObjectURL(url)
  }
}

// Decide whether a given image XObject is safe to round-trip through the
// browser's JPEG codec. /SMask and /Mask reference a sibling image whose
// pixels must align — if we downsample the parent, the mask no longer lines
// up, so we leave masked images alone. /Decode remaps sample values; a
// re-encoded JPEG with the standard identity decode would render with
// inverted or shifted colors.
//
// ColorSpace: only DeviceRGB and DeviceGray are safe. The browser's <img>
// decoder converts CMYK JPEGs to sRGB during decode, and canvas.toBlob
// re-encodes as a 3-channel sRGB JPEG — but we only clone+patch the dict, we
// don't rewrite /ColorSpace. The viewer then reads the new sRGB bytes through
// /DeviceCMYK and interprets (255,255,255) as C=M=Y=100% → near black. We
// can't fix this by writing /DeviceRGB into the dict either, because the
// browser's CMYK→sRGB matrix doesn't match the SWOP-style transform PDF
// readers apply, so even a "correct" rewrite shifts colors visibly. Indexed,
// ICCBased, CalRGB, Lab etc. all fall through to 'other' and are likewise
// skipped — we can't reproduce them faithfully without a color-managed
// pipeline.
function isSafeImageStream(stream: import('pdf-lib').PDFRawStream): boolean {
  const dict = stream.dict
  if (dict.lookup(PDFName.of('SMask'))) return false
  if (dict.lookup(PDFName.of('Mask'))) return false
  if (dict.lookup(PDFName.of('Decode'))) return false
  const color = classifyColorSpace(stream)
  return color === 'rgb' || color === 'gray'
}

interface ImageRecompressStats {
  imagesTouched: number
  imagesSkipped: number
  imagesDownsampled: number
  // Number of DCT image XObjects whose /ColorSpace was DeviceCMYK and got
  // skipped specifically for that reason. Surfaced so the UI can suggest
  // rasterize for CMYK-heavy PDFs — those are color-managed at render time
  // and don't rely on us reproducing the source CMYK→RGB matrix.
  imagesSkippedCmyk: number
}

async function imageRecompress(
  srcBytes: ArrayBuffer,
  preset: PresetSettings,
  onProgress: (p: CompressProgress) => void,
): Promise<{ bytes: Uint8Array; metadataStripped: boolean } & ImageRecompressStats> {
  const doc = await PDFDocument.load(srcBytes.slice(0))
  const ctx = doc.context

  // Find every DCTDecode-filtered image XObject. JBIG2 / JPEG2000 / Flate
  // image streams are intentionally skipped — re-encoding them as JPEG would
  // require a full color-space conversion path and they're a small minority
  // of real-world bloat.
  interface Candidate {
    ref: import('pdf-lib').PDFRef
    stream: import('pdf-lib').PDFRawStream
    safe: boolean
    color: ColorSpaceKind
  }
  const candidates: Candidate[] = []
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue
    const subtype = obj.dict.lookup(PDFName.of('Subtype'))
    if (!subtype || subtype.toString() !== '/Image') continue
    const filters = readFilters(obj)
    if (!filters.includes('DCTDecode')) continue
    candidates.push({
      ref,
      stream: obj,
      safe: isSafeImageStream(obj),
      color: classifyColorSpace(obj),
    })
  }

  const stats: ImageRecompressStats = {
    imagesTouched: 0,
    imagesSkipped: 0,
    imagesDownsampled: 0,
    imagesSkippedCmyk: 0,
  }

  for (let i = 0; i < candidates.length; i++) {
    checkCancel()
    onProgress({ phase: 'image-recompress', current: i, total: candidates.length })
    const { ref, stream, safe, color } = candidates[i]
    if (!safe) {
      stats.imagesSkipped++
      if (color === 'cmyk') stats.imagesSkippedCmyk++
      continue
    }
    const oldBytes = stream.getContents()
    try {
      // Decode at natural size first so we can decide whether to downsample.
      const decoded = await decodeJpegBytesToCanvas(oldBytes)
      const target = computeTargetSize(
        decoded.naturalW,
        decoded.naturalH,
        preset.maxImagePx,
      )

      let workCanvas = decoded.canvas
      if (target.downsampled) {
        const tc = document.createElement('canvas')
        tc.width = target.w
        tc.height = target.h
        const tctx = tc.getContext('2d')
        if (!tctx) throw new Error('Canvas 2D context unavailable')
        tctx.imageSmoothingEnabled = true
        tctx.imageSmoothingQuality = 'high'
        tctx.drawImage(decoded.canvas, 0, 0, target.w, target.h)
        decoded.canvas.width = 0
        decoded.canvas.height = 0
        workCanvas = tc
      }

      const newBytes = await canvasToJpegBytes(workCanvas, preset.jpegQuality)
      workCanvas.width = 0
      workCanvas.height = 0

      // Skip if recompression didn't actually save anything (already heavily
      // compressed, or the source quality was already at or below the target).
      if (newBytes.length >= oldBytes.length) {
        stats.imagesSkipped++
        continue
      }

      // Clone the dict and rewrite anything the recompression changed.
      // Right now the only mutation is /Width and /Height when we downsampled
      // — color space stays untouched because we only handle DeviceRGB /
      // DeviceGray images, which round-trip through the JPEG codec faithfully.
      const newDict = stream.dict.clone(ctx)
      if (target.downsampled) {
        newDict.set(PDFName.of('Width'), PDFNumber.of(target.w))
        newDict.set(PDFName.of('Height'), PDFNumber.of(target.h))
        stats.imagesDownsampled++
      }
      const newStream = PDFRawStream.of(newDict, newBytes)
      ctx.assign(ref, newStream)
      stats.imagesTouched++
    } catch {
      stats.imagesSkipped++
      continue
    }
  }

  const metadataStripped = stripDocumentMetadata(doc)

  checkCancel()
  onProgress({ phase: 'save', current: candidates.length, total: candidates.length })
  const bytes = await doc.save({ useObjectStreams: true })
  return { bytes, ...stats, metadataStripped }
}

// Remove the trailer /Info dict and the catalog /Metadata XMP stream. Neither
// affects rendering; both can be tens of KB. Returns true iff at least one
// was actually present (the UI uses this to surface a "metadata stripped"
// note so the result feels deliberate).
function stripDocumentMetadata(doc: import('pdf-lib').PDFDocument): boolean {
  let stripped = false
  if (doc.context.trailerInfo.Info) {
    doc.context.trailerInfo.Info = undefined
    stripped = true
  }
  try {
    const catalog = doc.catalog
    if (catalog.lookup(PDFName.of('Metadata'))) {
      catalog.delete(PDFName.of('Metadata'))
      stripped = true
    }
  } catch {
    /* ignore — catalog quirks shouldn't fail the whole run */
  }
  return stripped
}

function arrayBufferToUint8(ab: ArrayBuffer): Uint8Array {
  return new Uint8Array(ab.slice(0))
}

// Wraps an onProgress callback so the emitted CompressProgress carries an
// overallPct that maps the inner phase's [0..1] progression to a fixed slice
// of the overall bar (used by the Auto strategy to give each sub-strategy
// its own half of the bar).
function scaledProgress(
  onProgress: (p: CompressProgress) => void,
  startPct: number,
  endPct: number,
): (p: CompressProgress) => void {
  const span = endPct - startPct
  return (p) => {
    const frac = p.total > 0 ? p.current / p.total : 0
    onProgress({ ...p, overallPct: Math.round(startPct + frac * span) })
  }
}

// Auto strategy: try image-only first (text-preserving), and only fall back to
// rasterize when image-only's savings are below the threshold. When we do
// fall back, keep whichever output is smaller. The two sub-strategies each
// own half of the progress bar via scaledProgress so the bar advances
// monotonically across the run.
interface AutoResult {
  bytes: Uint8Array
  imagesTouched: number
  imagesSkipped: number
  imagesDownsampled: number
  imagesSkippedCmyk: number
  metadataStripped: boolean
  autoChose: 'image-only' | 'rasterize'
  autoTriedRasterize: boolean
  noopReason?: CompressResult['noopReason']
}

async function autoCompress(
  srcBytes: ArrayBuffer,
  settings: PresetSettings,
  onProgress: (p: CompressProgress) => void,
  originalSize: number,
): Promise<AutoResult> {
  const imgRes = await imageRecompress(
    srcBytes,
    settings,
    scaledProgress(onProgress, 0, 50),
  )
  const imgSavings = 1 - imgRes.bytes.byteLength / Math.max(1, originalSize)

  let bytes: Uint8Array
  let autoChose: 'image-only' | 'rasterize'
  let autoTriedRasterize: boolean

  if (imgSavings >= AUTO_IMAGE_ONLY_MIN_SAVINGS) {
    bytes = imgRes.bytes
    autoChose = 'image-only'
    autoTriedRasterize = false
    // Single sub-strategy ran; force the bar to 100% so it doesn't stall at
    // 50% while the result panel renders.
    onProgress({ phase: 'save', current: 1, total: 1, overallPct: 100 })
  } else {
    autoTriedRasterize = true
    const rastBytes = await rasterizeCompress(
      srcBytes,
      settings,
      scaledProgress(onProgress, 50, 100),
    )
    if (rastBytes.byteLength < imgRes.bytes.byteLength) {
      bytes = rastBytes
      autoChose = 'rasterize'
    } else {
      bytes = imgRes.bytes
      autoChose = 'image-only'
    }
  }

  let noopReason: CompressResult['noopReason']
  if (bytes.byteLength >= originalSize) {
    bytes = arrayBufferToUint8(srcBytes)
    noopReason = imgRes.imagesTouched === 0 && !autoTriedRasterize
      ? 'no-eligible-images'
      : 'output-larger'
  }

  return {
    bytes,
    imagesTouched: imgRes.imagesTouched,
    imagesSkipped: imgRes.imagesSkipped,
    imagesDownsampled: imgRes.imagesDownsampled,
    imagesSkippedCmyk: imgRes.imagesSkippedCmyk,
    metadataStripped: imgRes.metadataStripped,
    autoChose,
    autoTriedRasterize,
    noopReason,
  }
}

export async function compressPdf(opts: {
  srcBytes: ArrayBuffer
  strategy: CompressStrategy
  preset: CompressPreset
  onProgress?: (p: CompressProgress) => void
}): Promise<CompressResult> {
  const settings = COMPRESS_PRESETS[opts.preset]
  const progress = opts.onProgress ?? (() => {})
  cancelRequested.value = false

  const originalSize = opts.srcBytes.byteLength
  let bytes: Uint8Array
  let imagesTouched: number | undefined
  let imagesSkipped: number | undefined
  let imagesDownsampled: number | undefined
  let imagesSkippedCmyk: number | undefined
  let metadataStripped: boolean | undefined
  let noopReason: CompressResult['noopReason']
  let autoChose: CompressResult['autoChose']
  let autoTriedRasterize: boolean | undefined

  if (opts.strategy === 'rasterize') {
    bytes = await rasterizeCompress(opts.srcBytes, settings, progress)
    // Text-heavy PDFs render larger as bitmaps than they store as glyph
    // references. Detect this and hand back the original bytes so the user
    // never gets a "compressed" file that's actually bigger.
    if (bytes.byteLength >= originalSize) {
      bytes = arrayBufferToUint8(opts.srcBytes)
      noopReason = 'output-larger'
    }
  } else if (opts.strategy === 'image-only') {
    const result = await imageRecompress(opts.srcBytes, settings, progress)
    bytes = result.bytes
    imagesTouched = result.imagesTouched
    imagesSkipped = result.imagesSkipped
    imagesDownsampled = result.imagesDownsampled
    imagesSkippedCmyk = result.imagesSkippedCmyk
    metadataStripped = result.metadataStripped
    // Compare to original — image-only also does structural compression
    // (useObjectStreams + metadata strip), which can shrink the file even
    // when no images were touched, so don't shortcut on imagesTouched === 0.
    if (bytes.byteLength >= originalSize) {
      // Re-serializing through pdf-lib gained nothing. Hand back the
      // original bytes so the user sees a clear "already optimal" signal
      // rather than a marginally-larger or identical "compressed" copy.
      bytes = arrayBufferToUint8(opts.srcBytes)
      noopReason = imagesTouched === 0 ? 'no-eligible-images' : 'output-larger'
    }
  } else {
    const r = await autoCompress(opts.srcBytes, settings, progress, originalSize)
    bytes = r.bytes
    imagesTouched = r.imagesTouched
    imagesSkipped = r.imagesSkipped
    imagesDownsampled = r.imagesDownsampled
    imagesSkippedCmyk = r.imagesSkippedCmyk
    metadataStripped = r.metadataStripped
    autoChose = r.autoChose
    autoTriedRasterize = r.autoTriedRasterize
    noopReason = r.noopReason
  }

  const compressedSize = bytes.byteLength
  return {
    bytes,
    originalSize,
    compressedSize,
    ratio: compressedSize / Math.max(1, originalSize),
    imagesTouched,
    imagesSkipped,
    imagesDownsampled,
    imagesSkippedCmyk,
    metadataStripped,
    noopReason,
    autoChose,
    autoTriedRasterize,
  }
}
