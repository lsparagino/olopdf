// Merge mode: collect PDFs, drag-reorder, then output a merged PDF via pdf-lib.

import { usePdfStore, type MergeFile } from '@/stores/pdf'
import { hideLoading, showLoading } from '@/composables/useLoading'
import { toast } from '@/composables/useToast'
import { ipcInvoke, nodePath, readFileAsArrayBuffer, writeFileBytes } from '@/utils/electron'

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

export async function appendFilesFromDrop(files: FileList | File[]): Promise<MergeFile[]> {
  const pdf = usePdfStore()
  const filtered = Array.from(files).filter((f) => f.name.toLowerCase().endsWith('.pdf')) as FileWithPath[]
  const added: MergeFile[] = []
  for (const f of filtered) {
    const bytes = await readFileAsArrayBuffer(f.path)
    const m: MergeFile = { name: f.name, bytes }
    pdf.mergeFiles.push(m)
    added.push(m)
  }
  return added
}

export async function pickAndAppendFiles(): Promise<void> {
  const r = await ipcInvoke<OpenDialogResult>('dialog:open', {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (r.canceled) return
  const pdf = usePdfStore()
  const path = nodePath()
  for (const fp of r.filePaths) {
    const bytes = await readFileAsArrayBuffer(fp)
    pdf.mergeFiles.push({ name: path.basename(fp), bytes })
  }
}

export function moveMergeItem(src: number, dest: number): void {
  const pdf = usePdfStore()
  const [moved] = pdf.mergeFiles.splice(src, 1)
  let target = dest
  if (src < target) target -= 1
  pdf.mergeFiles.splice(target, 0, moved)
}

export async function performMerge(): Promise<void> {
  const pdf = usePdfStore()
  if (pdf.mergeFiles.length < 2) return
  try {
    const r = await ipcInvoke<SaveDialogResult>('dialog:save', {
      defaultPath: 'merged.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (r.canceled || !r.filePath) return
    showLoading('Merging PDFs...')
    const out = await PDFDocument.create()
    for (const f of pdf.mergeFiles) {
      const src = await PDFDocument.load(f.bytes)
      const pages = await out.copyPages(src, src.getPageIndices())
      pages.forEach((p) => out.addPage(p))
    }
    const bytes = await out.save()
    await writeFileBytes(r.filePath, bytes)
    hideLoading()
    toast(`Merged ${pdf.mergeFiles.length} files`, 'success')
  } catch (err) {
    console.error(err)
    hideLoading()
    const msg = err instanceof Error ? err.message : String(err)
    toast(`Merge failed: ${msg}`, 'error')
  }
}
