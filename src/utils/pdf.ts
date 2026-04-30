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
