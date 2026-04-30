// Generates build/icon.ico (Windows) and build/icon.png (1024x1024) from build/icon.svg.
// electron-builder uses build/icon.ico for the win exe and Start Menu shortcut.
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const here = path.dirname(fileURLToPath(import.meta.url))
const buildDir = path.join(here, '..', 'build')
const svgPath = path.join(buildDir, 'icon.svg')

const svg = await readFile(svgPath)

const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const buffers = await Promise.all(
  icoSizes.map((size) =>
    sharp(svg, { density: 384 }).resize(size, size).png().toBuffer(),
  ),
)
const ico = await pngToIco(buffers)
await writeFile(path.join(buildDir, 'icon.ico'), ico)

const png1024 = await sharp(svg, { density: 384 }).resize(1024, 1024).png().toBuffer()
await writeFile(path.join(buildDir, 'icon.png'), png1024)

console.log(`build/icon.ico (${ico.length} bytes) + build/icon.png (${png1024.length} bytes) generated.`)
