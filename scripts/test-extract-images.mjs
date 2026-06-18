// Extract every image XObject from a PDF, write the raw stream bytes plus a
// dict-key dump so we can compare before/after a compression run side-by-side.
//
// Usage: node scripts/test-extract-images.mjs <pdf-path> [out-prefix]
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const require = createRequire(import.meta.url)
const { PDFDocument, PDFName, PDFRawStream } = require('pdf-lib')

const pdfPath = process.argv[2]
if (!pdfPath) {
  console.error('Usage: node scripts/test-extract-images.mjs <pdf-path> [out-prefix]')
  process.exit(1)
}
const prefix = process.argv[3] || path.parse(pdfPath).name
const outDir = path.join(root, 'test_pdfs', '_images', prefix)
await mkdir(outDir, { recursive: true })

const src = await readFile(pdfPath)
const doc = await PDFDocument.load(src)
const ctx = doc.context

function dictKeysToText(dict) {
  const keys = []
  for (const k of dict.keys()) {
    const v = dict.lookup(k)
    const vText = v ? v.toString().slice(0, 80) : 'undefined'
    keys.push(`  ${k.toString()} = ${vText}`)
  }
  return keys.join('\n')
}

const report = []
let idx = 0
for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
  if (!(obj instanceof PDFRawStream)) continue
  const subtype = obj.dict.lookup(PDFName.of('Subtype'))
  if (!subtype || subtype.toString() !== '/Image') continue
  idx++
  const dictDump = dictKeysToText(obj.dict)
  const bytes = obj.getContents()
  const refNum = `${ref.objectNumber}.${ref.generationNumber}`
  const ext = obj.dict.lookup(PDFName.of('Filter'))?.toString().includes('DCTDecode')
    ? 'jpg'
    : 'bin'
  const name = `${String(idx).padStart(2, '0')}_obj${refNum}.${ext}`
  await writeFile(path.join(outDir, name), bytes)
  report.push(`--- Image #${idx} (obj ${refNum}, ${bytes.length} bytes, ${ext}) ---\n${dictDump}\n`)
}

await writeFile(path.join(outDir, '_report.txt'), report.join('\n'))
console.log(`Wrote ${idx} images and report to ${outDir}`)
