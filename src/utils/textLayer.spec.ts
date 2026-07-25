import { describe, expect, it } from 'vitest'
import { shouldScaleTextRun, textRunOrigin } from '@/utils/textLayer'

describe('textRunOrigin', () => {
  it('lifts the box by one ascent above the baseline, not one em', () => {
    // Baseline at y=200, 20px em with a 0.82 ascent ratio → 16.4px above it.
    // Using the full em height instead (the bug this replaced) put the box at
    // 180 and left the bottom fifth of every visible line hit-testing onto the
    // line below.
    const { left, top } = textRunOrigin([20, 0, 0, 20, 50, 200], 16.4, 0)
    expect(left).toBe(50)
    expect(top).toBeCloseTo(183.6, 5)
  })

  it('walks the origin around the rotation so the box still starts on the glyphs', () => {
    const angle = Math.PI / 2
    const { left, top } = textRunOrigin([0, 20, -20, 0, 50, 200], 16, angle)
    expect(left).toBeCloseTo(66, 5)
    expect(top).toBeCloseTo(200, 5)
  })
})

describe('shouldScaleTextRun', () => {
  const isotropic = [12, 0, 0, 12, 0, 0]

  it('corrects the width of any run longer than one character', () => {
    expect(shouldScaleTextRun({ str: 'Discussion:', transform: isotropic })).toBe(true)
    expect(shouldScaleTextRun({ str: '  ', transform: isotropic })).toBe(true)
  })

  it('leaves the pseudo-space between words at its natural width', () => {
    expect(shouldScaleTextRun({ str: ' ', transform: isotropic })).toBe(false)
    expect(shouldScaleTextRun({ str: ' ', transform: [12, 0, 0, 40, 0, 0] })).toBe(false)
  })

  it('leaves a single glyph alone unless the text matrix really stretches it', () => {
    expect(shouldScaleTextRun({ str: 'A', transform: isotropic })).toBe(false)
    expect(shouldScaleTextRun({ str: 'A', transform: [12, 0, 0, 15, 0, 0] })).toBe(false)
    expect(shouldScaleTextRun({ str: 'A', transform: [12, 0, 0, 30, 0, 0] })).toBe(true)
    expect(shouldScaleTextRun({ str: 'A', transform: [-30, 0, 0, 12, 0, 0] })).toBe(true)
  })

  it('does not divide by a zero scale factor', () => {
    expect(shouldScaleTextRun({ str: 'A', transform: [0, 0, 0, 12, 0, 0] })).toBe(false)
    expect(shouldScaleTextRun({ str: 'A', transform: [12, 0, 0, 0, 0, 0] })).toBe(false)
  })
})
