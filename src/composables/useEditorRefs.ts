import { ref, type Ref } from 'vue'

// Refs to the DOM nodes that imperative composables (renderer, zoom-pan, text overlay, etc.)
// need to manipulate. EditorScreen.vue mounts the templates and sets these refs in onMounted.
//
// Why a module-level singleton: the composables don't all run inside the same setup() — some
// fire from custom-event listeners or store watchers. Passing refs through props/provide
// would require threading them through every layer. Centralizing here keeps the wiring trivial.
//
// Only the scroll container lives here. The per-page canvas / text layer / overlay used to as
// well, back when exactly one page was on screen; the continuous viewer mounts every page at
// once, so those are resolved from the rendered DOM instead — see usePageElements.ts.

interface EditorRefs {
  canvasWrap: Ref<HTMLDivElement | null>
  pageFlow: Ref<HTMLDivElement | null>
  filename: Ref<string>
  zoomLabel: Ref<string>
}

const refs: EditorRefs = {
  canvasWrap: ref(null),
  pageFlow: ref(null),
  filename: ref(''),
  zoomLabel: ref('100%'),
}

export function useEditorRefs(): EditorRefs {
  return refs
}
