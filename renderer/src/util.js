'use strict';
const { StandardFonts } = require('pdf-lib');

function hexToRgb01(hex) {
  const m = /^#?([a-f0-9]{6})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: ((n >> 16) & 0xff) / 255, g: ((n >> 8) & 0xff) / 255, b: (n & 0xff) / 255 };
}

function cssFontFamily(font) {
  switch (font) {
    case 'times':   return '"Times New Roman", Times, serif';
    case 'courier': return '"Courier New", Courier, monospace';
    default:        return 'Helvetica, Arial, sans-serif';
  }
}

// Map (family, bold, italic) to one of the 12 PDF base-14 standard fonts.
function pickStandardFont(family, bold, italic) {
  if (family === 'times') {
    if (bold && italic) return StandardFonts.TimesRomanBoldItalic;
    if (bold)           return StandardFonts.TimesRomanBold;
    if (italic)         return StandardFonts.TimesRomanItalic;
    return StandardFonts.TimesRoman;
  }
  if (family === 'courier') {
    if (bold && italic) return StandardFonts.CourierBoldOblique;
    if (bold)           return StandardFonts.CourierBold;
    if (italic)         return StandardFonts.CourierOblique;
    return StandardFonts.Courier;
  }
  if (bold && italic)   return StandardFonts.HelveticaBoldOblique;
  if (bold)             return StandardFonts.HelveticaBold;
  if (italic)           return StandardFonts.HelveticaOblique;
  return StandardFonts.Helvetica;
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function arrayBufferFromBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function readFileAsArrayBuffer(filePath) {
  const fs = require('fs').promises;
  const buf = await fs.readFile(filePath);
  return arrayBufferFromBuffer(buf);
}

module.exports = {
  hexToRgb01, cssFontFamily, pickStandardFont,
  formatBytes, arrayBufferFromBuffer, readFileAsArrayBuffer
};
