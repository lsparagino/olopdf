import type { PDFDocumentProxy } from 'pdfjs-dist'
import { router } from '@/router'
import { ipcInvoke, nodePath, readFileAsArrayBuffer } from '@/utils/electron'
import { hideLoading, showLoading } from '@/composables/useLoading'
import { toast } from '@/composables/useToast'
import { addRecent } from '@/composables/useRecents'
import { type Bookmark, usePdfStore } from '@/stores/pdf'
import { usePdfjs } from '@/composables/usePdfEngine'
import { resetPageMetrics } from '@/composables/usePageMetrics'
import { resetViewerScroll } from '@/composables/useViewerScroll'

interface OutlineNode {
  title: string
  dest: string | unknown[] | null
  items: OutlineNode[]
}

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
  // The viewer's geometry caches are module singletons that outlive the editor
  // screen, so clear them here rather than relying on the screen remounting —
  // opening a document from within the editor never unmounts it.
  resetPageMetrics()
  resetViewerScroll()
  // Read the source PDF's existing /Outlines tree (if any) and seed the store
  // so the bookmarks panel reflects what the file already has.
  const imported = await importBookmarksFromOutline(doc)
  if (imported.length > 0) {
    store.bookmarks = imported
    store.sortBookmarks()
    store.normalizeBookmarkLevels()
  }
}

async function importBookmarksFromOutline(doc: PDFDocumentProxy): Promise<Bookmark[]> {
  let outline: OutlineNode[] | null = null
  try {
    outline = (await doc.getOutline()) as OutlineNode[] | null
  } catch {
    return []
  }
  if (!outline || outline.length === 0) return []
  const out: Bookmark[] = []
  await walkOutline(doc, outline, 0, out)
  return out
}

async function walkOutline(
  doc: PDFDocumentProxy,
  items: OutlineNode[],
  level: number,
  out: Bookmark[],
): Promise<void> {
  for (const item of items) {
    const resolved = await resolveOutlineDestination(doc, item.dest)
    if (resolved) {
      out.push({
        title: item.title || 'Untitled',
        pageOriginalIdx: resolved.pageOriginalIdx,
        level,
        ...(resolved.x !== undefined && resolved.y !== undefined
          ? { x: resolved.x, y: resolved.y }
          : {}),
      })
    }
    if (Array.isArray(item.items) && item.items.length > 0) {
      await walkOutline(doc, item.items, level + 1, out)
    }
  }
}

async function resolveOutlineDestination(
  doc: PDFDocumentProxy,
  dest: OutlineNode['dest'],
): Promise<{ pageOriginalIdx: number; x?: number; y?: number } | null> {
  if (!dest) return null
  try {
    const arr = typeof dest === 'string' ? await doc.getDestination(dest) : dest
    if (!Array.isArray(arr) || arr.length === 0) return null
    const ref = arr[0]
    const pageOriginalIdx = await doc.getPageIndex(ref as Parameters<PDFDocumentProxy['getPageIndex']>[0])
    const fitMode = arr[1] as { name?: string } | null
    // /XYZ destinations carry an explicit (x, y) in PDF user space (bottom-left).
    // Flip Y to our top-left convention so gotoBookmark can scroll to it.
    if (
      fitMode?.name === 'XYZ' &&
      typeof arr[2] === 'number' &&
      typeof arr[3] === 'number'
    ) {
      const page = await doc.getPage(pageOriginalIdx + 1)
      const vp = page.getViewport({ scale: 1 })
      return { pageOriginalIdx, x: arr[2], y: vp.height - arr[3] }
    }
    return { pageOriginalIdx }
  } catch {
    return null
  }
}

export function basenameOf(filePath: string | null): string {
  if (!filePath) return 'untitled.pdf'
  return nodePath().basename(filePath)
}

export function dirnameOf(filePath: string): string {
  return nodePath().dirname(filePath)
}
