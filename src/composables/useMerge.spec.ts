/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import nodePathModule from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// pdf-lib and crypto come in through window.require in the renderer.
const nodeRequire = createRequire(import.meta.url)
vi.stubGlobal('window', { require: nodeRequire })

const FIXTURES = fileURLToPath(new URL('../utils/fixtures/encryption/', import.meta.url))
const BUSY = 'C:\\locked\\busy.pdf'

const electron = vi.hoisted(() => ({
  ipcInvoke: vi.fn(),
  writeFileBytes: vi.fn(),
}))

vi.mock('@/utils/electron', () => ({
  ipcInvoke: electron.ipcInvoke,
  writeFileBytes: electron.writeFileBytes,
  nodePath: () => nodePathModule,
  async readFileAsArrayBuffer(path: string): Promise<ArrayBuffer> {
    if (path.endsWith('#slow')) {
      await new Promise((r) => setTimeout(r, 100))
      path = path.slice(0, -'#slow'.length)
    }
    // Mirrors how a locked file surfaces through the fs:readFile IPC handler.
    if (path === BUSY) {
      throw new Error(`Error invoking remote method 'fs:readFile': Error: EBUSY: resource busy or locked, open '${path}'`)
    }
    const buf = readFileSync(path)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  },
}))

// Lets a test hold one file's check open, as a large file would.
const loader = vi.hoisted(() => ({ hang: new Set<string>() }))
vi.mock('@/utils/pdfEncryption', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/pdfEncryption')>()
  return {
    ...actual,
    loadPdfDocument(bytes: ArrayBuffer | Uint8Array) {
      const size = String(bytes.byteLength)
      return loader.hang.has(size) ? new Promise(() => {}) : actual.loadPdfDocument(bytes)
    },
  }
})

const { PDFDocument } = nodeRequire('pdf-lib') as typeof import('pdf-lib')

let merge: typeof import('@/composables/useMerge')
let store: typeof import('@/stores/pdf')
let toasts: typeof import('@/composables/useToast')
beforeAll(async () => {
  merge = await import('@/composables/useMerge')
  store = await import('@/stores/pdf')
  toasts = await import('@/composables/useToast')
})

beforeEach(() => {
  setActivePinia(createPinia())
  electron.ipcInvoke.mockReset()
  electron.writeFileBytes.mockReset()
  loader.hang.clear()
  for (const t of [...toasts.useToast().toasts.value]) toasts.dismissToast(t.id)
})

function source(name: string) {
  return { name, path: nodePathModule.join(FIXTURES, name) }
}

async function settled() {
  const pdf = store.usePdfStore()
  await vi.waitFor(() => expect(pdf.mergeFiles.some((f) => f.status === 'checking')).toBe(false), {
    timeout: 10_000,
  })
  return pdf.mergeFiles
}

describe('adding files to merge', () => {
  it('checks each file and keeps the reason on the file that fails', async () => {
    await merge.addMergeFiles([
      source('plain.pdf'),
      source('mupdf-aes-256-objstm.pdf'),
      source('mupdf-aes-256-user-password.pdf'),
      { name: 'busy.pdf', path: BUSY },
      { name: 'not-a-pdf.pdf', path: fileURLToPath(import.meta.url) },
    ])
    const files = await settled()
    const byName = Object.fromEntries(files.map((f) => [f.name, f]))

    expect(byName['plain.pdf']).toMatchObject({ status: 'ready', pageCount: 2, unlocked: false })
    expect(byName['mupdf-aes-256-objstm.pdf']).toMatchObject({ status: 'ready', pageCount: 2, unlocked: true })
    expect(byName['mupdf-aes-256-user-password.pdf']).toMatchObject({
      status: 'error',
      error: 'the file is password-protected',
    })
    expect(byName['busy.pdf']).toMatchObject({
      status: 'error',
      error: "couldn't read the file: the file is open in another program — close it and try again",
    })
    expect(byName['not-a-pdf.pdf']).toMatchObject({ status: 'error', error: "this isn't a PDF file" })
  })
})

describe('list changes while files are being checked', () => {
  it('removing the file being checked frees the queue for the next one', async () => {
    const stuck = source('mupdf-rc4-128.pdf')
    loader.hang.add(String(readFileSync(stuck.path).byteLength))
    await merge.addMergeFiles([stuck, source('plain.pdf')])
    const pdf = store.usePdfStore()
    const stuckId = pdf.mergeFiles.find((f) => f.name === stuck.name)!.id

    merge.removeMergeFile(stuckId)
    const files = await settled()
    expect(files.map((f) => [f.name, f.status])).toEqual([['plain.pdf', 'ready']])
  })

  it('resetting the list drops files still being read from the old batch', async () => {
    const pending = merge.addMergeFiles([
      { name: 'old-1.pdf', path: source('plain.pdf').path + '#slow' },
      { name: 'old-2.pdf', path: source('plain.pdf').path + '#slow' },
    ])
    merge.resetMergeFiles()
    await merge.addMergeFiles([source('mupdf-rc4-40.pdf')])
    await pending
    const files = await settled()
    expect(files.map((f) => f.name)).toEqual(['mupdf-rc4-40.pdf'])
  })
})

describe('dropping files', () => {
  it('says which dropped items were skipped instead of ignoring them', () => {
    const dropped = [new File([], 'a.pdf'), new File([], 'Invoices'), new File([], 'scan.PDF')]
    expect(merge.keepPdfFiles(dropped).map((f) => f.name)).toEqual(['a.pdf', 'scan.PDF'])
    expect(toasts.useToast().toasts.value.map((t) => [t.kind, t.message])).toEqual([
      ['warn', "Skipped Invoices: it isn't a PDF file"],
    ])
  })
})

describe('performMerge', () => {
  it('refuses to start while any file is marked as failing', async () => {
    await merge.addMergeFiles([source('plain.pdf'), source('mupdf-aes-256-user-password.pdf')])
    await settled()
    await merge.performMerge()
    expect(electron.ipcInvoke).not.toHaveBeenCalled()
  })

  it('merges the remaining files once the failing ones are removed', async () => {
    await merge.addMergeFiles([
      source('plain.pdf'),
      source('mupdf-rc4-40.pdf'),
      source('mupdf-aes-256-user-password.pdf'),
    ])
    await settled()
    merge.removeFailedMergeFiles()
    electron.ipcInvoke.mockResolvedValue({ canceled: false, filePath: 'C:\\out\\merged.pdf' })
    electron.writeFileBytes.mockResolvedValue(true)

    await merge.performMerge()

    expect(electron.writeFileBytes).toHaveBeenCalledOnce()
    const written = electron.writeFileBytes.mock.calls[0][1] as Uint8Array
    const merged = await PDFDocument.load(written)
    expect(merged.getPageCount()).toBe(4)
    expect(merged.isEncrypted).toBe(false)
  })

  it('says the output file is locked instead of blaming an input', async () => {
    await merge.addMergeFiles([source('plain.pdf'), source('pypdf-aes-128.pdf')])
    await settled()
    electron.ipcInvoke.mockResolvedValue({ canceled: false, filePath: 'C:\\out\\merged.pdf' })
    electron.writeFileBytes.mockRejectedValue(
      new Error("Error invoking remote method 'fs:writeFile': Error: EBUSY: resource busy or locked, open 'C:\\out\\merged.pdf'"),
    )

    await merge.performMerge()

    const errors = toasts.useToast().toasts.value.filter((t) => t.kind === 'error')
    expect(errors.map((t) => t.message)).toEqual([
      "Couldn't save the merged PDF: the file is open in another program — close it and try again",
    ])
    expect(store.usePdfStore().mergeFiles.every((f) => f.status === 'ready')).toBe(true)
  })
})
