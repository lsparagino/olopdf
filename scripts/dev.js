// Dev orchestrator: starts Vite, waits for the server to be ready, then launches
// Electron with VITE_DEV_SERVER_URL set so main.js loadURL's the dev server.
//
// Resolves vite and electron via require so we can spawn them as plain node/exe binaries
// instead of relying on .cmd shims (which trip Windows' spawn-EINVAL behavior post
// CVE-2024-27980 unless shell: true is set, which then complicates signal handling).
const { spawn } = require('node:child_process')
const path = require('node:path')

// vite v8 doesn't expose the bin via package exports, so resolve through package.json.
const vitePkgPath = require.resolve('vite/package.json')
const viteBin = path.join(path.dirname(vitePkgPath), require(vitePkgPath).bin.vite)
// 'electron' resolves to a string path to the electron executable on disk.
const electronExe = require('electron')

const viteHost = '127.0.0.1'
const vitePort = 5173
const viteUrl = `http://${viteHost}:${vitePort}`

const vite = spawn(
  process.execPath,
  [viteBin, '--host', viteHost, '--port', String(vitePort), '--strictPort'],
  { stdio: ['ignore', 'inherit', 'inherit'] },
)

let electron = null
let exiting = false

function shutdown(code = 0) {
  if (exiting) return
  exiting = true
  if (electron && !electron.killed) electron.kill()
  if (vite && !vite.killed) vite.kill()
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

vite.on('exit', (code) => {
  if (!exiting) {
    console.error(`[dev] vite exited (${code})`)
    shutdown(code ?? 1)
  }
})

async function waitForServer(url, timeoutMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok || res.status === 404) return true
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Vite dev server did not respond within ${timeoutMs}ms`)
}

;(async () => {
  try {
    await waitForServer(viteUrl)
  } catch (e) {
    console.error('[dev]', e.message)
    shutdown(1)
    return
  }

  const projectRoot = path.join(__dirname, '..')
  electron = spawn(electronExe, [projectRoot], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: viteUrl, NODE_ENV: 'development' },
    cwd: projectRoot,
  })

  electron.on('exit', (code) => {
    if (!exiting) shutdown(code ?? 0)
  })
})()
