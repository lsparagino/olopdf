import { ref, type Ref } from 'vue'

// Refs to the DOM nodes that imperative composables (renderer, zoom-pan, text overlay, etc.)
// need to manipulate. EditorScreen.vue mounts the templates and sets these refs in onMounted.
//
// Why a module-level singleton: the composables don't all run inside the same setup() — some
// fire from custom-event listeners or store watchers. Passing refs through props/provide
// would require threading them through every layer. Centralizing here keeps the wiring trivial.

interface EditorRefs {
  canvasWrap: Ref<HTMLDivElement | null>
  canvasStage: Ref<HTMLDivElement | null>
  pdfCanvas: Ref<HTMLCanvasElement | null>
  textLayer: Ref<HTMLDivElement | null>
  textOverlay: Ref<HTMLDivElement | null>
  // Right-page render targets used in 2-page (double) view. The right page is
  // canvas-only — no text layer, no annotation overlay — so editing flows
  // continue to operate on the single "current page" on the left.
  canvasStage2: Ref<HTMLDivElement | null>
  pdfCanvas2: Ref<HTMLCanvasElement | null>
  filename: Ref<string>
  zoomLabel: Ref<string>
}

const refs: EditorRefs = {
  canvasWrap: ref(null),
  canvasStage: ref(null),
  pdfCanvas: ref(null),
  textLayer: ref(null),
  textOverlay: ref(null),
  canvasStage2: ref(null),
  pdfCanvas2: ref(null),
  filename: ref(''),
  zoomLabel: ref('100%'),
}

export function useEditorRefs(): EditorRefs {
  return refs
}
