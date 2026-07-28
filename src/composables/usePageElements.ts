// DOM lookup for the pages of the continuous viewer.
//
// The single-page viewer could hold one canvas / text-layer / overlay in the
// useEditorRefs singleton. With every page of the document mounted at once
// that no longer works, and a hand-maintained registry would need
// register/unregister plumbing in every page component plus careful ordering
// against Vue's unmount. The rendered DOM already carries the mapping, so we
// read it back from there instead: each page stage is tagged with its UI index
// and its original page index, and the three layers are its children.

import { useEditorRefs } from '@/composables/useEditorRefs'

export interface PageEls {
  uiIdx: number
  origIdx: number
  stage: HTMLElement
  canvas: HTMLCanvasElement
  textLayer: HTMLElement
  textOverlay: HTMLElement
}

export function pageElsFromStage(stage: HTMLElement | null): PageEls | null {
  if (!stage) return null
  const canvas = stage.querySelector('canvas')
  const textLayer = stage.querySelector<HTMLElement>('.text-layer')
  const textOverlay = stage.querySelector<HTMLElement>('.text-overlay')
  if (!canvas || !textLayer || !textOverlay) return null
  const uiIdx = Number(stage.dataset.uiIdx)
  const origIdx = Number(stage.dataset.origIdx)
  if (!Number.isInteger(uiIdx) || !Number.isInteger(origIdx)) return null
  return { uiIdx, origIdx, stage, canvas, textLayer, textOverlay }
}

export function pageElsAt(uiIdx: number): PageEls | null {
  const wrap = useEditorRefs().canvasWrap.value
  if (!wrap) return null
  return pageElsFromStage(
    wrap.querySelector<HTMLElement>(`.canvas-stage[data-ui-idx="${uiIdx}"]`),
  )
}

export function allPageEls(): PageEls[] {
  return collect('.canvas-stage')
}

// Only the pages that currently hold a painted canvas. Every page of the
// document is in the DOM, so anything that walks pages on a hot path — a
// mousedown, a zoom tick — should use this instead and stay O(visible).
export function renderedPageEls(): PageEls[] {
  return collect('.canvas-stage[data-rendered="1"]')
}

function collect(selector: string): PageEls[] {
  const wrap = useEditorRefs().canvasWrap.value
  if (!wrap) return []
  const out: PageEls[] = []
  for (const stage of wrap.querySelectorAll<HTMLElement>(selector)) {
    const els = pageElsFromStage(stage)
    if (els) out.push(els)
  }
  return out
}

// Which page owns a DOM node — used to attribute a text selection or a click to
// the page it actually landed on rather than to pdf.currentPage.
export function pageElsFromNode(node: Node | null): PageEls | null {
  if (!node) return null
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  return pageElsFromStage(el?.closest<HTMLElement>('.canvas-stage') ?? null)
}

// Which page sits under a viewport coordinate. Hit-tests the canvas box rather
// than the stage so the drop shadow / border radius don't count as page area.
export function pageElsAtPoint(clientX: number, clientY: number): PageEls | null {
  for (const els of renderedPageEls()) {
    const r = els.canvas.getBoundingClientRect()
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
      return els
    }
  }
  return null
}
