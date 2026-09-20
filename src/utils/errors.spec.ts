import { describe, expect, it } from 'vitest'
import { describeError } from '@/utils/errors'

describe('describeError', () => {
  it('explains a locked output file instead of echoing the IPC wrapper', () => {
    const err = new Error(
      "Error invoking remote method 'fs:writeFile': Error: EBUSY: resource busy or locked, open 'C:\\out\\merged.pdf'",
    )
    expect(describeError(err)).toBe('the file is open in another program — close it and try again')
  })

  it('maps permission errors', () => {
    const err = new Error("Error invoking remote method 'fs:writeFile': Error: EPERM: operation not permitted, open 'x'")
    expect(describeError(err)).toMatch(/^permission denied/)
  })

  it('names a file that is not a PDF at all', () => {
    const err = new Error('Failed to parse PDF document (line:2 col:0 offset=55): No PDF header found')
    expect(describeError(err)).toBe("this isn't a PDF file")
  })

  it('drops the parser position but keeps the detail for damaged files', () => {
    const err = new Error('Failed to parse PDF document (line:12 col:4 offset=9001): Failed to parse invalid PDF object')
    expect(describeError(err)).toBe("the file is damaged and couldn't be read — Failed to parse invalid PDF object")
  })

  it('treats pdf-lib number-parse failures as damage, without an empty detail', () => {
    const err = new Error('Failed to parse number (line:3 col:9 offset=120): ""')
    expect(describeError(err)).toBe("the file is damaged and couldn't be read")
  })

  it('lets the caller phrase errors it knows the context of', () => {
    const err = new TypeError('_this.catalog.Pages is not a function')
    expect(describeError(err, (raw) => `the file's page structure is damaged — ${raw}`)).toBe(
      "the file's page structure is damaged — _this.catalog.Pages is not a function",
    )
    // Recognised errors are never passed to the caller's phrasing.
    const busy = new Error("Error invoking remote method 'fs:readFile': Error: EBUSY: resource busy or locked")
    expect(describeError(busy, () => 'wrong')).toBe('the file is open in another program — close it and try again')
  })

  it('keeps the password message as written', () => {
    const err = new Error('the file is password-protected')
    err.name = 'PdfPasswordError'
    expect(describeError(err)).toBe('the file is password-protected')
  })

  it('does not mistake an unrelated upper-case token for an fs error code', () => {
    expect(describeError(new Error('Unexpected EOF in stream'))).toBe('Unexpected EOF in stream')
  })

  it('handles non-Error throws', () => {
    expect(describeError('boom')).toBe('boom')
    expect(describeError('')).toBe('unknown error')
  })
})
