# CLAUDE.md

**OloPDF** — modern, portable PDF editor built as a frameless Electron app with a Vue 3 + TypeScript renderer. Edit text/bookmarks/page order, merge multiple PDFs, and compare two PDFs side-by-side. Ships as an NSIS one-click installer (with auto-updates via GitHub Releases) and a single-file Windows portable `.exe`.

## Standards

MUST FOLLOW THESE RULES, NO EXCEPTIONS

- Stack: Electron (main: JS), Vue 3, TypeScript, TailwindCSS v4, Vue Router 4 + unplugin-vue-router, Pinia, Vite, vitest. **No Pinia Colada** — this app has no remote data fetching.
- Patterns: ALWAYS use Composition API + `<script setup>`, NEVER use Options API
- ALWAYS keep types alongside your code; prefer `interface` over `type` for object shapes
- Tests live alongside the file they test: `src/composables/useToast.ts` + `src/composables/useToast.spec.ts`
- ALWAYS use TailwindCSS classes rather than manual CSS. The exception is the canvas/text-layer area where precise pixel-level positioning is required — those still use scoped `<style>` blocks.
- DO NOT hard code colors; use the tokens defined in `src/assets/main.css` (`--color-accent`, `--color-fg-dim`, etc.) which are exposed as Tailwind utilities (`bg-accent`, `text-fg-dim`, …)
- ONLY add comments that explain *why* something is done, not what it does
- ALWAYS use named functions when declaring methods; arrow functions only for callbacks
- ALWAYS prefer named exports over default exports — except `.vue` SFCs, which export the component as default by language convention
- ALWAYS define props with `defineProps<{ … }>()` and TypeScript types, WITHOUT `const props =` (use `const props =` only if props are read in the script block)
- Destructure props to declare default values
- ALWAYS define emits with `const emit = defineEmits<{ eventName: [arg: T] }>()`
- Use `defineModel<T>()` for two-way bindings, never manual `modelValue`/`update:modelValue` pairs
- Component file names PascalCase (`TitleBar.vue`); compose from general to specific (`WelcomeRecents.vue`, not `RecentsWelcome.vue`)
- Dev server runs on `http://localhost:5173`; HMR is on. Use `npm run dev` (orchestrates Vite + Electron). Do NOT launch `npm start` or `electron .` directly while developing — that loads the prod-built renderer.

## Project Commands

- `npm run dev` — start Vite + Electron with HMR (loads `VITE_DEV_SERVER_URL` in main.js)
- `npm run dev:vite` — Vite alone, useful for browser-only tweaks (no Electron APIs available)
- `npm run start:legacy` — run the pre-Vue vanilla-JS renderer in `renderer/` (kept side-by-side during the migration; sets `LEGACY_RENDERER=1` so main.js loads `renderer/index.html`)
- `npm run build:renderer` — `vite build` → `dist-renderer/`
- `npm run build` — Windows NSIS installer + portable build via electron-builder (runs `prebuild` which builds the renderer)
- `npm run build:icons` — regenerate `build/icon.ico` + `build/icon.png` from `build/icon.svg`
- `npm run release [-- patch|minor|major|x.y.z]` — bump version, build, publish draft to GitHub Releases, tag, push (requires `GH_TOKEN`)
- `npm run type-check` — `vue-tsc --noEmit`
- `npm run test` / `npm run test:watch` — vitest

## Project Structure

```
main.js                       # Electron main (JS — kept as-is, low churn)
scripts/dev.js                # Dev orchestrator: starts Vite, launches Electron with VITE_DEV_SERVER_URL
index.html                    # Vite entry; mounts <div id="app"> + /src/main.ts
vite.config.ts                # Externalizes electron/fs/path/pdfjs-dist/pdf-lib so window.require() resolves at runtime
src/
├── main.ts                   # Vue app entry — installs Pinia + router, mounts App
├── App.vue                   # Root: titlebar + background + <RouterView> with screen transition
├── vite-env.d.ts             # Ambient types (vite/client, unplugin-vue-router/client, __APP_VERSION__)
├── assets/
│   └── main.css              # Tailwind v4 import + @theme tokens + base resets + .glass utility
├── router/
│   └── index.ts              # createMemoryHistory + auto-routes from unplugin-vue-router
├── stores/
│   └── pdf.ts                # Pinia store: pdfBytes, pageOrder, annotations, repeats, bookmarks, compare, mergeFiles
├── pages/                    # File-based routes (unplugin-vue-router)
│   ├── (welcome).vue         # /  — welcome screen (route name "welcome")
│   ├── editor.vue            # /editor
│   ├── merge.vue             # /merge
│   └── compare.vue           # /compare
├── components/
│   ├── ui/                   # Reusable primitives — UiButton, UiToast, UiLoading, …
│   ├── layout/               # TitleBar, AppBackground
│   └── features/<feature>/   # Feature-specific composites: features/welcome/WelcomeRecents.vue, …
├── composables/              # useToast, useLoading, useRecents, useOpenPdf, usePdfEngine, useChromeZoomDefense
└── utils/
    ├── electron.ts           # window.require wrappers for ipcRenderer/shell/fs/path
    └── pdf.ts                # hexToRgb01, cssFontFamily, pickStandardFont, formatBytes
```

## Architecture

A frameless Electron app: one main process (`main.js`), Vue 3 renderer under `src/`. `nodeIntegration: true, contextIsolation: false` — the renderer uses `window.require()` directly to access Electron and Node modules. Don't introduce a preload bridge unless the threat model changes.

### Cross-component communication

1. **Pinia store** (`src/stores/pdf.ts`) — single source of truth for the open document, annotations, page order, compare state, merge files. Components subscribe reactively; mutations go through actions where the change is non-trivial.
2. **Composables for reusable logic** — `useOpenPdf`, `useToast`, `useLoading`, `useRecents`, `usePdfjs`, `useChromeZoomDefense`. Return `ref`s for state, named functions for actions.
3. **Custom events on `window`** — kept for cross-cutting concerns where coupling a producer to a consumer would create a cycle. Current events:
   - `pdf:wheel-zoom` — emitted by `useChromeZoomDefense`, handled by the editor's zoom logic.
   - `pdf:zoom-key` — same source, fires on Ctrl+=/Ctrl+−/Ctrl+0.
   - `pdf:page-rendered` — emitted by the viewer after each canvas render; the text overlay and the active-thumb highlighter listen.
   - `pdf:bookmarks-changed` — emitted after a page deletion that may purge bookmarks.

Prefer the store for shared state, composables for shared behavior, events only for fan-out notifications.

### Two PDF libraries, two purposes

- **pdf.js (`pdfjs-dist/legacy/build/pdf.js`)** — rendering only (canvas + text extraction). Wrapped by `composables/usePdfEngine.ts`. Worker is loaded by reading `pdf.worker.js` from `node_modules` with `fs.readFileSync` and wrapping it as a `Blob` URL — this works in dev (Vite externalizes both `fs` and `pdfjs-dist`, so `require.resolve` runs against Node's resolver) and in the packaged asar. Don't replace it with a path-based `workerSrc`; that breaks under asar.
- **pdf-lib** — all editing (page reordering/deletion, merging, drawing text, building the outline). Used only at save time, never during preview.

Both libraries are loaded with `window.require(...)` at runtime — never imported. The bundler sees nothing to resolve, so they stay out of the asar bundle and load straight from `node_modules` via Electron's Node integration. Don't add them to `rollupOptions.external` — that combination forced `format: 'cjs'` historically and crashed the renderer in production with `exports is not defined`.

### Page identity through edits

The renderer never mutates the source PDF in memory. The store holds:

- `pdfBytes` — original `ArrayBuffer` (immutable)
- `pageOrder` — array of *original* page indices, mutated by reorder/delete
- All annotations/bookmarks reference `pageOriginalIdx`, not UI position

Deleting page 3 from the UI just splices `pageOrder`; annotations on still-present pages survive. On save, `pdf-lib`'s `copyPages(srcDoc, pageOrder)` reconstructs the document in the new order, and an `origToNewIdx` map applies text/bookmarks to their new positions.

### Coordinate systems

The viewer uses **top-left** origin (CSS pixels, scaled by `pdf.zoom`). PDF user space is **bottom-left**. Conversion happens only at save time:

- Text: stored as `{x, yFromTop}` in PDF user units; written as `y: pageHeight - y - size`
- Bookmark anchors: stored top-left; written into `/XYZ` Dest as `[x, pageHeight - y, null]`

If you add another spatial feature, follow the same convention: store top-left, flip on save.

### Two text-annotation arrays, on purpose

- `pdf.textAnnotations[]` — per-page (has `pageOriginalIdx`)
- `pdf.repeatTexts[]` — header/footer (no page index; applied to every output page)

They render together in the overlay with a ↻ badge distinguishing repeats. Don't merge them; the separation is what makes "drag a footer" move it everywhere.

### The text layer is rendered manually

The viewer does **not** call `pdfjsLib.renderTextLayer`. It iterates `page.getTextContent().items`, composes `viewport.transform × item.transform` via `pdfjsLib.Util.transform`, and emits its own `<span>` per text run. Reason: pdf.js's renderer plus our global chrome `user-select: none` produced an unselectable layer regardless of override. Manual spans + `!important user-select: text` is the working combination — keep it. Because the layer is imperative, render it inside `onMounted`/`watch` callbacks with a Vue `ref` to the container `<div>`, not as reactive template content.

### Mousedown priority on the canvas wrapper

A single handler enforces the order:

1. `pdf.pendingTextPlacement` set → place text and return
2. Target is inside the text-layer and is a `<span>` (not the layer itself) → return so the browser handles selection
3. Otherwise → start pan, but only if there's actual scroll overflow

Placed-text elements have their own mousedown that calls `stopPropagation`, so they never reach this handler. Preserve this order if you add interactions; the design is "selection beats pan, drag beats both, placement beats everything."

### Bookmarks (PDF outline)

The save logic hand-builds the `/Outlines` tree using `pdfDoc.context.nextRef()`, `PDFArray.withContext`, and assignments via `ctx.assign`. pdf-lib has no high-level outline API. The Dest array uses `/XYZ` with `x,y` when the bookmark was anchored to a text selection (captured via `window.getSelection()` before the modal opens), or `null` `x,y` for plain page bookmarks.

### Layout invariant: `min-height: 0`

The flex chain editor → content → canvas-wrap, plus the sidebars, all need `min-height: 0` (or `flex-shrink: 0` for individual scrollable items). Without it, a zoomed canvas pushes the bottom toolbar off-screen because flex items default to `min-height: auto` and grow to fit content. If you add a new scrolling region, replicate the pattern. With Tailwind v4, this is `min-h-0`.

### Recents

Persisted to `app.getPath('userData')/recents.json` via three IPC handlers (`recents:get/add/remove`) in [main.js](main.js). The renderer filters the list against `fs.access` on every render so deleted files don't appear. Capped at 5, deduplicated, newest first. `addRecent` runs only on a successful open (so failures don't pollute the list).

### Window chrome and the three-layer zoom defense

`frame: false` with custom title bar; drag region via `-webkit-app-region: drag` on the title-bar drag area, no-drag on the buttons. Chrome zoom is locked three ways:

1. **Renderer** — `webFrame.setZoomFactor(1)` + `setVisualZoomLevelLimits(1, 1)` in `TitleBar.vue` `onMounted`
2. **Main** — `webContents.setZoomFactor(1)` + `zoom-changed` reset in `main.js`
3. **Capture-phase intercepts** — `useChromeZoomDefense` listens for Ctrl+=/Ctrl+−/Ctrl+0/Ctrl+wheel at the `window` level with `{ capture: true }`, prevents default, and dispatches `pdf:zoom-key` / `pdf:wheel-zoom` for the editor to handle.

All three layers exist intentionally — Chromium leaks zoom through any single defense. Don't remove any of them.

## Research & Documentation

- NEVER hallucinate URLs.
- For Vue/Pinia/Vue Router/Tailwind, follow the existing patterns in this repo first; check `https://vuejs.org/llms.txt` and `https://router.vuejs.org/llms.txt` if you need to verify an API.
- Verify examples and patterns from documentation before using.
