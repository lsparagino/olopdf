// Pure geometry for the invisible, selectable text layer drawn over the page
// canvas. Lives apart from usePdfRenderer so the decisions that place a span can
// be exercised without a DOM or a pdf.js document — they're subtle enough that a
// regression is invisible on screen but immediately felt when selecting text.

export interface TextRunGeometry {
  str: string
  // The run's own text matrix, as pdf.js reports it on a TextContent item.
  transform: number[]
}

export interface RunOrigin {
  left: number
  top: number
}

// Top-left corner of a run's span box, given the run's transform composed into
// viewport space. tx[4]/tx[5] is where the run's *baseline* starts, so the box's
// top edge belongs one ascent above it — not one full em, which would ride the
// box up off the glyphs by the height of the descender.
export function textRunOrigin(tx: number[], ascent: number, angle: number): RunOrigin {
  if (angle === 0) return { left: tx[4], top: tx[5] - ascent }
  return {
    left: tx[4] + ascent * Math.sin(angle),
    top: tx[5] - ascent * Math.cos(angle),
  }
}

// Whether a run's span should be stretched to the width pdf.js painted.
//
// Multi-character runs always should: the DOM renders them in a substitute
// family whose advances differ from the embedded font's. Single characters are
// left alone because pdf.js synthesises a one-space item for the gap between two
// words and reports the *glyph* advance for it rather than the width of the gap —
// squeezing those down would open a dead strip between every pair of words where
// a click hits nothing. A lone glyph the text matrix genuinely stretches is the
// exception, and gets corrected like any other run.
export function shouldScaleTextRun(run: TextRunGeometry): boolean {
  if (run.str.length > 1) return true
  if (run.str === ' ') return false
  const sx = Math.abs(run.transform[0])
  const sy = Math.abs(run.transform[3])
  if (sx === sy || sx === 0 || sy === 0) return false
  return Math.max(sx, sy) / Math.min(sx, sy) > 1.5
}
