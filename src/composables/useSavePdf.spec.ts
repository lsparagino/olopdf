/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import nodePathModule from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const nodeRequire = createRequire(import.meta.url)
vi.stubGlobal('window', { require: nodeRequire })

const electron = vi.hoisted(() => ({
  ipcInvoke: vi.fn(),
  writeFileBytes: vi.fn(),
  fileExists: vi.fn(),
}))

vi.mock('@/utils/electron', () => ({
  ipcInvoke: electron.ipcInvoke,
  writeFileBytes: electron.writeFileBytes,
  fileExists: electron.fileExists,
  nodePath: () => nodePathModule,
}))

const { PDFDocument } = nodeRequire('pdf-lib') as typeof import('pdf-lib')

let save: typeof import('@/composables/useSavePdf')
let store: typeof import('@/stores/pdf')
let toasts: typeof import('@/composables/useToast')
beforeAll(async () => {
  save = await import('@/composables/useSavePdf')
  store = await import('@/stores/pdf')
  toasts = await import('@/composables/useToast')
})

beforeEach(() => {
  setActivePinia(createPinia())
  electron.ipcInvoke.mockReset().mockResolvedValue({ canceled: false, filePath: 'C:\\out\\edited.pdf' })
  electron.writeFileBytes.mockReset().mockResolvedValue(true)
  electron.fileExists.mockReset().mockResolvedValue(false)
  for (const t of [...toasts.useToast().toasts.value]) toasts.dismissToast(t.id)
})

function fixture(name: string): ArrayBuffer {
  const buf = readFileSync(fileURLToPath(new URL(`../utils/fixtures/encryption/${name}`, import.meta.url)))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

describe('savePdf', () => {
  it('saves the pages in the order the editor holds', async () => {
    const pdf = store.usePdfStore()
    pdf.pdfBytes = fixture('plain.pdf')
    pdf.pageOrder = [1, 0]

    await save.savePdf()

    const written = electron.writeFileBytes.mock.calls[0][1] as Uint8Array
    expect((await PDFDocument.load(written)).getPageCount()).toBe(2)
  })

  // pdf.js renders placeholder pages for parts of a damaged file that pdf-lib
  // can't reach, so pageOrder can outrun the document pdf-lib gives us.
  it('drops page indices the source document does not have, and says so', async () => {
    const pdf = store.usePdfStore()
    pdf.pdfBytes = fixture('plain.pdf')
    pdf.pageOrder = [0, 1, 2, 3]

    await save.savePdf()

    const written = electron.writeFileBytes.mock.calls[0][1] as Uint8Array
    expect((await PDFDocument.load(written)).getPageCount()).toBe(2)
    expect(toasts.useToast().toasts.value.map((t) => [t.kind, t.message])).toContainEqual([
      'warn',
      "2 damaged pages couldn't be saved",
    ])
  })
})
