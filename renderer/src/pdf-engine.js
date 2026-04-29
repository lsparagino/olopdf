'use strict';
// pdf.js setup. The worker is loaded as a Blob URL — works under asar packaging
// where a path-based workerSrc would not.
const fs = require('fs');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

(function setupWorker() {
  try {
    const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.js');
    const code = fs.readFileSync(workerPath, 'utf-8');
    const blob = new Blob([code], { type: 'application/javascript' });
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
  } catch (e) {
    console.error('pdf.js worker setup failed', e);
  }
})();

module.exports = { pdfjsLib };
