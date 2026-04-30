// Cuts a new release: bumps version, builds, publishes artifacts to GitHub,
// then tags + pushes.
//
// Auth (in priority order):
//   1. $env:GH_TOKEN / $env:GITHUB_TOKEN if set
//   2. `gh auth token` from the GitHub CLI (run `gh auth login` once)
//   3. Otherwise: prompts the user to set up either of the above
//
// Usage:
//   npm run release            # patch bump (default)
//   npm run release -- minor   # minor bump
//   npm run release -- major   # major bump
//   npm run release -- 1.2.3   # explicit version
//
// electron-builder reads GH_TOKEN from the environment and creates a DRAFT
// release containing OloPDF-Setup-<version>.exe + OloPDF-Portable-<version>.exe
// + latest.yml. Once you publish the draft on GitHub, NSIS-installed clients
// pick up the update automatically via electron-updater.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const pkgPath = path.join(root, 'package.json')

// Only npm/npx/gh ship as .cmd shims on Windows, which require shell:true to
// invoke. Direct .exe binaries (git, node) must NOT use shell — cmd.exe
// argument parsing mangles colons, parens, and quotes inside our messages.
const SHELL_SHIMS = /^(npm|npx|yarn|pnpm|gh)$/
function needsShell(cmd) {
  return process.platform === 'win32' && SHELL_SHIMS.test(cmd)
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, shell: needsShell(cmd), ...opts })
  if (res.status !== 0) {
    console.error(`\n[release] command failed: ${cmd} ${args.join(' ')}`)
    process.exit(res.status ?? 1)
  }
}

function capture(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: root, shell: needsShell(cmd), encoding: 'utf-8' })
  if (res.status !== 0) {
    console.error(res.stderr)
    process.exit(res.status ?? 1)
  }
  return res.stdout.trim()
}

function tryGhToken() {
  const res = spawnSync('gh', ['auth', 'token'], { shell: needsShell('gh'), encoding: 'utf-8' })
  if (res.status !== 0) return null
  const token = res.stdout.trim()
  return token || null
}

if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  const ghToken = tryGhToken()
  if (ghToken) {
    process.env.GH_TOKEN = ghToken
    console.log('[release] using token from `gh auth`')
  } else {
    console.error('[release] No GitHub token found. Pick one:')
    console.error('[release]   • install GitHub CLI + run `gh auth login` (recommended)')
    console.error('[release]     winget install GitHub.cli')
    console.error('[release]   • or create a fine-grained PAT (Contents: read & write) and set:')
    console.error('[release]     $env:GH_TOKEN = "ghp_..."     # PowerShell')
    console.error('[release]     export GH_TOKEN=ghp_...        # bash')
    process.exit(1)
  }
}

const status = capture('git', ['status', '--porcelain'])
if (status) {
  console.error('[release] working tree not clean — commit or stash first:\n' + status)
  process.exit(1)
}

const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch !== 'main') {
  console.error(`[release] release must be cut from main (current branch: ${branch}).`)
  process.exit(1)
}

const arg = process.argv[2] || 'patch'
const bumpKind = ['patch', 'minor', 'major'].includes(arg) ? arg : null

console.log(`[release] bumping version (${bumpKind ?? `to ${arg}`})…`)
if (bumpKind) {
  run('npm', ['version', bumpKind, '--no-git-tag-version'])
} else {
  run('npm', ['version', arg, '--no-git-tag-version', '--allow-same-version'])
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
const version = pkg.version
console.log(`[release] new version: v${version}`)

// Commit + tag BEFORE building so the published artifacts correspond to the
// tagged commit. If publishing fails after this point, the user can re-run
// `electron-builder --publish always` directly without re-bumping.
console.log('[release] committing version bump and tagging…')
run('git', ['add', 'package.json', 'package-lock.json'])
run('git', ['commit', '-m', `chore(release): v${version}`])
run('git', ['tag', '-a', `v${version}`, '-m', `OloPDF v${version}`])

console.log('[release] building renderer…')
run('npm', ['run', 'build:renderer'])

console.log('[release] building installer + portable, publishing to GitHub…')
run('npx', ['electron-builder', '--win', '--publish', 'always'])

console.log('[release] pushing commit + tag…')
run('git', ['push', '--follow-tags'])

console.log(`\n[release] Done. v${version} draft release uploaded to GitHub.`)
console.log('[release] Visit https://github.com/lsparagino/olopdf/releases — review and publish the draft to roll out auto-updates.')
