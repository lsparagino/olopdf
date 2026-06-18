// Compression benchmark — runs the image-only and rasterize strategies (with
// the same logic as src/composables/useCompress.ts) against every PDF under
// test_pdfs/ and prints a comparison table. Uses sharp + node-canvas instead
// of the browser's <img>+<canvas>, so results are comparable but not strictly
// byte-identical to what the app produces.
//
// Usage: node scripts/test-compress.mjs [path-to-test_pdfs-dir]
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import sharp from 'sharp'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const testDir = process.argv[2] || path.join(root, 'test_pdfs')
const outDir = path.join(root, 'test_pdfs', '_out')
const require = createRequire(import.meta.url)

const { PDFDocument, PDFName, PDFNumber, PDFRawStream } = require('pdf-lib')
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js')
const { createCanvas, Image } = require('canvas')

// Worker setup for pdfjs in Node — supply a no-op fake worker so getDocument
// doesn't try to spawn a real one.
pdfjs.GlobalWorkerOptions.workerSrc = require.resolve(
  'pdfjs-dist/legacy/build/pdf.worker.js',
)

// pdfjs in Node needs an explicit CanvasFactory to mediate between its
// internal "Image or Canvas" type checks and the node-canvas package.
class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height)
    const context = canvas.getContext('2d')
    return { canvas, context }
  }
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width
    canvasAndContext.canvas.height = height
  }
  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0
    canvasAndContext.canvas.height = 0
    canvasAndContext.canvas = null
    canvasAndContext.context = null
  }
}
// Expose the polyfilled Image globally so pdfjs's inline-image code path
// finds it. Without this, pdfjs errors with "Image or Canvas expected".
globalThis.Image = Image
globalThis.DOMMatrix = require('canvas').DOMMatrix
globalThis.ImageData = require('canvas').ImageData
globalThis.Path2D = require('canvas').Path2D

// Mirror src/composables/useCompress.ts presets exactly.
const PRESETS = {
  low: { dpi: 72, jpegQuality: 0.55, maxImagePx: 1200 },
  medium: { dpi: 150, jpegQuality: 0.72, maxImagePx: 2400 },
  high: { dpi: 300, jpegQuality: 0.85, maxImagePx: 4800 },
}

function readFilters(stream) {
  const filter = stream.dict.lookup(PDFName.of('Filter'))
  if (!filter) return []
  return filter
    .toString()
    .replace(/[[\]]/g, ' ')
    .split(/\s+/)
    .map((s) => s.replace(/^\//, '').trim())
    .filter(Boolean)
}

function classifyColorSpace(stream) {
  const cs = stream.dict.lookup(PDFName.of('ColorSpace'))
  if (!cs) return 'rgb'
  const text = cs.toString().trim()
  if (text === '/DeviceRGB') return 'rgb'
  if (text === '/DeviceGray') return 'gray'
  if (text === '/DeviceCMYK') return 'cmyk'
  return 'other'
}

function isSafeImageStream(stream) {
  const d = stream.dict
  if (d.lookup(PDFName.of('SMask'))) return false
  if (d.lookup(PDFName.of('Mask'))) return false
  if (d.lookup(PDFName.of('Decode'))) return false
  // Match the renderer engine: only DeviceRGB and DeviceGray. CMYK ICCBased
  // and friends round-trip through sharp/canvas without color management →
  // visible color shifts → skip.
  const c = classifyColorSpace(stream)
  return c === 'rgb' || c === 'gray'
}

function computeTargetSize(srcW, srcH, maxPx) {
  const longest = Math.max(srcW, srcH)
  if (longest <= maxPx) return { w: srcW, h: srcH, downsampled: false }
  const scale = maxPx / longest
  return {
    w: Math.max(1, Math.round(srcW * scale)),
    h: Math.max(1, Math.round(srcH * scale)),
    downsampled: true,
  }
}

function stripDocumentMetadata(doc) {
  let stripped = false
  if (doc.context.trailerInfo.Info) {
    doc.context.trailerInfo.Info = undefined
    stripped = true
  }
  try {
    if (doc.catalog.lookup(PDFName.of('Metadata'))) {
      doc.catalog.delete(PDFName.of('Metadata'))
      stripped = true
    }
  } catch {}
  return stripped
}

// Analyze the image landscape of a PDF without modifying it — used for the
// "diagnostic" column in the report.
async function analyze(srcBytes) {
  const doc = await PDFDocument.load(srcBytes)
  const ctx = doc.context
  const stats = {
    totalImages: 0,
    dct: 0,
    safe: 0,
    rgb: 0,
    gray: 0,
    cmyk: 0,
    other: 0,
    masked: 0,
    decoded: 0,
    totalJpegBytes: 0,
    largestDim: 0,
  }
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue
    const subtype = obj.dict.lookup(PDFName.of('Subtype'))
    if (!subtype || subtype.toString() !== '/Image') continue
    stats.totalImages++
    const filters = readFilters(obj)
    const isDct = filters.includes('DCTDecode')
    if (isDct) stats.dct++
    const cs = classifyColorSpace(obj)
    stats[cs]++
    if (obj.dict.lookup(PDFName.of('SMask')) || obj.dict.lookup(PDFName.of('Mask'))) {
      stats.masked++
    }
    if (obj.dict.lookup(PDFName.of('Decode'))) stats.decoded++
    if (isSafeImageStream(obj) && isDct) stats.safe++
    if (isDct) {
      stats.totalJpegBytes += obj.getContents().length
      const w = obj.dict.lookup(PDFName.of('Width'))
      const h = obj.dict.lookup(PDFName.of('Height'))
      const wn = w ? Number(w.toString()) : 0
      const hn = h ? Number(h.toString()) : 0
      stats.largestDim = Math.max(stats.largestDim, wn, hn)
    }
  }
  return stats
}

async function imageOnlyCompress(srcBytes, preset) {
  const doc = await PDFDocument.load(srcBytes)
  const ctx = doc.context
  const candidates = []
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
  const stats = {
    imagesTouched: 0,
    imagesSkipped: 0,
    imagesDownsampled: 0,
    imagesSkippedCmyk: 0,
  }
  for (const c of candidates) {
    if (!c.safe) {
      stats.imagesSkipped++
      if (c.color === 'cmyk') stats.imagesSkippedCmyk++
      continue
    }
    const oldBytes = c.stream.getContents()
    try {
      const decoder = sharp(oldBytes)
      const meta = await decoder.metadata()
      const srcW = meta.width || 0
      const srcH = meta.height || 0
      const target = computeTargetSize(srcW, srcH, preset.maxImagePx)
      let pipeline = sharp(oldBytes)
      if (target.downsampled) {
        pipeline = pipeline.resize(target.w, target.h, { kernel: 'lanczos3' })
      }
      const newBytes = await pipeline
        .jpeg({ quality: Math.round(preset.jpegQuality * 100), mozjpeg: false })
        .toBuffer()
      if (newBytes.length >= oldBytes.length) {
        stats.imagesSkipped++
        continue
      }
      const newDict = c.stream.dict.clone(ctx)
      if (target.downsampled) {
        newDict.set(PDFName.of('Width'), PDFNumber.of(target.w))
        newDict.set(PDFName.of('Height'), PDFNumber.of(target.h))
        stats.imagesDownsampled++
      }
      ctx.assign(c.ref, PDFRawStream.of(newDict, newBytes))
      stats.imagesTouched++
    } catch {
      stats.imagesSkipped++
    }
  }
  const metadataStripped = stripDocumentMetadata(doc)
  const bytes = await doc.save({ useObjectStreams: true })
  return { bytes, ...stats, metadataStripped }
}

async function rasterizeCompress(srcBytes, preset) {
  const data = new Uint8Array(srcBytes.byteLength)
  data.set(new Uint8Array(srcBytes))
  const canvasFactory = new NodeCanvasFactory()
  const doc = await pdfjs.getDocument({ data, disableWorker: true, canvasFactory })
    .promise
  const out = await PDFDocument.create()
  const scale = preset.dpi / 72
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const rotation = page.rotate ?? 0
    const baseVp = page.getViewport({ scale: 1, rotation })
    const renderVp = page.getViewport({ scale, rotation })
    const cac = canvasFactory.create(
      Math.max(1, Math.floor(renderVp.width)),
      Math.max(1, Math.floor(renderVp.height)),
    )
    cac.context.fillStyle = '#ffffff'
    cac.context.fillRect(0, 0, cac.canvas.width, cac.canvas.height)
    await page.render({
      canvasContext: cac.context,
      viewport: renderVp,
      canvasFactory,
    }).promise
    const jpeg = cac.canvas.toBuffer('image/jpeg', { quality: preset.jpegQuality })
    canvasFactory.destroy(cac)
    const image = await out.embedJpg(jpeg)
    const outPage = out.addPage([baseVp.width, baseVp.height])
    outPage.drawImage(image, { x: 0, y: 0, width: baseVp.width, height: baseVp.height })
  }
  return out.save({ useObjectStreams: true })
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
function fmtPct(n) {
  const sign = n > 0 ? '+' : ''
  return `${sign}${n.toFixed(1)}%`
}

function pad(s, n, align = 'left') {
  const str = String(s)
  if (str.length >= n) return str.slice(0, n)
  const fill = ' '.repeat(n - str.length)
  return align === 'right' ? fill + str : str + fill
}

// Mirror compressPdf's safety guard: if the result is >= the original, the
// app returns the original bytes (noopReason). Report what the user would
// actually see in the UI, not the raw post-pdf-lib size.
function applySafetyGuard(resultBytes, origBytes) {
  if (resultBytes.length >= origBytes.length) {
    return { bytes: origBytes, noop: true }
  }
  return { bytes: resultBytes, noop: false }
}

// Mirror autoCompress: if image-only saves ≥ 5%, keep it; otherwise also run
// rasterize and pick whichever output is smaller. Operates on already-guarded
// sizes (so a noopped sub-strategy is reported as the original size) — that
// matches what the UI would surface to the user.
const AUTO_IMAGE_ONLY_MIN_SAVINGS = 0.05
function simulateAuto(origSize, ioSize, rastSize) {
  const ioSavings = 1 - ioSize / Math.max(1, origSize)
  if (ioSavings >= AUTO_IMAGE_ONLY_MIN_SAVINGS) {
    return { size: ioSize, chose: 'image-only' }
  }
  if (rastSize < ioSize) return { size: rastSize, chose: 'rasterize' }
  return { size: ioSize, chose: 'image-only' }
}

// Structural-only baseline: load the PDF, strip metadata, save with object
// streams — no image work. Isolates how much of the win came from structural
// compression alone, useful for text-heavy docs.
async function structuralOnly(srcBytes) {
  const doc = await PDFDocument.load(srcBytes)
  stripDocumentMetadata(doc)
  return doc.save({ useObjectStreams: true })
}

async function main() {
  const files = (await readdir(testDir))
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .sort()
  if (files.length === 0) {
    console.error(`No PDFs found under ${testDir}`)
    process.exit(1)
  }
  await mkdir(outDir, { recursive: true })

  console.log(`Found ${files.length} PDF(s) under ${testDir}\n`)

  const rows = []
  for (const f of files) {
    const src = await readFile(path.join(testDir, f))
    const orig = src.byteLength
    const short = f.length > 56 ? `${f.slice(0, 53)}…` : f
    console.log(`=== ${short} (${fmtBytes(orig)}) ===`)

    const analysis = await analyze(src)
    console.log(
      `  images=${analysis.totalImages} dct=${analysis.dct} ` +
        `safe=${analysis.safe} rgb=${analysis.rgb} gray=${analysis.gray} ` +
        `cmyk=${analysis.cmyk} other=${analysis.other} masked=${analysis.masked} ` +
        `largestDim=${analysis.largestDim}px ` +
        `jpegBytes=${fmtBytes(analysis.totalJpegBytes)}`,
    )

    const row = { file: short, orig, analysis }

    try {
      const structBytes = await structuralOnly(src)
      const guarded = applySafetyGuard(structBytes, src)
      row.struct = guarded.bytes.length
      console.log(
        `  structural-only       → ${fmtBytes(guarded.bytes.length).padStart(9)} (${fmtPct((guarded.bytes.length / orig - 1) * 100).padStart(7)})${guarded.noop ? '  [noop: kept original]' : ''}`,
      )
    } catch (e) {
      console.log(`  structural-only FAILED: ${e.message}`)
    }

    for (const presetName of ['low', 'medium', 'high']) {
      const preset = PRESETS[presetName]
      try {
        const r = await imageOnlyCompress(src, preset)
        const guarded = applySafetyGuard(r.bytes, src)
        row[`io_${presetName}`] = guarded.bytes.length
        console.log(
          `  image-only ${presetName.padEnd(6)} → ${fmtBytes(guarded.bytes.length).padStart(9)} (${fmtPct((guarded.bytes.length / orig - 1) * 100).padStart(7)})  ` +
            `touched=${r.imagesTouched} downs=${r.imagesDownsampled} skip=${r.imagesSkipped}(${r.imagesSkippedCmyk}cmyk)` +
            (r.metadataStripped ? ' meta✓' : '') +
            (guarded.noop ? '  [noop: kept original]' : ''),
        )
        if (!guarded.noop) {
          await writeFile(
            path.join(outDir, `${path.parse(f).name}.io.${presetName}.pdf`),
            guarded.bytes,
          )
        }
      } catch (e) {
        console.log(`  image-only ${presetName} FAILED: ${e.message}`)
      }
    }
    for (const presetName of ['low', 'medium', 'high']) {
      const preset = PRESETS[presetName]
      try {
        const bytes = await rasterizeCompress(src, preset)
        const guarded = applySafetyGuard(bytes, src)
        row[`rast_${presetName}`] = guarded.bytes.length
        console.log(
          `  rasterize  ${presetName.padEnd(6)} → ${fmtBytes(guarded.bytes.length).padStart(9)} (${fmtPct((guarded.bytes.length / orig - 1) * 100).padStart(7)})${guarded.noop ? '  [noop: kept original]' : ''}`,
        )
        if (!guarded.noop) {
          await writeFile(
            path.join(outDir, `${path.parse(f).name}.rast.${presetName}.pdf`),
            guarded.bytes,
          )
        }
      } catch (e) {
        console.log(`  rasterize  ${presetName} FAILED: ${e.message}`)
      }
    }
    rows.push(row)
    console.log()
  }

  // Summary table — Auto columns are simulated from the IO/Rast results we
  // already gathered; they show what the new default strategy would pick at
  // each preset.
  console.log('=== SUMMARY (% delta vs original, lower is better) ===')
  const header =
    pad('File', 46) +
    pad('Orig', 10, 'right') +
    pad('Struct', 9, 'right') +
    pad('IO-L', 9, 'right') +
    pad('IO-M', 9, 'right') +
    pad('IO-H', 9, 'right') +
    pad('R-L', 9, 'right') +
    pad('R-M', 9, 'right') +
    pad('R-H', 9, 'right') +
    pad('Auto-L', 12, 'right') +
    pad('Auto-M', 12, 'right') +
    pad('Auto-H', 12, 'right')
  console.log(header)
  console.log('-'.repeat(header.length))
  const pct = (n, o) => (n !== undefined ? fmtPct((n / o - 1) * 100) : 'n/a')
  const autoCell = (io, rast, orig) => {
    if (io === undefined || rast === undefined) return 'n/a'
    const sim = simulateAuto(orig, io, rast)
    const tag = sim.chose === 'rasterize' ? 'R' : 'I'
    return `${fmtPct((sim.size / orig - 1) * 100)}(${tag})`
  }
  for (const r of rows) {
    const cells = [
      pad(r.file, 46),
      pad(fmtBytes(r.orig), 10, 'right'),
      pad(pct(r.struct, r.orig), 9, 'right'),
      pad(pct(r.io_low, r.orig), 9, 'right'),
      pad(pct(r.io_medium, r.orig), 9, 'right'),
      pad(pct(r.io_high, r.orig), 9, 'right'),
      pad(pct(r.rast_low, r.orig), 9, 'right'),
      pad(pct(r.rast_medium, r.orig), 9, 'right'),
      pad(pct(r.rast_high, r.orig), 9, 'right'),
      pad(autoCell(r.io_low, r.rast_low, r.orig), 12, 'right'),
      pad(autoCell(r.io_medium, r.rast_medium, r.orig), 12, 'right'),
      pad(autoCell(r.io_high, r.rast_high, r.orig), 12, 'right'),
    ]
    console.log(cells.join(''))
  }
  console.log(`\nAuto cells: tag (I) = image-only chosen, (R) = rasterize chosen.`)
  console.log(`Output PDFs written to ${outDir}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
