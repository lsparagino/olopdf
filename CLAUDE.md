# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` — run the app in dev (electron .)
- `npm run build` — produce `dist/PDF-Editor-Portable.exe` via electron-builder (single-file Windows portable target)
- `node --check main.js && node --check renderer/app.js` — quick syntax sanity check (no test suite exists)

There is no lint config, test runner, or type checker in this project. Don't invent commands for them.

## Architecture

A frameless Electron app: one main process (`main.js`), one renderer split into modules under `renderer/src/` and stylesheets under `renderer/styles/`. `nodeIntegration: true, contextIsolation: false` — the renderer uses `require()` directly. Don't introduce a preload bridge unless the threat model changes.

### Renderer module layout

`renderer/app.js` is a thin entry that requires each feature module in dependency order. Each module wires up its own DOM listeners on import.

| Module | Responsibility |
|---|---|
| `state.js` | Singleton `state` object + frozen `config` constants |
| `dom.js` | `$`, `toast`, modal/loading helpers, `showScreen` + `onScreenChange` listeners |
| `util.js` | Pure utilities: `hexToRgb01`, `cssFontFamily`, `pickStandardFont`, `formatBytes` |
| `pdf-engine.js` | pdf.js worker setup (Blob URL — survives asar) |
| `chrome.js` | Window controls, capture-phase Ctrl+= / Ctrl+wheel intercept, escape, modal bg close |
| `welcome.js` | Welcome screen, drop zone, file open, recents, curator link, version display |
| `viewer.js` | `renderCurrentPage` + `renderTextLayer` (manual). Emits `pdf:page-rendered` |
| `thumbnails.js` | Sidebar thumbs + grid view. Shared `paintThumb` and `buildThumb` helpers (DRY) |
| `pages.js` | `gotoPage`, `deletePage`, `movePage`, prev/next, keyboard nav, resize re-fit |
| `text.js` | Add-text modal + placed-text overlay + drag. Exports `placePendingTextAt` |
| `zoom-pan.js` | Zoom buttons + wheel-zoom event listener + pan + canvas-wrap mousedown orchestration |
| `bookmarks.js` | Bookmark modal, sidebar list, selection capture, `gotoBookmark` |
| `save.js` | Output PDF assembly: copy, draw text, repeat, build outline |
| `merge.js` | Merge mode (drop, drag-reorder, output) |

### Cross-module communication

Modules avoid direct cycles via two mechanisms:

1. **Custom events on `window`**:
   - `pdf:page-rendered` — emitted by `viewer.js` after each page render. `text.js` redraws the placed-text overlay; `thumbnails.js` re-highlights the active thumb.
   - `pdf:wheel-zoom` — emitted by `chrome.js`, handled by `zoom-pan.js` (so chrome doesn't have to import zoom logic).
   - `pdf:bookmarks-changed` — emitted by `pages.js` after a delete that may purge bookmarks; `bookmarks.js` re-renders.
2. **Lazy `require()`** inside function bodies for the few real cycles (e.g. `thumbnails.js` lazily requires `pages.js` from inside drag handlers, `welcome.js` lazily loads viewer/thumb/bookmark modules from `loadPdfBytes`). The cycle resolves at call time, not module-load time.

Prefer events for fan-out notifications, lazy require only when the dependency is genuinely circular.

### Two PDF libraries, two purposes
- **pdf.js (`pdfjs-dist/legacy/build/pdf.js`)** — rendering only (canvas + text-extraction for the selectable text layer). Worker is loaded by reading `pdf.worker.js` from `node_modules` with `fs.readFileSync` and wrapping it as a `Blob` URL — this works in dev and in the packaged asar. Don't replace it with a path-based `workerSrc`; that breaks under asar.
- **pdf-lib** — all editing (page reordering/deletion, merging, drawing text, building the outline). Used only at save time, never during preview.

### Page identity through edits
The renderer never mutates the source PDF in memory. State is:
- `state.pdfBytes` — original ArrayBuffer (immutable)
- `state.pageOrder` — array of *original* page indices, mutated by reorder/delete
- All annotations/bookmarks reference `pageOriginalIdx`, not UI position

This means deleting page 3 from the UI just splices `pageOrder`; annotations on still-present pages survive. On save, `pdf-lib`'s `copyPages(srcDoc, state.pageOrder)` reconstructs the document in the new order, and `origToNewIdx` maps original indices to their new position when applying text/bookmarks.

### Coordinate systems
The viewer uses **top-left** origin (CSS pixels, scaled by `state.zoom`). PDF user space is **bottom-left**. Conversion happens only at save time:
- Text: stored as `{x, yFromTop}` in PDF user units; written as `y: pageHeight - y - size`
- Bookmark anchors: stored top-left; written into `/XYZ` Dest as `[x, pageHeight - y, null]`

If you add another spatial feature, follow the same convention: store top-left, flip on save.

### Two text-annotation arrays, on purpose
- `state.textAnnotations[]` — per-page (has `pageOriginalIdx`)
- `state.repeatTexts[]` — header/footer (no page index; applied to every output page)

They render together in the overlay with a ↻ badge distinguishing repeats. Don't merge them; the separation is what makes "drag a footer" move it everywhere.

### The text layer is rendered manually
`renderTextLayer` does **not** call `pdfjsLib.renderTextLayer`. We iterate `page.getTextContent().items`, compose `viewport.transform × item.transform` via `pdfjsLib.Util.transform`, and emit our own `<span>` per text run. Reason: pdf.js's renderer plus our global chrome `user-select: none` produced an unselectable layer regardless of override. Manual spans + `!important user-select: text` is the working combination — keep it.

### Mousedown priority on `canvasWrap`
A single handler enforces the order:
1. `state.pendingTextPlacement` set → place text and return
2. Target is inside `.text-layer` and is not the layer itself (i.e. a `<span>`) → return so the browser handles selection
3. Otherwise → `startPan(e)`, but only if there's actual scroll overflow

`.placed-text` elements have their own mousedown that calls `stopPropagation`, so they never reach this handler. Preserve this order if you add interactions; the design is "selection beats pan, drag beats both, placement beats everything."

### Bookmarks (PDF outline)
`addOutline` in [renderer/app.js](renderer/app.js) hand-builds the `/Outlines` tree using `pdfDoc.context.nextRef()`, `PDFArray.withContext`, and assignments via `ctx.assign`. pdf-lib has no high-level outline API. The Dest array uses `/XYZ` with x,y when the bookmark was anchored to a text selection (captured via `window.getSelection()` before the modal opens), or `null` x,y for plain page bookmarks.

### Layout invariant: `min-height: 0`
The grid/flex chain `.editor` → `.content` → `.canvas-wrap` plus the sidebars all need `min-height: 0` (or `flex-shrink: 0` for individual scrollable items). Without it, a zoomed canvas pushes the bottom toolbar off-screen because flex/grid items default to `min-*: auto` and grow to fit content. If you add a new scrolling region, replicate the pattern.

### Recents
Persisted to `app.getPath('userData')/recents.json` via three IPC handlers (`recents:get/add/remove`) in [main.js](main.js). The renderer filters the list against `fs.access` on every render so deleted files don't appear. Capped at 5, deduplicated, newest first. `addRecent` runs only on a successful open (so failures don't pollute the list).

### Window chrome
`frame: false` with custom title bar; drag region via `-webkit-app-region: drag` on `.titlebar-drag`, no-drag on the buttons. Chrome zoom is locked three ways: `webFrame.setZoomFactor(1)` + `setVisualZoomLevelLimits(1, 1)` in renderer, `webContents.setZoomFactor(1)` + `zoom-changed` reset in main, and capture-phase `keydown`/`wheel` interceptors that route Ctrl+= / Ctrl+− / Ctrl+0 / Ctrl+wheel to the PDF zoom buttons. All three layers exist intentionally — Chromium leaks zoom through any single defense.
