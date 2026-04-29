# PDF Editor

A modern, portable PDF editor for Windows. Single-file `.exe` — no install required.

![Tech](https://img.shields.io/badge/Electron-28-47848F?logo=electron&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Open & view** PDFs with selectable text, fit-to-page, and zoom
- **Merge** multiple PDFs with drag-and-drop reordering
- **Reorder & delete pages** — sidebar thumbnails or a full-screen grid view
- **Add text** anywhere on a page, drag to reposition, optionally repeat as a header/footer on every page
- **Bookmarks** — anchored to a specific page, or to a text selection so the reader jumps to the exact spot
- **Pan** by dragging when zoomed in (text selection still wins on text)
- **Recent files** on the welcome screen (last 5)

## UI

Glassmorphism on a dark animated gradient — frameless window, custom title bar, micro-animations on every interaction. Backdrop blur, floating color blobs, drop-line indicators while reordering, smooth screen transitions.

## Install / Run

Requires Node.js 18+.

```bash
npm install
npm start          # dev run
npm run build      # produce dist/PDF-Editor-Portable.exe
```

The build target is a single self-contained `.exe`. Drop it on a USB stick and run it on any Windows 10/11 machine.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `←` / `PageUp` | Previous page |
| `→` / `PageDown` | Next page |
| `Ctrl + =` / `Ctrl + +` | Zoom in |
| `Ctrl + -` | Zoom out |
| `Ctrl + 0` | Fit to page |
| `Ctrl + wheel` | Zoom (cursor-anchored) |
| `Esc` | Close modal / cancel text placement |

## Tech

- **Electron 28** — frameless window, custom chrome
- **pdf.js (legacy CJS build)** — page rendering and text extraction
- **pdf-lib** — page reordering/merging, text injection, hand-built PDF outlines
- **electron-builder** — portable Windows build

No frontend framework, no bundler — single HTML file, single CSS file, single JS file. ~1500 lines total.

## License

MIT
