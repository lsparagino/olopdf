// pdf.js loaded via window.require (nodeIntegration: true) so the bundler
// never sees it.
//
// Worker is loaded as a Blob URL from the resolved Node path of pdf.worker.js.
// Reason: this works in dev (Vite serves bundled JS but Node still resolves node_modules)
// and in prod (electron-builder includes node_modules in the asar; require.resolve still
// resolves there). A path-based GlobalWorkerOptions.workerSrc breaks under asar — keep
// the Blob URL trick.

type PdfjsLib = typeof import('pdfjs-dist')

let pdfjsLib: PdfjsLib | null = null
let workerInitialized = false

function getElectronRequire(): (m: string) => unknown {
  return (window as unknown as { require: (m: string) => unknown }).require
}

function setupWorker(lib: PdfjsLib) {
  if (workerInitialized) return
  workerInitialized = true
  try {
    const req = getElectronRequire()
    const fs = req('fs') as typeof import('fs')
    const workerPath = (req as NodeJS.Require).resolve('pdfjs-dist/legacy/build/pdf.worker.js')
    const code = fs.readFileSync(workerPath, 'utf-8')
    const blob = new Blob([code], { type: 'application/javascript' })
    lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob)
  } catch (e) {
    console.error('pdf.js worker setup failed', e)
  }
}

export function usePdfjs(): PdfjsLib {
  if (!pdfjsLib) {
    const req = getElectronRequire()
    pdfjsLib = req('pdfjs-dist/legacy/build/pdf.js') as PdfjsLib
    setupWorker(pdfjsLib)
  }
  return pdfjsLib
}
