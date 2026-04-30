// Pure diff computation for the compare feature. No DOM access here — the screen
// component renders the resulting box lists into overlays and connectors.
//
// Two modes:
//   - Text-only (default): per-item LCS over getTextContent() items → grouped hunks
//   - Visual: tile-based pixel SAD on off-screen renders → merged rects

import { PDF_CONFIG } from '@/stores/pdf'
import { usePdfjs } from '@/composables/usePdfEngine'

export type DiffKind = 'added' | 'removed' | 'changed' | 'same'

export interface DiffBox {
  x: number
  y: number
  w: number
  h: number
  kind: DiffKind
}

export interface Hunk {
  kind: DiffKind
  leftBoxes: DiffBox[]
  rightBoxes: DiffBox[]
}

export interface PageDiff {
  leftBoxes: DiffBox[]
  rightBoxes: DiffBox[]
  hunks: Hunk[]
  leftBaseW: number
  leftBaseH: number
  rightBaseW: number
  rightBaseH: number
  removedCount: number
  addedCount: number
  leftStatus: DiffKind
  rightStatus: DiffKind
  changed: boolean
}

interface PdfPageLike {
  getViewport(opts: { scale: number }): {
    width: number
    height: number
    transform: number[]
    scale: number
  }
  getTextContent(): Promise<{
    items: Array<{ str: string; transform: number[]; width?: number }>
  }>
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): {
    promise: Promise<void>
  }
}

interface TextItem {
  str: string
  norm: string
  x: number
  y: number
  w: number
  h: number
}

function emptyDiff(): PageDiff {
  return {
    leftBoxes: [],
    rightBoxes: [],
    hunks: [],
    leftBaseW: 0,
    leftBaseH: 0,
    rightBaseW: 0,
    rightBaseH: 0,
    removedCount: 0,
    addedCount: 0,
    leftStatus: 'same',
    rightStatus: 'same',
    changed: false,
  }
}

function itemBox(item: TextItem | null, kind: DiffKind): DiffBox | null {
  if (!item || !item.norm) return null
  return { x: item.x, y: item.y, w: item.w, h: item.h, kind }
}

async function pageTextItems(
  page: PdfPageLike | null,
): Promise<{ items: TextItem[]; baseW: number; baseH: number } | null> {
  if (!page) return null
  const viewport = page.getViewport({ scale: 1 })
  const tc = await page.getTextContent()
  const items: TextItem[] = []
  const pdfjs = usePdfjs() as unknown as {
    Util: { transform(a: number[], b: number[]): number[] }
  }
  for (const it of tc.items) {
    if (!it.str) continue
    const tx = pdfjs.Util.transform(viewport.transform, it.transform)
    const fontHeight = Math.hypot(tx[2], tx[3])
    if (fontHeight <= 0) continue
    const left = tx[4]
    const top = tx[5] - fontHeight
    const w = (it.width || it.str.length * fontHeight * 0.5) * viewport.scale
    items.push({
      str: it.str,
      norm: it.str.replace(/\s+/g, ' ').trim(),
      x: left,
      y: top,
      w,
      h: fontHeight,
    })
  }
  return { items, baseW: viewport.width, baseH: viewport.height }
}

function hunkKind(h: { leftBoxes: DiffBox[]; rightBoxes: DiffBox[] }): DiffKind {
  if (h.leftBoxes.length && h.rightBoxes.length) return 'changed'
  if (h.leftBoxes.length) return 'removed'
  return 'added'
}

function lcsDiffHunks(L: TextItem[], R: TextItem[], Ln: string[], Rn: string[]): Hunk[] {
  const n = L.length
  const m = R.length
  const dp: Int32Array[] = new Array(n + 1)
  for (let i = 0; i <= n; i++) dp[i] = new Int32Array(m + 1)
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (Ln[i - 1] && Ln[i - 1] === Rn[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const hunks: Hunk[] = []
  let cur: { leftBoxes: DiffBox[]; rightBoxes: DiffBox[] } | null = null
  let i = n
  let j = m
  function closeHunk() {
    if (!cur) return
    cur.leftBoxes.reverse()
    cur.rightBoxes.reverse()
    if (cur.leftBoxes.length || cur.rightBoxes.length) {
      hunks.push({ kind: hunkKind(cur), leftBoxes: cur.leftBoxes, rightBoxes: cur.rightBoxes })
    }
    cur = null
  }
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && Ln[i - 1] && Ln[i - 1] === Rn[j - 1]) {
      closeHunk()
      i--
      j--
    } else {
      if (!cur) cur = { leftBoxes: [], rightBoxes: [] }
      const goRemove = j === 0 || (i > 0 && dp[i - 1][j] >= dp[i][j - 1])
      if (goRemove) {
        const b = itemBox(Ln[i - 1] ? L[i - 1] : null, 'removed')
        if (b) cur.leftBoxes.push(b)
        i--
      } else {
        const b = itemBox(Rn[j - 1] ? R[j - 1] : null, 'added')
        if (b) cur.rightBoxes.push(b)
        j--
      }
    }
  }
  closeHunk()
  hunks.reverse()
  return hunks
}

function setDiffHunks(L: TextItem[], R: TextItem[], Ln: string[], Rn: string[]): Hunk[] {
  const counts = new Map<string, number>()
  for (const s of Ln) if (s) counts.set(s, (counts.get(s) ?? 0) + 1)
  const addedIdx: number[] = []
  for (let j = 0; j < Rn.length; j++) {
    const s = Rn[j]
    if (!s) continue
    const c = counts.get(s) ?? 0
    if (c > 0) counts.set(s, c - 1)
    else addedIdx.push(j)
  }
  const remaining = new Map(counts)
  const removedIdx: number[] = []
  for (let i = 0; i < Ln.length; i++) {
    const s = Ln[i]
    if (!s) continue
    const c = remaining.get(s) ?? 0
    if (c > 0) {
      removedIdx.push(i)
      remaining.set(s, c - 1)
    }
  }
  const hunks: Hunk[] = []
  if (removedIdx.length) {
    hunks.push({
      kind: 'removed',
      leftBoxes: removedIdx.map((i) => itemBox(L[i], 'removed')).filter((b): b is DiffBox => !!b),
      rightBoxes: [],
    })
  }
  if (addedIdx.length) {
    hunks.push({
      kind: 'added',
      leftBoxes: [],
      rightBoxes: addedIdx.map((i) => itemBox(R[i], 'added')).filter((b): b is DiffBox => !!b),
    })
  }
  return hunks
}

function assembleDiff(
  hunks: Hunk[],
  ld: { baseW: number; baseH: number } | null,
  rd: { baseW: number; baseH: number } | null,
  hasLeft: boolean,
  hasRight: boolean,
): PageDiff {
  const leftBoxes: DiffBox[] = []
  const rightBoxes: DiffBox[] = []
  let removedCount = 0
  let addedCount = 0
  for (const h of hunks) {
    for (const b of h.leftBoxes) {
      leftBoxes.push(b)
      removedCount++
    }
    for (const b of h.rightBoxes) {
      rightBoxes.push(b)
      addedCount++
    }
  }
  return {
    leftBoxes,
    rightBoxes,
    hunks,
    leftBaseW: ld ? ld.baseW : 0,
    leftBaseH: ld ? ld.baseH : 0,
    rightBaseW: rd ? rd.baseW : 0,
    rightBaseH: rd ? rd.baseH : 0,
    removedCount,
    addedCount,
    leftStatus: removedCount ? (hasRight ? 'changed' : 'removed') : 'same',
    rightStatus: addedCount ? (hasLeft ? 'changed' : 'added') : 'same',
    changed: removedCount + addedCount > 0,
  }
}

function wholePageDiff(
  data: { items: TextItem[]; baseW: number; baseH: number } | null,
  side: 'left' | 'right',
): PageDiff {
  if (!data) return emptyDiff()
  const kind: DiffKind = side === 'left' ? 'removed' : 'added'
  const boxes = data.items.map((i) => itemBox(i, kind)).filter((b): b is DiffBox => !!b)
  const hunks: Hunk[] = boxes.length
    ? [
        {
          kind,
          leftBoxes: side === 'left' ? boxes : [],
          rightBoxes: side === 'right' ? boxes : [],
        },
      ]
    : []
  return {
    leftBoxes: side === 'left' ? boxes : [],
    rightBoxes: side === 'right' ? boxes : [],
    hunks,
    leftBaseW: side === 'left' ? data.baseW : 0,
    leftBaseH: side === 'left' ? data.baseH : 0,
    rightBaseW: side === 'right' ? data.baseW : 0,
    rightBaseH: side === 'right' ? data.baseH : 0,
    removedCount: side === 'left' ? boxes.length : 0,
    addedCount: side === 'right' ? boxes.length : 0,
    leftStatus: side === 'left' ? 'removed' : 'added',
    rightStatus: side === 'right' ? 'added' : 'removed',
    changed: boxes.length > 0,
  }
}

export async function diffPageText(
  leftPage: PdfPageLike | null,
  rightPage: PdfPageLike | null,
): Promise<PageDiff> {
  const ld = await pageTextItems(leftPage)
  const rd = await pageTextItems(rightPage)
  if (!ld && !rd) return emptyDiff()
  if (!ld) return wholePageDiff(rd, 'right')
  if (!rd) return wholePageDiff(ld, 'left')

  const L = ld.items
  const R = rd.items
  const Ln = L.map((i) => i.norm)
  const Rn = R.map((i) => i.norm)

  const hunks =
    L.length > PDF_CONFIG.COMPARE_TEXT_LCS_LIMIT || R.length > PDF_CONFIG.COMPARE_TEXT_LCS_LIMIT
      ? setDiffHunks(L, R, Ln, Rn)
      : lcsDiffHunks(L, R, Ln, Rn)

  return assembleDiff(hunks, ld, rd, !!leftPage, !!rightPage)
}

async function renderOffscreen(page: PdfPageLike, scale: number): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale })
  const c = document.createElement('canvas')
  c.width = Math.ceil(viewport.width)
  c.height = Math.ceil(viewport.height)
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error('canvas 2d ctx missing')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  await page.render({ canvasContext: ctx, viewport }).promise
  return c
}

function tileSAD(
  a: ImageData,
  b: ImageData,
  x0: number,
  y0: number,
  tw: number,
  th: number,
): number {
  let sum = 0
  const aw = a.width
  const bw = b.width
  const ad = a.data
  const bd = b.data
  for (let y = 0; y < th; y += 2) {
    const ay = y0 + y
    if (ay >= a.height || ay >= b.height) break
    for (let x = 0; x < tw; x += 2) {
      const ax = x0 + x
      const ai = (ay * aw + ax) * 4
      const bi = (ay * bw + ax) * 4
      sum +=
        Math.abs(ad[ai] - bd[bi]) +
        Math.abs(ad[ai + 1] - bd[bi + 1]) +
        Math.abs(ad[ai + 2] - bd[bi + 2])
    }
  }
  return sum
}

function mergeTiles(
  flags: Uint8Array,
  cols: number,
  rows: number,
  TILE: number,
): Array<{ x: number; y: number; w: number; h: number }> {
  const out: Array<{ x: number; y: number; w: number; h: number }> = []
  const used = new Uint8Array(flags.length)
  for (let ry = 0; ry < rows; ry++) {
    let rx = 0
    while (rx < cols) {
      const idx = ry * cols + rx
      if (!flags[idx] || used[idx]) {
        rx++
        continue
      }
      let endX = rx + 1
      while (endX < cols && flags[ry * cols + endX] && !used[ry * cols + endX]) endX++
      let endY = ry + 1
      outer: while (endY < rows) {
        for (let c = rx; c < endX; c++) {
          if (!flags[endY * cols + c] || used[endY * cols + c]) break outer
        }
        endY++
      }
      for (let yy = ry; yy < endY; yy++) {
        for (let xx = rx; xx < endX; xx++) used[yy * cols + xx] = 1
      }
      out.push({ x: rx * TILE, y: ry * TILE, w: (endX - rx) * TILE, h: (endY - ry) * TILE })
      rx = endX
    }
  }
  return out
}

export async function diffPageVisual(
  leftPage: PdfPageLike | null,
  rightPage: PdfPageLike | null,
): Promise<PageDiff> {
  const scale = PDF_CONFIG.COMPARE_VISUAL_RENDER_SCALE
  const lc = leftPage ? await renderOffscreen(leftPage, scale) : null
  const rc = rightPage ? await renderOffscreen(rightPage, scale) : null
  if (!lc && !rc) return emptyDiff()

  const baseLW = leftPage ? leftPage.getViewport({ scale: 1 }).width : 0
  const baseLH = leftPage ? leftPage.getViewport({ scale: 1 }).height : 0
  const baseRW = rightPage ? rightPage.getViewport({ scale: 1 }).width : 0
  const baseRH = rightPage ? rightPage.getViewport({ scale: 1 }).height : 0

  if (!lc) {
    const box: DiffBox = { x: 0, y: 0, w: baseRW, h: baseRH, kind: 'added' }
    return {
      leftBoxes: [],
      rightBoxes: [box],
      hunks: [{ kind: 'added', leftBoxes: [], rightBoxes: [box] }],
      leftBaseW: 0,
      leftBaseH: 0,
      rightBaseW: baseRW,
      rightBaseH: baseRH,
      removedCount: 0,
      addedCount: 1,
      leftStatus: 'added',
      rightStatus: 'added',
      changed: true,
    }
  }
  if (!rc) {
    const box: DiffBox = { x: 0, y: 0, w: baseLW, h: baseLH, kind: 'removed' }
    return {
      leftBoxes: [box],
      rightBoxes: [],
      hunks: [{ kind: 'removed', leftBoxes: [box], rightBoxes: [] }],
      leftBaseW: baseLW,
      leftBaseH: baseLH,
      rightBaseW: 0,
      rightBaseH: 0,
      removedCount: 1,
      addedCount: 0,
      leftStatus: 'removed',
      rightStatus: 'removed',
      changed: true,
    }
  }

  const W = Math.min(lc.width, rc.width)
  const H = Math.min(lc.height, rc.height)
  const lImg = lc.getContext('2d')!.getImageData(0, 0, lc.width, lc.height)
  const rImg = rc.getContext('2d')!.getImageData(0, 0, rc.width, rc.height)

  const TILE = PDF_CONFIG.COMPARE_VISUAL_TILE
  const THRESH = PDF_CONFIG.COMPARE_VISUAL_THRESHOLD
  const cols = Math.ceil(W / TILE)
  const rows = Math.ceil(H / TILE)
  const tileFlags = new Uint8Array(cols * rows)
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const x0 = rx * TILE
      const y0 = ry * TILE
      const tw = Math.min(TILE, W - x0)
      const th = Math.min(TILE, H - y0)
      if (tileSAD(lImg, rImg, x0, y0, tw, th) > THRESH) tileFlags[ry * cols + rx] = 1
    }
  }
  const merged = mergeTiles(tileFlags, cols, rows, TILE)
  const boxes: DiffBox[] = merged.map((b) => ({
    x: b.x / scale,
    y: b.y / scale,
    w: b.w / scale,
    h: b.h / scale,
    kind: 'changed',
  }))

  const leftBoxes = boxes.map((b) => ({ ...b }))
  const rightBoxes = boxes.map((b) => ({ ...b }))
  const hunks: Hunk[] = boxes.map((b) => ({
    kind: 'changed',
    leftBoxes: [{ ...b }],
    rightBoxes: [{ ...b }],
  }))

  return {
    leftBoxes,
    rightBoxes,
    hunks,
    leftBaseW: baseLW,
    leftBaseH: baseLH,
    rightBaseW: baseRW,
    rightBaseH: baseRH,
    removedCount: 0,
    addedCount: 0,
    leftStatus: boxes.length ? 'changed' : 'same',
    rightStatus: boxes.length ? 'changed' : 'same',
    changed: boxes.length > 0,
  }
}

export function unionBox(boxes: DiffBox[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const b of boxes) {
    if (b.x < x0) x0 = b.x
    if (b.y < y0) y0 = b.y
    if (b.x + b.w > x1) x1 = b.x + b.w
    if (b.y + b.h > y1) y1 = b.y + b.h
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export interface FlatHunk {
  page: number
  y: number
  hunk: Hunk
}

export function flattenHunks(diffs: Array<PageDiff | null | undefined>): FlatHunk[] {
  const out: FlatHunk[] = []
  diffs.forEach((d, page) => {
    if (!d || !d.hunks) return
    for (const h of d.hunks) {
      const primary = (h.leftBoxes && h.leftBoxes[0]) || (h.rightBoxes && h.rightBoxes[0])
      out.push({ page, y: primary ? primary.y : 0, hunk: h })
    }
  })
  return out
}
