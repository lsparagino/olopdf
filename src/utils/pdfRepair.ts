// Second-chance load for PDFs that pdf-lib rejects but pdf.js (and so the
// viewer) opens. pdf-lib reads the body object by object and never uses the
// xref table or the startxref offset, yet one bad byte in the header, the xref
// table, the trailer or startxref aborts the whole parse. Here those sections
// are stepped over instead, and a page tree missing the /Type entries pdf-lib
// relies on is completed the way pdf.js reads it. It only runs after a normal
// load has failed, so files that load today are never touched.

import type {
  PDFContext,
  PDFDict as PdfDict,
  PDFDocument as PdfDocument,
  PDFHeader as PdfHeader,
  PDFObject,
  PDFParser as PdfParser,
  PDFRef as PdfRef,
} from 'pdf-lib'

const pdfLib = (window as unknown as { require: (m: string) => typeof import('pdf-lib') }).require(
  'pdf-lib',
)
const { ParseSpeeds, PDFArray, PDFDict, PDFDocument, PDFHeader, PDFName, PDFNumber, PDFParser, PDFRef, PDFWriter } =
  pdfLib

// What pdf.js shows when a page has no usable /MediaBox anywhere up its tree (US Letter).
const DEFAULT_MEDIA_BOX = [0, 0, 612, 792]
const TRAILER_KEYWORD_LENGTH = 'trailer'.length
// pdf.js also only looks this far into a file for its start.
const HEAD_LENGTH = 1024
const OBJECT_HEADER = /\d+\s+\d+\s+obj/

interface ParserInternals {
  bytes: { offset(): number; moveTo(offset: number): void }
  skipWhitespaceAndComments(): void
  parseHeader(): PdfHeader
  maybeParseCrossRefSection(): unknown
  maybeParseTrailerDict(): void
  maybeParseTrailer(): unknown
}

// Resolves to null when the file can't be salvaged, so the caller can report
// the original parse error rather than one from this second attempt.
export async function loadDamagedPdf(bytes: Uint8Array): Promise<PdfDocument | null> {
  // Without a header or an early object this is almost certainly not a PDF,
  // and pdf-lib's byte-by-byte scan for objects would take seconds per
  // megabyte to find nothing.
  if (!includesAscii(bytes, '%PDF-') && !OBJECT_HEADER.test(latin1Head(bytes))) return null
  // An encrypted file can't be decrypted from this parse, and if its trailer
  // is the damaged part, /Encrypt is lost with it and the pages would be copied
  // as ciphertext. Looking for the name in the raw bytes and for the
  // encryption dict among the objects catches both an inline and an indirect one.
  if (includesAscii(bytes, '/Encrypt')) return null
  try {
    const parser = PDFParser.forBytesWithOptions(bytes, ParseSpeeds.Slow)
    skipDamagedFileSections(parser)
    const context = await parser.parseDocument()
    if (hasEncryptionDict(context)) return null
    if (!completePageTree(context)) return null
    // Re-serializing lets pdf-lib's own parser type the catalog and page-tree
    // dicts from the /Type entries filled in above.
    const doc = await PDFDocument.load(await PDFWriter.forContext(context, 50).serializeToBuffer())
    return doc.getPageCount() > 0 ? doc : null
  } catch {
    return null
  }
}

// Same technique as onEachIndirectObject in pdfEncryption.ts: pdf-lib has no
// options for this, so wrap the section readers on this one parser instance.
// Each wrapper calls the original first and only acts when it throws.
function skipDamagedFileSections(parser: PdfParser): void {
  const internals = parser as unknown as ParserInternals
  const { parseHeader, maybeParseCrossRefSection, maybeParseTrailerDict, maybeParseTrailer } = internals
  if (
    typeof parseHeader !== 'function' ||
    typeof maybeParseCrossRefSection !== 'function' ||
    typeof maybeParseTrailerDict !== 'function' ||
    typeof maybeParseTrailer !== 'function' ||
    typeof internals.skipWhitespaceAndComments !== 'function'
  ) {
    throw new Error('this pdf-lib version is not supported for repair')
  }

  // pdf.js doesn't require the header either: with none, or with an
  // unreadable version, it reads objects from byte 0.
  internals.parseHeader = function readHeaderOrDefault(this: ParserInternals) {
    try {
      return parseHeader.call(this)
    } catch {
      this.bytes.moveTo(0)
      return PDFHeader.forVersion(1, 7)
    }
  }
  // The table is never used, and the objects after it are found by pdf-lib's
  // own scan for the next "N G obj" header, which runs after these readers.
  internals.maybeParseCrossRefSection = function readXrefOrSkip(this: ParserInternals) {
    try {
      return maybeParseCrossRefSection.call(this)
    } catch {
      return undefined
    }
  }
  // A damaged trailer only costs /Root, which pdf-lib recovers by looking for
  // the /Type /Catalog object. Resuming right after the keyword, rather than
  // wherever the dict parse gave up, keeps an unterminated string from
  // swallowing any objects that follow.
  internals.maybeParseTrailerDict = function readTrailerOrSkip(this: ParserInternals) {
    const start = this.bytes.offset()
    try {
      maybeParseTrailerDict.call(this)
    } catch {
      this.bytes.moveTo(start)
      this.skipWhitespaceAndComments()
      this.bytes.moveTo(this.bytes.offset() + TRAILER_KEYWORD_LENGTH)
    }
  }
  internals.maybeParseTrailer = function readStartXrefOrSkip(this: ParserInternals) {
    try {
      return maybeParseTrailer.call(this)
    } catch {
      return undefined
    }
  }
}

// pdf-lib only walks page-tree nodes typed /Pages and only returns leaves typed
// /Page. pdf.js instead treats any kid typed /Page, or without /Kids, as a
// page. Returns the page count.
function completePageTree(context: PDFContext): number {
  const root = toRef(context, context.trailerInfo.Root)
  const catalog = context.lookup(root)
  if (!root || !(catalog instanceof PDFDict)) return 0
  context.trailerInfo.Root = root
  setName(catalog, 'Type', 'Catalog')
  const pages = toRef(context, catalog.get(PDFName.of('Pages')))
  if (!pages) return 0
  catalog.set(PDFName.of('Pages'), pages)
  return completePageTreeNode(context, pages, new Set())
}

function completePageTreeNode(context: PDFContext, ref: PdfRef, visited: Set<PdfRef>): number {
  if (visited.has(ref)) return 0
  visited.add(ref)
  const node = context.lookup(ref)
  if (!(node instanceof PDFDict)) return 0

  if (node.get(PDFName.of('Type')) === PDFName.of('Page') || !node.has(PDFName.of('Kids'))) {
    setName(node, 'Type', 'Page')
    if (!hasUsableMediaBox(context, node)) node.set(PDFName.of('MediaBox'), context.obj(DEFAULT_MEDIA_BOX))
    return 1
  }

  const kids = context.lookup(node.get(PDFName.of('Kids')))
  if (!(kids instanceof PDFArray)) return 0
  setName(node, 'Type', 'Pages')
  let count = 0
  for (let i = 0; i < kids.size(); i++) {
    const kid = toRef(context, kids.get(i))
    if (!kid) continue
    kids.set(i, kid)
    count += completePageTreeNode(context, kid, visited)
  }
  node.set(PDFName.of('Count'), PDFNumber.of(count))
  return count
}

// PDFDocument holds the catalog by ref and PDFPage needs one for every page,
// which a dict written inline doesn't have.
function toRef(context: PDFContext, obj: PDFObject | undefined): PdfRef | undefined {
  if (obj instanceof PDFRef) return obj
  if (obj instanceof PDFDict) return context.register(obj)
  return undefined
}

// Follows /Parent the way both pdf-lib and pdf.js resolve inherited attributes.
function hasUsableMediaBox(context: PDFContext, page: PdfDict): boolean {
  const seen = new Set<PdfDict>()
  for (let node: PDFObject | undefined = page; node instanceof PDFDict && !seen.has(node); ) {
    seen.add(node)
    const box = context.lookup(node.get(PDFName.of('MediaBox')))
    if (box instanceof PDFArray) {
      return box.size() === 4 && box.asArray().every((n) => context.lookup(n) instanceof PDFNumber)
    }
    node = context.lookup(node.get(PDFName.of('Parent')))
  }
  return false
}

function hasEncryptionDict(context: PDFContext): boolean {
  return context
    .enumerateIndirectObjects()
    .some(
      ([, obj]) =>
        obj instanceof PDFDict &&
        obj.has(PDFName.of('Filter')) &&
        obj.has(PDFName.of('O')) &&
        obj.has(PDFName.of('U')) &&
        obj.has(PDFName.of('P')),
    )
}

function includesAscii(bytes: Uint8Array, text: string): boolean {
  const first = text.charCodeAt(0)
  for (let i = bytes.indexOf(first); i !== -1; i = bytes.indexOf(first, i + 1)) {
    let j = 1
    while (j < text.length && bytes[i + j] === text.charCodeAt(j)) j++
    if (j === text.length) return true
  }
  return false
}

function latin1Head(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes.subarray(0, HEAD_LENGTH))
}

function setName(dict: PdfDict, key: string, value: string): void {
  if (dict.get(PDFName.of(key)) !== PDFName.of(value)) dict.set(PDFName.of(key), PDFName.of(value))
}
