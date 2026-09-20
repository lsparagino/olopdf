// Turns the errors that reach the UI into something a user can act on. The raw
// text is kept after an em dash when it adds detail, so a bug report still
// carries the original message.

const IPC_PREFIX = /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/
const PDF_PARSE_ERROR = /^Failed to parse (?:PDF document|number) \(line:\d+ col:\d+ offset=\d+\): /

const FS_CODES: Record<string, string> = {
  EBUSY: "the file is open in another program — close it and try again",
  EPERM: "permission denied — the file may be open in another program, or the folder is read-only",
  EACCES: "permission denied — the file may be open in another program, or the folder is read-only",
  ENOENT: 'the file or folder no longer exists',
  ENOSPC: 'the disk is full',
  EROFS: 'the location is read-only',
}

// `unmapped` phrases errors nothing here recognises — typically pdf-lib
// internals like "_this.catalog.Pages is not a function", which only the
// caller can put in context (which step failed, on which file).
export function describeError(err: unknown, unmapped?: (raw: string) => string): string {
  const raw = (err instanceof Error ? err.message : String(err)).replace(IPC_PREFIX, '').trim()
  if (err instanceof Error && err.name === 'PdfPasswordError') return raw

  const code = /\b(E[A-Z]{3,})\b/.exec(raw)?.[1]
  if (code && FS_CODES[code]) return FS_CODES[code]

  if (PDF_PARSE_ERROR.test(raw)) {
    const detail = raw.replace(PDF_PARSE_ERROR, '')
    if (detail === 'No PDF header found') return "this isn't a PDF file"
    const damaged = "the file is damaged and couldn't be read"
    return detail && detail !== '""' ? `${damaged} — ${detail}` : damaged
  }

  if (!raw) return 'unknown error'
  return unmapped ? unmapped(raw) : raw
}
