/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// The modules under test load pdf-lib through window.require, which only
// exists in the Electron renderer.
const nodeRequire = createRequire(import.meta.url)
vi.stubGlobal('window', { require: nodeRequire })

const { PDFDocument, PDFParser } = nodeRequire('pdf-lib') as typeof import('pdf-lib')

let mod: typeof import('@/utils/pdfEncryption')
beforeAll(async () => {
  mod = await import('@/utils/pdfEncryption')
})

// Each case reproduces one file from pdf.js's test corpus that pdf.js opens
// but pdf-lib rejects, cut down to the damage that matters.
const OBJECTS =
  '1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj\n' +
  '2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj\n' +
  '3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 200 50]/Contents 4 0 R>> endobj\n' +
  '4 0 obj <</Length 24>> stream\n0 0 1 rg 0 0 50 50 re f\nendstream endobj\n'
const XREF = 'xref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000055 00000 n \n0000000106 00000 n \n0000000187 00000 n \n'
const TRAILER = 'trailer <</Root 1 0 R/Size 5>>\nstartxref\n0\n%%EOF\n'

function latin1(text: string): Uint8Array {
  return Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 0xff)
}

// Runs the same load → copy → save steps as the merge.
async function mergedPageSizes(bytes: Uint8Array): Promise<number[][]> {
  const { doc } = await mod.loadPdfDocument(bytes)
  const out = await PDFDocument.create()
  for (const page of await out.copyPages(doc, doc.getPageIndices())) out.addPage(page)
  const merged = await PDFDocument.load(await out.save())
  return merged.getPages().map((page) => [page.getWidth(), page.getHeight()])
}

interface DamagedCase {
  name: string
  corpusFile: string
  bytes: Uint8Array
  size: number[]
}

const DAMAGED: DamagedCase[] = [
  {
    name: 'no %PDF header at all',
    corpusFile: 'bug1606566.pdf',
    bytes: latin1(`%\xe2\xe3\xcf\xd3\n${OBJECTS}${XREF}${TRAILER}`),
    size: [200, 50],
  },
  {
    name: 'a header with no minor version',
    corpusFile: 'issue9105_other.pdf',
    bytes: latin1(`%PDF-1.\n${OBJECTS}${XREF}${TRAILER}`),
    size: [200, 50],
  },
  {
    name: 'startxref with no offset',
    corpusFile: 'issue6069.pdf',
    bytes: latin1(`junk before the header\n%PDF-1.1\n${OBJECTS}${XREF}trailer <</Root 1 0 R/Size 5>>\nstartxref\n`),
    size: [200, 50],
  },
  {
    name: 'a trailer cut off inside a hex string',
    corpusFile: 'bug1250079.pdf',
    bytes: latin1(`%PDF-1.7\n${OBJECTS}${XREF}trailer\n<</Root 1 0 R/Size 5/ID [<904e5a16\xa4\x49\x9e\x40\xc1`),
    size: [200, 50],
  },
  {
    name: 'a damaged xref entry',
    corpusFile: 'poppler-937-0-fuzzed.pdf',
    bytes: latin1(`%PDF-1.4\n${OBJECTS}${XREF.replace('0000000055', '00000/0055')}${TRAILER}`),
    size: [200, 50],
  },
  {
    name: 'an inline catalog and a page tree without /Type, /Count or /MediaBox',
    corpusFile: 'issue9105_other.pdf',
    bytes: latin1(
      '%PDF-1.\n1 0 obj\n<</Kids[<</Parent 1 0 R/Contents[2 0 R]>>]/Resources<<>>>>\n' +
        '2 0 obj\n<<>>\nstream\n0 0 1 rg 0 0 50 50 re f\nendstream\nendobj\n' +
        'trailer<</Root<</Pages 1 0 R>>>>',
    ),
    size: [612, 792],
  },
]

describe('loadPdfDocument on damaged files', () => {
  it.each(DAMAGED)('merges a file with $name ($corpusFile)', async ({ bytes, size }) => {
    await expect(PDFDocument.load(bytes)).rejects.toThrow()
    expect(await mergedPageSizes(bytes)).toEqual([size])
  })

  it('still reports the original error when no page survives', async () => {
    // poppler-937-0-fuzzed.pdf: past the damaged xref, the page tree's /Kids
    // lost its "[" and the page's /MediaBox array never closes.
    const bytes = latin1(
      '%PDF-1.4\n1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj\n' +
        '2 0 obj <</Type/Pages/Kids \x003 0 R]/Count 1>> endobj\n' +
        '3 0 obj <</T\xecpe/Page/Parent 2 0 R/MediaBox [0 0L200 50;>> endobj\n' +
        `${XREF.replace('0000000055', '00000/0055')}${TRAILER}`,
    )
    const original = await PDFDocument.load(bytes).catch((err: Error) => err)
    await expect(mod.loadPdfDocument(bytes)).rejects.toThrow((original as Error).message)
  })

  it('gives up on input that is not a PDF without a second parse', async () => {
    const parse = vi.spyOn(PDFParser, 'forBytesWithOptions')
    const text = latin1('lorem ipsum 12 0 R dolor trailer xref\n'.repeat(1000))
    await expect(mod.loadPdfDocument(text)).rejects.toThrow(/No PDF header found/)
    expect(parse).toHaveBeenCalledTimes(1)
    parse.mockRestore()
  })

  // A damaged trailer takes /Encrypt with it, and copying the pages anyway
  // would produce ciphertext. Cut mupdf's inside its inline /Encrypt dict, and
  // pypdf's just before its /Encrypt reference to a separate object.
  it.each([
    ['mupdf-rc4-40.pdf', '/Encrypt<</Filter/Standard/R 2'],
    ['pypdf-aes-128.pdf', '/ID [ <1a33'],
  ])('leaves %s with a damaged trailer to the original error', async (name, cutAfter) => {
    const file = readFileSync(new URL(`./fixtures/encryption/${name}`, import.meta.url))
    const bytes = new Uint8Array(file.subarray(0, file.indexOf(cutAfter) + cutAfter.length))
    const original = await PDFDocument.load(bytes, { ignoreEncryption: true }).catch((err: Error) => err)
    expect(original).toBeInstanceOf(Error)
    await expect(mod.loadPdfDocument(bytes)).rejects.toThrow((original as Error).message)
  })
})
