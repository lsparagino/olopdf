// pdf-lib loaded via window.require (nodeIntegration: true), kept out of the bundle.
const pdfLib = (window as unknown as { require: (m: string) => typeof import('pdf-lib') }).require(
  'pdf-lib',
)
const { StandardFonts } = pdfLib

export interface Rgb01 {
  r: number
  g: number
  b: number
}

export type FontFamily = 'helvetica' | 'times' | 'courier'

export function hexToRgb01(hex: string): Rgb01 {
  const m = /^#?([a-f0-9]{6})$/i.exec(hex)
  if (!m) return { r: 0, g: 0, b: 0 }
  const n = parseInt(m[1], 16)
  return {
    r: ((n >> 16) & 0xff) / 255,
    g: ((n >> 8) & 0xff) / 255,
    b: (n & 0xff) / 255,
  }
}

export function cssFontFamily(font: FontFamily): string {
  switch (font) {
    case 'times':
      return '"Times New Roman", Times, serif'
    case 'courier':
      return '"Courier New", Courier, monospace'
    default:
      return 'Helvetica, Arial, sans-serif'
  }
}

export function pickStandardFont(
  family: FontFamily,
  bold: boolean,
  italic: boolean,
): (typeof StandardFonts)[keyof typeof StandardFonts] {
  if (family === 'times') {
    if (bold && italic) return StandardFonts.TimesRomanBoldItalic
    if (bold) return StandardFonts.TimesRomanBold
    if (italic) return StandardFonts.TimesRomanItalic
    return StandardFonts.TimesRoman
  }
  if (family === 'courier') {
    if (bold && italic) return StandardFonts.CourierBoldOblique
    if (bold) return StandardFonts.CourierBold
    if (italic) return StandardFonts.CourierOblique
    return StandardFonts.Courier
  }
  if (bold && italic) return StandardFonts.HelveticaBoldOblique
  if (bold) return StandardFonts.HelveticaBold
  if (italic) return StandardFonts.HelveticaOblique
  return StandardFonts.Helvetica
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function normalizeRotation(deg: number): 0 | 90 | 180 | 270 {
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360
  return r as 0 | 90 | 180 | 270
}

// Given a rotated viewport's (width, height), return the unrotated page dims.
export function unrotatedDims(
  rotatedW: number,
  rotatedH: number,
  rotation: number,
): { uW: number; uH: number } {
  const r = normalizeRotation(rotation)
  if (r === 90 || r === 270) return { uW: rotatedH, uH: rotatedW }
  return { uW: rotatedW, uH: rotatedH }
}

// Top-left → top-left transform from unrotated PDF user-space (zoom=1) to a
// canvas rotated by R degrees CW (zoom=1). uW/uH are the unrotated page dims.
export function forwardTransform(
  x: number,
  y: number,
  uW: number,
  uH: number,
  rotation: number,
): { cx: number; cy: number } {
  const r = normalizeRotation(rotation)
  if (r === 0) return { cx: x, cy: y }
  if (r === 90) return { cx: uH - y, cy: x }
  if (r === 180) return { cx: uW - x, cy: uH - y }
  return { cx: y, cy: uW - x }
}

// Inverse of forwardTransform: rotated-canvas (zoom=1) → unrotated user-space (zoom=1).
export function inverseTransform(
  cx: number,
  cy: number,
  uW: number,
  uH: number,
  rotation: number,
): { x: number; y: number } {
  const r = normalizeRotation(rotation)
  if (r === 0) return { x: cx, y: cy }
  if (r === 90) return { x: cy, y: uH - cx }
  if (r === 180) return { x: uW - cx, y: uH - cy }
  return { x: uW - cy, y: cx }
}

// Inverse-rotate a (dx, dy) delta expressed in rotated-canvas axes back to
// unrotated-page axes. Used for drag handling so a screen-space drag updates
// (ann.x, ann.y) in the unrotated coordinate system.
export function inverseDelta(
  dx: number,
  dy: number,
  rotation: number,
): { dx: number; dy: number } {
  const r = normalizeRotation(rotation)
  if (r === 0) return { dx, dy }
  if (r === 90) return { dx: dy, dy: -dx }
  if (r === 180) return { dx: -dx, dy: -dy }
  return { dx: -dy, dy: dx }
}
