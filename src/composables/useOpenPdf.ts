import { router } from '@/router'
import { ipcInvoke, nodePath, readFileAsArrayBuffer } from '@/utils/electron'
import { hideLoading, showLoading } from '@/composables/useLoading'
import { toast } from '@/composables/useToast'
import { addRecent } from '@/composables/useRecents'
import { usePdfStore } from '@/stores/pdf'
import { usePdfjs } from '@/composables/usePdfEngine'

interface OpenDialogResult {
  canceled: boolean
  filePaths: string[]
}

export async function pickAndOpenPdf(): Promise<void> {
  const r = await ipcInvoke<OpenDialogResult>('dialog:open', {
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (r.canceled || r.filePaths.length === 0) return
  await openPdfFromPath(r.filePaths[0])
}

export async function openPdfFromPath(filePath: string): Promise<void> {
  // Use the singleton router instance, not useRouter() — this function runs inside async
  // click handlers that fire after the component's setup() returns, so useRouter() would
  // see no active instance and return undefined.
  try {
    showLoading('Opening PDF...')
    const ab = await readFileAsArrayBuffer(filePath)
    await loadPdfBytes(ab, filePath)
    await router.push({ name: 'editor' })
    await addRecent(filePath)
  } catch (err) {
    console.error(err)
    const msg = err instanceof Error ? err.message : String(err)
    toast(`Failed to open PDF: ${msg}`, 'error')
  } finally {
    hideLoading()
  }
}

export async function loadPdfBytes(arrayBuffer: ArrayBuffer, filePath: string | null): Promise<void> {
  const pdfjs = usePdfjs()
  // pdf.js transfers the buffer it's given — keep an untouched copy in the store.
  const pdfjsCopy = arrayBuffer.slice(0)
  const doc = await pdfjs.getDocument({ data: pdfjsCopy }).promise
  const store = usePdfStore()
  store.resetForNewDocument(arrayBuffer, filePath, doc, doc.numPages)
}

export function basenameOf(filePath: string | null): string {
  if (!filePath) return 'untitled.pdf'
  return nodePath().basename(filePath)
}

export function dirnameOf(filePath: string): string {
  return nodePath().dirname(filePath)
}
