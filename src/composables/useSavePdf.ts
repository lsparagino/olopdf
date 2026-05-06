// Output PDF assembly: copy pages in current order, draw per-page + repeat text,
// hand-build the /Outlines tree (pdf-lib has no high-level outline API).

import { usePdfStore, type Bookmark, type TextAnnotation } from '@/stores/pdf'
import { hideLoading, showLoading } from '@/composables/useLoading'
import { toast } from '@/composables/useToast'
import { hexToRgb01, pickStandardFont } from '@/utils/pdf'
import { fileExists, ipcInvoke, nodePath, writeFileBytes } from '@/utils/electron'

const pdfLib = (window as unknown as { require: (m: string) => typeof import('pdf-lib') }).require(
  'pdf-lib',
)
const { PDFDocument, rgb, PDFName, PDFString, PDFArray, PDFNumber, degrees } = pdfLib

interface SaveDialogResult {
  canceled: boolean
  filePath?: string
}

interface OutlineItem {
  title: string
  pageIndex: number
  x?: number
  y?: number
  level: number
}

export async function savePdf(): Promise<void> {
  const pdf = usePdfStore()
  if (!pdf.pdfBytes) return
  try {
    const path = nodePath()
    const defaultPath = await suggestSavePath(pdf.filePath)
    const r = await ipcInvoke<SaveDialogResult>('dialog:save', {
      defaultPath,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (r.canceled || !r.filePath) return

    showLoading('Saving PDF...')
    const srcDoc = await PDFDocument.load(pdf.pdfBytes)
    const newDoc = await PDFDocument.create()

    type StandardFontName = ReturnType<typeof pickStandardFont>
    type EmbeddedFont = Awaited<ReturnType<typeof newDoc.embedFont>>
    const fontCache = new Map<StandardFontName, EmbeddedFont>()
    async function getFont(name: StandardFontName): Promise<EmbeddedFont> {
      const cached = fontCache.get(name)
      if (cached) return cached
      const f = await newDoc.embedFont(name)
      fontCache.set(name, f)
      return f
    }

    const copied = await newDoc.copyPages(srcDoc, pdf.pageOrder)
    const origToNewIdx = new Map<number, number>()
    copied.forEach((p, i) => {
      newDoc.addPage(p)
      origToNewIdx.set(pdf.pageOrder[i], i)
      const rot = pdf.rotationFor(pdf.pageOrder[i])
      if (rot !== 0) p.setRotation(degrees(rot))
    })

    for (const a of pdf.textAnnotations) {
      const newIdx = origToNewIdx.get(a.pageOriginalIdx ?? -1)
      if (newIdx === undefined) continue
      await drawTextOnPage(newDoc.getPage(newIdx), a, getFont)
    }
    if (pdf.repeatTexts.length > 0) {
      for (let pi = 0; pi < newDoc.getPageCount(); pi++) {
        const page = newDoc.getPage(pi)
        for (const a of pdf.repeatTexts) await drawTextOnPage(page, a, getFont)
      }
    }
    if (pdf.bookmarks.length > 0) {
      const items: OutlineItem[] = pdf.bookmarks
        .map((b: Bookmark) => ({
          title: b.title,
          pageIndex: origToNewIdx.get(b.pageOriginalIdx) as number,
          x: b.x,
          y: b.y,
          level: b.level,
        }))
        .filter((it) => it.pageIndex !== undefined)
      // Bookmarks pointing to deleted pages were filtered out; re-clamp levels so
      // the surviving list still has no gap (a level-2 with no level-1 ancestor).
      let prev = -1
      for (const it of items) {
        const max = prev + 1
        if (it.level > max) it.level = max
        if (it.level < 0) it.level = 0
        prev = it.level
      }
      addOutline(newDoc, items)
    }

    const out = await newDoc.save()
    await writeFileBytes(r.filePath, out)
    hideLoading()
    toast(`Saved to ${path.basename(r.filePath)}`, 'success')
  } catch (err) {
    console.error(err)
    hideLoading()
    const msg = err instanceof Error ? err.message : String(err)
    toast(`Save failed: ${msg}`, 'error')
  }
}

type AnyPdfDoc = Awaited<ReturnType<typeof PDFDocument.create>>
type AnyPdfPage = ReturnType<AnyPdfDoc['getPage']>
type GetFont = (
  name: ReturnType<typeof pickStandardFont>,
) => Promise<Awaited<ReturnType<AnyPdfDoc['embedFont']>>>

// Build a default save path that won't clobber an existing file. We never want
// the dialog to pre-fill with the source path, and we don't want a second save
// to silently overwrite the previous edited copy either — bump a counter until
// we find a free name.
async function suggestSavePath(sourcePath: string | null): Promise<string> {
  const path = nodePath()
  if (!sourcePath) return 'edited.pdf'
  const dir = path.dirname(sourcePath)
  const base = path.basename(sourcePath).replace(/\.pdf$/i, '')
  let candidate = path.join(dir, `${base}-edited.pdf`)
  let n = 2
  while (await fileExists(candidate)) {
    candidate = path.join(dir, `${base}-edited (${n}).pdf`)
    n++
  }
  return candidate
}

async function drawTextOnPage(
  page: AnyPdfPage,
  a: TextAnnotation,
  getFont: GetFont,
): Promise<void> {
  const fontName = pickStandardFont(a.font || 'helvetica', !!a.bold, !!a.italic)
  const font = await getFont(fontName)
  const { height } = page.getSize()
  const { r, g, b } = hexToRgb01(a.color)
  const baselineY = height - a.y - a.size
  page.drawText(a.text, {
    x: a.x,
    y: baselineY,
    size: a.size,
    font,
    color: rgb(r, g, b),
  })
  if (a.underline) {
    let textWidth: number
    try {
      textWidth = font.widthOfTextAtSize(a.text, a.size)
    } catch {
      textWidth = a.text.length * a.size * 0.5
    }
    const ulY = baselineY - Math.max(1, a.size * 0.08)
    page.drawLine({
      start: { x: a.x, y: ulY },
      end: { x: a.x + textWidth, y: ulY },
      thickness: Math.max(0.5, a.size * 0.06),
      color: rgb(r, g, b),
    })
  }
}

// Build the PDF /Outlines tree from a flat list of items + levels. PDF's outline
// is a doubly-linked sibling list at each depth, with each non-leaf pointing at
// First/Last children. We walk the flat list maintaining a stack of "last item
// seen at each depth" to wire up Parent/First/Last/Prev/Next/Count refs.
function addOutline(pdfDoc: AnyPdfDoc, items: OutlineItem[]): void {
  if (items.length === 0) return
  const ctx = pdfDoc.context
  const outlinesRef = ctx.nextRef()
  const itemRefs = items.map(() => ctx.nextRef())

  // -1 means "child of /Outlines root"
  const parentIdx: number[] = items.map(() => -1)
  const childIndices: number[][] = items.map(() => [] as number[])
  const topLevel: number[] = []

  const stack: number[] = []
  items.forEach((it, i) => {
    stack.length = it.level
    if (it.level === 0 || stack[it.level - 1] === undefined) {
      topLevel.push(i)
    } else {
      const p = stack[it.level - 1]
      parentIdx[i] = p
      childIndices[p].push(i)
    }
    stack[it.level] = i
  })

  function descendantCount(i: number): number {
    let n = childIndices[i].length
    for (const c of childIndices[i]) n += descendantCount(c)
    return n
  }

  function destFor(it: OutlineItem) {
    const page = pdfDoc.getPage(it.pageIndex)
    const { height } = page.getSize()
    const dest = PDFArray.withContext(ctx)
    dest.push(page.ref)
    dest.push(PDFName.of('XYZ'))
    if (it.x !== undefined && it.y !== undefined) {
      dest.push(PDFNumber.of(it.x))
      dest.push(PDFNumber.of(height - it.y))
      dest.push(ctx.obj(null))
    } else {
      dest.push(ctx.obj(null))
      dest.push(ctx.obj(null))
      dest.push(ctx.obj(null))
    }
    return dest
  }

  items.forEach((it, i) => {
    const dict = ctx.obj({
      Title: PDFString.of(it.title),
      Parent: parentIdx[i] >= 0 ? itemRefs[parentIdx[i]] : outlinesRef,
      Dest: destFor(it),
    })
    const sibs = parentIdx[i] >= 0 ? childIndices[parentIdx[i]] : topLevel
    const pos = sibs.indexOf(i)
    if (pos > 0) dict.set(PDFName.of('Prev'), itemRefs[sibs[pos - 1]])
    if (pos >= 0 && pos < sibs.length - 1) {
      dict.set(PDFName.of('Next'), itemRefs[sibs[pos + 1]])
    }
    const kids = childIndices[i]
    if (kids.length > 0) {
      dict.set(PDFName.of('First'), itemRefs[kids[0]])
      dict.set(PDFName.of('Last'), itemRefs[kids[kids.length - 1]])
      // Positive count = open by default so all descendants render expanded.
      dict.set(PDFName.of('Count'), PDFNumber.of(descendantCount(i)))
    }
    ctx.assign(itemRefs[i], dict)
  })

  ctx.assign(
    outlinesRef,
    ctx.obj({
      Type: PDFName.of('Outlines'),
      First: itemRefs[topLevel[0]],
      Last: itemRefs[topLevel[topLevel.length - 1]],
      Count: items.length,
    }),
  )
  pdfDoc.catalog.set(PDFName.of('Outlines'), outlinesRef)
  pdfDoc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'))
}
