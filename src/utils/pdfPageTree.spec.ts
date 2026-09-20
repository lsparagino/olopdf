/// <reference types="node" />
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// The module under test loads pdf-lib through window.require, which only
// exists in the Electron renderer.
const nodeRequire = createRequire(import.meta.url)
vi.stubGlobal('window', { require: nodeRequire })

const pdfLib = nodeRequire('pdf-lib') as typeof import('pdf-lib')
const { PDFDocument } = pdfLib

let mod: typeof import('@/utils/pdfPageTree')
beforeAll(async () => {
  mod = await import('@/utils/pdfPageTree')
})

// pdf-lib parses objects front to back and needs no xref table, which keeps
// these hand-written damaged files short.
function pdf(objects: string[], root = '1 0 R'): Uint8Array {
  const body = objects.map((obj, i) => `${i + 1} 0 obj\n${obj}\nendobj\n`).join('')
  return new TextEncoder().encode(`%PDF-1.7\n${body}trailer\n<< /Root ${root} >>\n%%EOF\n`)
}

const CONTENT = '<< /Length 18 >>\nstream\n10 10 180 180 re S\nendstream'

// Three levels of /Pages nodes with three kids each (27 pages). Each
// first-level node sets its own /MediaBox and the root sets /Rotate, so every
// page inherits both. `untypedNode` drops /Type from that object.
function nestedTree(untypedNode?: number): Uint8Array {
  const objects = ['<< /Type /Catalog /Pages 3 0 R >>', CONTENT]
  function node(parent: number | null, depth: number, index: number): number {
    const num = objects.push('')
    if (depth === 3) {
      objects[num - 1] = `<< /Type /Page /Parent ${parent} 0 R /Contents 2 0 R >>`
      return num
    }
    const kids = [0, 1, 2].map((i) => `${node(num, depth + 1, i)} 0 R`)
    const entries = [
      num === untypedNode ? '' : '/Type /Pages',
      `/Kids [${kids.join(' ')}] /Count ${3 ** (3 - depth)}`,
      parent ? `/Parent ${parent} 0 R` : '',
      depth === 1 ? `/MediaBox [0 0 ${100 * (index + 1)} ${200 * (index + 1)}]` : '',
      depth === 0 ? '/Rotate 90' : '',
    ]
    objects[num - 1] = `<< ${entries.join(' ')} >>`
    return num
  }
  node(null, 0, 0)
  return pdf(objects)
}

function pageShapes(doc: import('pdf-lib').PDFDocument) {
  return doc.getPages().map((p) => ({ ...p.getSize(), rotation: p.getRotation().angle }))
}

async function loadAndRepair(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const repaired = mod.repairPageTree(doc)
  return { doc, repaired }
}

// The merge pipeline: every page copied into a fresh document and saved.
async function mergedPageCount(doc: import('pdf-lib').PDFDocument): Promise<number> {
  const out = await PDFDocument.create()
  const pages = await out.copyPages(doc, doc.getPageIndices())
  pages.forEach((p) => out.addPage(p))
  const reloaded = await PDFDocument.load(await out.save())
  return reloaded.getPageCount()
}

describe('repairPageTree', () => {
  it('leaves a well-formed document untouched', async () => {
    const src = await PDFDocument.create()
    src.addPage([200, 300])
    src.addPage([400, 500])
    const { doc, repaired } = await loadAndRepair(await src.save())
    expect(repaired).toBe(false)
    expect(doc.getPages().map((p) => p.getSize())).toEqual([
      { width: 200, height: 300 },
      { width: 400, height: 500 },
    ])
  })

  it('leaves a deep tree with inherited attributes untouched', async () => {
    const { doc, repaired } = await loadAndRepair(nestedTree())
    expect(repaired).toBe(false)
    expect(doc.getPageCount()).toBe(27)
  })

  it('rebuilds a deep tree around an untyped node with the same pages as the intact tree', async () => {
    const intact = await PDFDocument.load(nestedTree())
    // Object 9 is the second node on the third level, holding pages 4–6.
    const { doc, repaired } = await loadAndRepair(nestedTree(9))
    expect(repaired).toBe(true)
    expect(pageShapes(doc)).toEqual(pageShapes(intact))
    expect(await mergedPageCount(doc)).toBe(27)
  })

  it('reads a catalog that has no /Type', async () => {
    const { doc, repaired } = await loadAndRepair(
      pdf([
        '<< /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 200 50] >>',
        '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
        CONTENT,
      ]),
    )
    expect(repaired).toBe(true)
    expect(doc.getPage(0).getSize()).toEqual({ width: 200, height: 50 })
    expect(await mergedPageCount(doc)).toBe(1)
  })

  it('reads a catalog whose /Pages points straight at the page', async () => {
    const { doc, repaired } = await loadAndRepair(
      pdf([
        '<< /Type /Catalog /Pages 3 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>',
        CONTENT,
      ]),
    )
    expect(repaired).toBe(true)
    expect(await mergedPageCount(doc)).toBe(1)
  })

  it('ignores a /Parent that points outside the page tree', async () => {
    const { doc, repaired } = await loadAndRepair(
      pdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 600 800] >>',
        '<< /Type /Page /Parent 1 0 R /Contents 5 0 R >>',
        '<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>',
        CONTENT,
      ]),
    )
    expect(repaired).toBe(true)
    // The first page's /Parent chain has no /MediaBox; the tree it hangs from does.
    expect(doc.getPages().map((p) => p.getSize())).toEqual([
      { width: 600, height: 800 },
      { width: 600, height: 800 },
    ])
    expect(await mergedPageCount(doc)).toBe(2)
  })

  it('stops at a cycle in /Kids and keeps the pages outside it', async () => {
    const { doc, repaired } = await loadAndRepair(
      pdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R 4 0 R 6 0 R] /Count 2 /MediaBox [0 0 595 842] >>',
        '<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>',
        '<< /Type /Pages /Parent 2 0 R /Kids [5 0 R] /Count 1 >>',
        '<< /Type /Pages /Parent 4 0 R /Kids [4 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>',
        CONTENT,
      ]),
    )
    expect(repaired).toBe(true)
    expect(doc.getPageCount()).toBe(2)
    expect(await mergedPageCount(doc)).toBe(2)
  })

  it('finds pages under untyped nodes and keeps what they inherit', async () => {
    const { doc, repaired } = await loadAndRepair(
      pdf([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 3 /MediaBox [0 0 100 100] >>',
        '<< /Parent 2 0 R /Kids [4 0 R] /Count 1 /MediaBox [0 0 300 400] /Rotate 90 >>',
        '<< /Type /Page /Parent 3 0 R /Contents 6 0 R >>',
        '<< /Parent 2 0 R /Contents 6 0 R >>',
        CONTENT,
      ]),
    )
    expect(repaired).toBe(true)
    const pages = doc.getPages()
    expect(pages.map((p) => p.getSize())).toEqual([
      { width: 300, height: 400 },
      { width: 100, height: 100 },
    ])
    expect(pages.map((p) => p.getRotation().angle)).toEqual([90, 0])
    expect(await mergedPageCount(doc)).toBe(2)
  })

  it('leaves the document alone when no page can be found', async () => {
    const { doc, repaired } = await loadAndRepair(
      pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /S /JavaScript /JS (app.alert(1)) >>']),
    )
    expect(repaired).toBe(false)
    expect(String(doc.catalog.get(pdfLib.PDFName.of('Pages')))).toBe('2 0 R')
  })
})
