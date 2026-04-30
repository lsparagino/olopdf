// Output PDF assembly: copy pages in current order, draw per-page + repeat text,
// hand-build the /Outlines tree (pdf-lib has no high-level outline API).

import { usePdfStore, type Bookmark, type TextAnnotation } from '@/stores/pdf'
import { hideLoading, showLoading } from '@/composables/useLoading'
import { toast } from '@/composables/useToast'
import { hexToRgb01, pickStandardFont } from '@/utils/pdf'
import { ipcInvoke, nodePath, writeFileBytes } from '@/utils/electron'

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
}

export async function savePdf(): Promise<void> {
  const pdf = usePdfStore()
  if (!pdf.pdfBytes) return
  try {
    const path = nodePath()
    const defaultName = pdf.filePath
      ? `${path.basename(pdf.filePath).replace(/\.pdf$/i, '')}-edited.pdf`
      : 'edited.pdf'
    const r = await ipcInvoke<SaveDialogResult>('dialog:save', {
      defaultPath: defaultName,
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
        }))
        .filter((it) => it.pageIndex !== undefined)
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

function addOutline(pdfDoc: AnyPdfDoc, items: OutlineItem[]): void {
  if (items.length === 0) return
  const ctx = pdfDoc.context
  const outlinesRef = ctx.nextRef()
  const itemRefs = items.map(() => ctx.nextRef())

  items.forEach((it, i) => {
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
    const dict = ctx.obj({
      Title: PDFString.of(it.title),
      Parent: outlinesRef,
      Dest: dest,
    })
    if (i > 0) dict.set(PDFName.of('Prev'), itemRefs[i - 1])
    if (i < items.length - 1) dict.set(PDFName.of('Next'), itemRefs[i + 1])
    ctx.assign(itemRefs[i], dict)
  })

  ctx.assign(
    outlinesRef,
    ctx.obj({
      Type: PDFName.of('Outlines'),
      First: itemRefs[0],
      Last: itemRefs[itemRefs.length - 1],
      Count: items.length,
    }),
  )
  pdfDoc.catalog.set(PDFName.of('Outlines'), outlinesRef)
  pdfDoc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'))
}
