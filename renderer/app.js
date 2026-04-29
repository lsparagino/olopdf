'use strict';
// Entry point. Each required module wires up its own DOM listeners on load.
// Order matters only for cycles — see CLAUDE.md.

require('./src/pdf-engine');     // sets up the pdf.js worker
require('./src/chrome');         // window controls + zoom intercept + escape
require('./src/welcome');        // welcome screen + recents + curator + file open
require('./src/viewer');         // page + text-layer rendering
require('./src/thumbnails');     // sidebar thumbs + grid view
require('./src/pages');          // navigation + delete + move
require('./src/text');           // text annotation modal + placed-text overlay
require('./src/zoom-pan');       // zoom buttons + wheel zoom + pan
require('./src/bookmarks');      // bookmark modal + sidebar
require('./src/save');           // save PDF
require('./src/merge');          // merge mode

const { showScreen } = require('./src/dom');
showScreen('welcome');
