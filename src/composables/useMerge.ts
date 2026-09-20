// Merge mode: collect PDFs, drag-reorder, then output a merged PDF via pdf-lib.

import { usePdfStore, type MergeFile } from '@/stores/pdf'
import { hideLoading, showLoading } from '@/composables/useLoading'
import { toast } from '@/composables/useToast'
import { ipcInvoke, nodePath, readFileAsArrayBuffer, writeFileBytes } from '@/utils/electron'
import { describeError } from '@/utils/errors'
import { loadPdfDocument } from '@/utils/pdfEncryption'

const pdfLib = (window as unknown as { require: (m: string) => typeof import('pdf-lib') }).require(
  'pdf-lib',
)
const { PDFDocument } = pdfLib

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

export interface MergeSource {
  name: string
  path: string
}

interface ActiveCheck {
  id: number
  release: () => void
}

let nextMergeId = 1
// Bumped whenever the list is reset, so reads still in flight from an
// abandoned batch don't land in the new list.
let mergeSession = 0
let checkRunning = false
let activeCheck: ActiveCheck | null = null

// Drops anything that isn't a .pdf, and says so: a silently ignored drop (a
// folder, a file with another extension) looks exactly like a broken app.
export function keepPdfFiles<T extends File>(files: Iterable<T>): T[] {
  const all = Array.from(files)
  const pdfs = all.filter((f) => f.name.toLowerCase().endsWith('.pdf'))
  const skipped = all.filter((f) => !pdfs.includes(f)).map((f) => f.name)
  if (skipped.length === 1) toast(`Skipped ${skipped[0]}: it isn't a PDF file`, 'warn')
  else if (skipped.length > 1) toast(`Skipped ${skipped.length} items that aren't PDF files: ${skipped.join(', ')}`, 'warn')
  return pdfs
}

export async function appendFilesFromDrop(files: FileList | File[]): Promise<void> {
  const pdfs = keepPdfFiles(Array.from(files) as FileWithPath[])
  await addMergeFiles(pdfs.map((f) => ({ name: f.name, path: f.path })))
}

export async function pickAndAppendFiles(): Promise<void> {
  const r = await ipcInvoke<OpenDialogResult>('dialog:open', {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (r.canceled) return
  const path = nodePath()
  await addMergeFiles(r.filePaths.map((fp) => ({ name: path.basename(fp), path: fp })))
}

// A file that can't even be read still gets a row, marked with the reason, so
// it never silently goes missing from the list.
export async function addMergeFiles(sources: MergeSource[]): Promise<void> {
  const pdf = usePdfStore()
  const session = mergeSession
  for (const source of sources) {
    const file: MergeFile = { id: nextMergeId++, name: source.name, bytes: new ArrayBuffer(0), status: 'checking' }
    try {
      file.bytes = await readFileAsArrayBuffer(source.path)
    } catch (err) {
      file.status = 'error'
      file.error = `couldn't read the file: ${describeError(err)}`
    }
    if (session !== mergeSession) return
    pdf.mergeFiles.push(file)
  }
  void checkPendingFiles()
}

export function resetMergeFiles(): void {
  mergeSession++
  usePdfStore().mergeFiles = []
  activeCheck?.release()
}

export function removeMergeFile(id: number): void {
  const pdf = usePdfStore()
  pdf.mergeFiles = pdf.mergeFiles.filter((f) => f.id !== id)
  if (activeCheck?.id === id) activeCheck.release()
}

export function removeFailedMergeFiles(): void {
  const pdf = usePdfStore()
  pdf.mergeFiles = pdf.mergeFiles.filter((f) => f.status !== 'error')
}

export function moveMergeItem(src: number, dest: number): void {
  const pdf = usePdfStore()
  const [moved] = pdf.mergeFiles.splice(src, 1)
  let target = dest
  if (src < target) target -= 1
  pdf.mergeFiles.splice(target, 0, moved)
}

// One file at a time, in list order: each check parses the whole document, and
// running them concurrently would only contend for the same renderer thread.
async function checkPendingFiles(): Promise<void> {
  if (checkRunning) return
  checkRunning = true
  try {
    const pdf = usePdfStore()
    let next: MergeFile | undefined
    while ((next = pdf.mergeFiles.find((f) => f.status === 'checking'))) {
      const file = next
      // Removing the file (or resetting the list) mid-check releases the queue
      // rather than making every later file wait on a result nobody will see.
      // The abandoned check finishes in the background on a detached object.
      const released = new Promise<void>((resolve) => {
        activeCheck = { id: file.id, release: resolve }
      })
      await Promise.race([checkMergeFile(file), released])
    }
  } finally {
    activeCheck = null
    checkRunning = false
  }
}

// Runs the file through the same load → copy → save steps as the real merge,
// on its own, so a file that would break the merge is flagged with its own
// reason before the user clicks Merge — rather than failing the whole merge
// with no clue which file caused it.
async function checkMergeFile(file: MergeFile): Promise<void> {
  let loaded = false
  try {
    const { doc, decrypted, repaired } = await loadPdfDocument(file.bytes)
    loaded = true
    const pageCount = doc.getPageCount()
    if (pageCount === 0) throw new Error('no pages found')
    const scratch = await PDFDocument.create()
    const pages = await scratch.copyPages(doc, doc.getPageIndices())
    pages.forEach((p) => scratch.addPage(p))
    await scratch.save()
    Object.assign(file, { status: 'ready', pageCount, unlocked: decrypted, repaired })
  } catch (err) {
    console.error(`[merge] check failed for ${file.name}`, err)
    Object.assign(file, { status: 'error', error: describeFileError(err, loaded) })
  }
}

// pdf-lib reports damage in its own terms ("_this.catalog.Pages is not a
// function"); naming the step that failed is what tells the user it's the file.
function describeFileError(err: unknown, loaded: boolean): string {
  return describeError(err, (raw) =>
    loaded ? `the file's page structure is damaged — ${raw}` : `the file is damaged and couldn't be read — ${raw}`,
  )
}

export async function performMerge(): Promise<void> {
  const pdf = usePdfStore()
  const files = [...pdf.mergeFiles]
  if (files.length < 2 || files.some((f) => f.status !== 'ready')) return
  let current: MergeFile | null = null
  let loaded = false
  try {
    const r = await ipcInvoke<SaveDialogResult>('dialog:save', {
      defaultPath: 'merged.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (r.canceled || !r.filePath) return
    showLoading('Merging PDFs...')
    const out = await PDFDocument.create()
    for (const f of files) {
      current = f
      loaded = false
      const { doc } = await loadPdfDocument(f.bytes)
      loaded = true
      const pages = await out.copyPages(doc, doc.getPageIndices())
      pages.forEach((p) => out.addPage(p))
    }
    current = null
    const bytes = await out.save()
    await writeFileBytes(r.filePath, bytes)
    hideLoading()
    toast(`Merged ${files.length} files into ${nodePath().basename(r.filePath)}`, 'success')
  } catch (err) {
    console.error(err)
    hideLoading()
    if (current) {
      const reason = describeFileError(err, loaded)
      Object.assign(current, { status: 'error', error: reason })
      toast(`Couldn't merge ${current.name}: ${reason}`, 'error', { sticky: true })
    } else {
      toast(`Couldn't save the merged PDF: ${describeError(err)}`, 'error', { sticky: true })
    }
  }
}
