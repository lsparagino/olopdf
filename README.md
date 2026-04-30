# OloPDF

A modern, portable PDF editor for Windows. NSIS one-click installer with auto-updates, plus a single-file portable `.exe` for USB use.

![Tech](https://img.shields.io/badge/Electron-28-47848F?logo=electron&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Open & view** PDFs with selectable text, fit-to-page, and zoom
- **Merge** multiple PDFs with drag-and-drop reordering
- **Reorder & delete pages** — sidebar thumbnails or a full-screen grid view
- **Rotate pages** 90° at a time (clockwise / counter-clockwise), saved as the PDF's `/Rotate` flag
- **Add text** anywhere on a page, drag to reposition, optionally repeat as a header/footer on every page
- **Bookmarks** — anchored to a specific page, or to a text selection so the reader jumps to the exact spot
- **Compare** two PDFs side-by-side with text-level diff highlighting
- **Pan** by dragging when zoomed in (text selection still wins on text)
- **Recent files** on the welcome screen (last 5)
- **Auto-updates** — installer copies update in place via GitHub Releases

## Install / Run

Requires Node.js 18+.

```bash
npm install
npm run dev        # Vite + Electron with HMR
npm run build      # produce dist/OloPDF-Setup-<v>.exe and dist/OloPDF-Portable-<v>.exe
```

The NSIS installer auto-updates. The portable `.exe` is single-file (no install) but won't auto-update — point users at the Releases page for upgrades.

## Releasing

Authenticate to GitHub once. Either:

- **GitHub CLI (recommended)** — `winget install GitHub.cli`, then `gh auth login`. The release script picks up the token automatically.
- **Fine-grained PAT** — create one at https://github.com/settings/personal-access-tokens scoped to this repo with `Contents: read & write`, then `$env:GH_TOKEN = "ghp_..."` (PowerShell) or `export GH_TOKEN=ghp_...` (bash).

Then from a clean `main` branch:

```bash
npm run release            # patch bump (1.0.5 → 1.0.6)
npm run release -- minor   # minor bump
npm run release -- major   # major bump
npm run release -- 1.5.0   # explicit version
```

The script:
- bumps `package.json` version
- builds the renderer + electron-builder artifacts (NSIS installer + portable)
- uploads them as a **draft** GitHub Release with a `latest.yml` manifest
- commits the version bump, tags `vX.Y.Z`, and pushes

Visit `https://github.com/lsparagino/olopdf/releases`, review the draft, and click **Publish release**. NSIS-installed clients pick up the update on next launch.

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
- **Vue 3 + TypeScript + Tailwind v4** — renderer
- **pdf.js (legacy CJS build)** — page rendering and text extraction
- **pdf-lib** — page reordering/merging, text injection, hand-built PDF outlines
- **electron-builder** — Windows NSIS + portable targets
- **electron-updater** — GitHub-Releases-driven auto-updates

## License

MIT
