'use strict';
// Assemble the saved PDF: copy pages in current order, draw text annotations,
// apply repeat texts to every page, and hand-build the outline.
const path = require('path');
const fs = require('fs');
const { ipcRenderer } = require('electron');
const {
  PDFDocument, rgb, PDFName, PDFString, PDFArray, PDFNumber
} = require('pdf-lib');
const { $, toast, showLoading, hideLoading } = require('./dom');
const { state } = require('./state');
const { hexToRgb01, pickStandardFont } = require('./util');

async function savePdf() {
  if (!state.pdfBytes) return;
  try {
    const defaultName = state.filePath
      ? path.basename(state.filePath, path.extname(state.filePath)) + '-edited.pdf'
      : 'edited.pdf';
    const r = await ipcRenderer.invoke('dialog:save', {
      defaultPath: defaultName,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (r.canceled || !r.filePath) return;

    showLoading('Saving PDF...');
    const srcDoc = await PDFDocument.load(state.pdfBytes);
    const newDoc = await PDFDocument.create();

    const fontCache = new Map();
    const getFont = async (name) => {
      if (!fontCache.has(name)) fontCache.set(name, await newDoc.embedFont(name));
      return fontCache.get(name);
    };

    const copied = await newDoc.copyPages(srcDoc, state.pageOrder);
    const origToNewIdx = new Map();
    copied.forEach((p, i) => {
      newDoc.addPage(p);
      origToNewIdx.set(state.pageOrder[i], i);
    });

    // Per-page text
    for (const a of state.textAnnotations) {
      const newIdx = origToNewIdx.get(a.pageOriginalIdx);
      if (newIdx === undefined) continue;
      await drawTextOnPage(newDoc.getPage(newIdx), a, getFont);
    }
    // Repeat texts → every page
    if (state.repeatTexts.length > 0) {
      for (let pi = 0; pi < newDoc.getPageCount(); pi++) {
        const page = newDoc.getPage(pi);
        for (const a of state.repeatTexts) await drawTextOnPage(page, a, getFont);
      }
    }
    // Bookmarks
    if (state.bookmarks.length > 0) {
      addOutline(newDoc, state.bookmarks
        .map(b => ({
          title: b.title,
          pageIndex: origToNewIdx.get(b.pageOriginalIdx),
          x: b.x,
          y: b.y
        }))
        .filter(b => b.pageIndex !== undefined));
    }

    const out = await newDoc.save();
    await fs.promises.writeFile(r.filePath, Buffer.from(out));
    hideLoading();
    toast('Saved to ' + path.basename(r.filePath), 'success');
  } catch (err) {
    console.error(err);
    hideLoading();
    toast('Save failed: ' + err.message, 'error');
  }
}

async function drawTextOnPage(page, a, getFont) {
  const fontName = pickStandardFont(a.font || 'helvetica', !!a.bold, !!a.italic);
  const font = await getFont(fontName);
  const { height } = page.getSize();
  const { r, g, b } = hexToRgb01(a.color);
  const baselineY = height - a.y - a.size;
  page.drawText(a.text, {
    x: a.x,
    y: baselineY,
    size: a.size,
    font,
    color: rgb(r, g, b)
  });
  if (a.underline) {
    let textWidth;
    try { textWidth = font.widthOfTextAtSize(a.text, a.size); }
    catch (_) { textWidth = a.text.length * a.size * 0.5; }
    const ulY = baselineY - Math.max(1, a.size * 0.08);
    page.drawLine({
      start: { x: a.x, y: ulY },
      end:   { x: a.x + textWidth, y: ulY },
      thickness: Math.max(0.5, a.size * 0.06),
      color: rgb(r, g, b)
    });
  }
}

// Hand-built /Outlines tree. pdf-lib has no high-level outline API.
function addOutline(pdfDoc, items) {
  if (items.length === 0) return;
  const ctx = pdfDoc.context;
  const outlinesRef = ctx.nextRef();
  const itemRefs = items.map(() => ctx.nextRef());

  items.forEach((it, i) => {
    const page = pdfDoc.getPage(it.pageIndex);
    const { height } = page.getSize();
    const dest = PDFArray.withContext(ctx);
    dest.push(page.ref);
    dest.push(PDFName.of('XYZ'));
    if (it.x !== undefined && it.y !== undefined) {
      dest.push(PDFNumber.of(it.x));
      dest.push(PDFNumber.of(height - it.y));
      dest.push(ctx.obj(null));
    } else {
      dest.push(ctx.obj(null));
      dest.push(ctx.obj(null));
      dest.push(ctx.obj(null));
    }
    const dict = ctx.obj({
      Title: PDFString.of(it.title),
      Parent: outlinesRef,
      Dest: dest
    });
    if (i > 0) dict.set(PDFName.of('Prev'), itemRefs[i - 1]);
    if (i < items.length - 1) dict.set(PDFName.of('Next'), itemRefs[i + 1]);
    ctx.assign(itemRefs[i], dict);
  });

  ctx.assign(outlinesRef, ctx.obj({
    Type: PDFName.of('Outlines'),
    First: itemRefs[0],
    Last: itemRefs[itemRefs.length - 1],
    Count: items.length
  }));
  pdfDoc.catalog.set(PDFName.of('Outlines'), outlinesRef);
  pdfDoc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

$('saveBtn').addEventListener('click', savePdf);

module.exports = { savePdf };
