import { usePdfStore } from '@/stores/pdf'

interface PdfPageLike {
  getViewport(opts: { scale: number; rotation?: number }): { width: number; height: number }
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): {
    promise: Promise<void>
  }
}

export async function paintThumb(
  canvas: HTMLCanvasElement,
  origIdx: number,
  targetWidth: number,
): Promise<void> {
  const pdf = usePdfStore()
  const wrap = canvas.parentElement
  const cached = pdf.thumbCache.get(origIdx)
  if (cached) {
    const img = new Image()
    img.onload = () => {
      canvas.width = img.width
      canvas.height = img.height
      if (wrap) wrap.style.aspectRatio = `${img.width} / ${img.height}`
      canvas.getContext('2d')?.drawImage(img, 0, 0)
    }
    img.src = cached
    return
  }
  if (!pdf.pdfjsDoc) return
  try {
    const page = (await pdf.pdfjsDoc.getPage(origIdx + 1)) as PdfPageLike
    const rotation = pdf.rotationFor(origIdx)
    const vp1 = page.getViewport({ scale: 1, rotation })
    const scale = targetWidth / vp1.width
    const viewport = page.getViewport({ scale, rotation })
    const w = Math.floor(viewport.width)
    const h = Math.floor(viewport.height)
    canvas.width = w
    canvas.height = h
    if (wrap) wrap.style.aspectRatio = `${w} / ${h}`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    await page.render({ canvasContext: ctx, viewport }).promise
    pdf.thumbCache.set(origIdx, canvas.toDataURL('image/png'))
  } catch {
    /* ignore — page may have been deleted mid-render */
  }
}

export interface DragHandlers {
  onDragStart(e: DragEvent, uiIdx: number): void
  onDragEnd(e: DragEvent): void
  onDragOver(e: DragEvent, uiIdx: number): void
  onDragLeave(e: DragEvent): void
  onDrop(e: DragEvent, uiIdx: number, axis: 'x' | 'y'): void
}

let dragSrcIdx: number | null = null

export function createPageDragHandlers(
  axis: 'x' | 'y',
  onMove: (src: number, dest: number) => void,
): DragHandlers {
  return {
    onDragStart(e, uiIdx) {
      dragSrcIdx = uiIdx
      ;(e.currentTarget as HTMLElement).classList.add('dragging')
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move'
        try {
          e.dataTransfer.setData('text/plain', String(uiIdx))
        } catch {
          /* ignore */
        }
      }
    },
    onDragEnd(e) {
      ;(e.currentTarget as HTMLElement).classList.remove('dragging')
      document
        .querySelectorAll('.drop-before, .drop-after')
        .forEach((t) => t.classList.remove('drop-before', 'drop-after'))
      dragSrcIdx = null
    },
    onDragOver(e) {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      const el = e.currentTarget as HTMLElement
      const r = el.getBoundingClientRect()
      const before =
        axis === 'x' ? e.clientX - r.left < r.width / 2 : e.clientY - r.top < r.height / 2
      el.classList.toggle('drop-before', before)
      el.classList.toggle('drop-after', !before)
    },
    onDragLeave(e) {
      ;(e.currentTarget as HTMLElement).classList.remove('drop-before', 'drop-after')
    },
    onDrop(e, uiIdx, ax) {
      e.preventDefault()
      const el = e.currentTarget as HTMLElement
      const tgt = uiIdx
      const src = dragSrcIdx
      el.classList.remove('drop-before', 'drop-after')
      if (src === null || src === tgt) return
      const r = el.getBoundingClientRect()
      const before =
        ax === 'x' ? e.clientX - r.left < r.width / 2 : e.clientY - r.top < r.height / 2
      const dest = before ? tgt : tgt + 1
      onMove(src, dest)
    },
  }
}
