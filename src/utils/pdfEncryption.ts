// Decrypts Standard Security Handler PDFs (ISO 32000-2 §7.6.4, revisions 2–6)
// so pdf-lib can edit them. pdf-lib parses encrypted files but can't decrypt
// them: its `ignoreEncryption` escape hatch copies still-encrypted streams into
// an output that no longer carries the key, so those pages come out blank, and
// files with compressed object streams don't load at all. pdf.js decrypts
// internally but gives no way to get the plaintext objects back out.

import type {
  PDFContext,
  PDFDict as PdfDict,
  PDFDocument as PdfDocument,
  PDFObject,
  PDFParser as PdfParser,
  PDFRef as PdfRef,
} from 'pdf-lib'

const pdfLib = (window as unknown as { require: (m: string) => typeof import('pdf-lib') }).require(
  'pdf-lib',
)
const {
  ParseSpeeds,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFParser,
  PDFRawStream,
  PDFRef,
  PDFString,
  PDFWriter,
} = pdfLib

interface NodeHash {
  update(data: Uint8Array): NodeHash
  digest(): Uint8Array
}
interface NodeCipher {
  setAutoPadding(on: boolean): NodeCipher
  update(data: Uint8Array): Uint8Array
  final(): Uint8Array
}
interface NodeCrypto {
  createHash(algorithm: string): NodeHash
  createCipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): NodeCipher
  createDecipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): NodeCipher
}

const nodeCrypto = (window as unknown as { require: (m: string) => NodeCrypto }).require('crypto')

type CipherKind = 'none' | 'rc4' | 'aesv2' | 'aesv3'

interface SecurityHandler {
  fileKey: Uint8Array
  stringCipher: CipherKind
  streamCipher: CipherKind
  encryptMetadata: boolean
  encryptRef: PdfRef | null
}

interface EncryptParams {
  revision: number
  keyLength: number
  owner: Uint8Array
  user: Uint8Array
  ownerEncrypted: Uint8Array
  userEncrypted: Uint8Array
  permissions: number
  firstId: Uint8Array
  encryptMetadata: boolean
}

export class PdfPasswordError extends Error {
  constructor() {
    super('the file is password-protected')
    this.name = 'PdfPasswordError'
  }
}

export async function loadPdfDocument(bytes: ArrayBuffer | Uint8Array): Promise<PdfDocument> {
  // Checking isEncrypted rather than catching EncryptedPDFError: pdf-lib ships
  // as ES5, where Error subclasses lose their prototype and instanceof fails.
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  if (!doc.isEncrypted) return doc
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return PDFDocument.load(await decryptPdf(view))
}

export async function decryptPdf(bytes: Uint8Array, password = ''): Promise<Uint8Array> {
  const handler = await readSecurityHandler(bytes, password)
  // A second full parse, because object streams must be decrypted before
  // pdf-lib unpacks them, and the key isn't known until the /Encrypt dict has
  // been read — which usually sits at the end of the file.
  const parser = PDFParser.forBytesWithOptions(bytes, ParseSpeeds.Slow)
  onEachIndirectObject(parser, (ref, obj) => decryptObject(handler, ref, obj))
  const context = await parser.parseDocument()
  context.trailerInfo.Encrypt = undefined
  if (handler.encryptRef) context.delete(handler.encryptRef)
  return PDFWriter.forContext(context, 50).serializeToBuffer()
}

async function readSecurityHandler(bytes: Uint8Array, password: string): Promise<SecurityHandler> {
  const parser = PDFParser.forBytesWithOptions(bytes, ParseSpeeds.Slow)
  // Object streams are still ciphertext on this pass; hide them so pdf-lib
  // doesn't try to unpack garbage. The /Encrypt dict is never inside one (§7.5.7).
  onEachIndirectObject(parser, (_ref, obj) => (isStreamOfType(obj, 'ObjStm') ? PDFNull : obj))
  const context = await parser.parseDocument()

  const encryptEntry = context.trailerInfo.Encrypt
  const encrypt = context.lookup(encryptEntry)
  if (!(encrypt instanceof PDFDict)) throw new Error('missing encryption dictionary')
  const filter = encrypt.get(PDFName.of('Filter'))
  if (filter !== PDFName.of('Standard')) {
    throw new Error(`unsupported encryption (${String(filter)}); only password encryption can be removed`)
  }

  const version = numberEntry(encrypt, 'V') ?? 0
  const revision = numberEntry(encrypt, 'R') ?? 0
  const stringCipher = cipherFor(encrypt, version, 'StrF')
  const streamCipher = cipherFor(encrypt, version, 'StmF')
  const encryptMetadata = encrypt.get(PDFName.of('EncryptMetadata'))?.toString() !== 'false'
  const params: EncryptParams = {
    revision,
    keyLength: keyLengthBytes(encrypt, version, revision),
    owner: stringEntry(encrypt, 'O'),
    user: stringEntry(encrypt, 'U'),
    ownerEncrypted: stringEntry(encrypt, 'OE'),
    userEncrypted: stringEntry(encrypt, 'UE'),
    permissions: numberEntry(encrypt, 'P') ?? 0,
    firstId: firstIdBytes(context),
    encryptMetadata,
  }
  const fileKey =
    revision >= 5 ? aes256FileKey(password, params) : legacyFileKey(password, params)
  if (!fileKey) throw new PdfPasswordError()

  return {
    fileKey,
    stringCipher,
    streamCipher,
    encryptMetadata,
    encryptRef: encryptEntry instanceof PDFRef ? encryptEntry : null,
  }
}

// pdf-lib has no per-object parse hook, so wrap two methods on this one parser
// instance: the header read says which object comes next, and the following
// parseObject() call returns its value. Dict entries and array items recurse
// through parseObject() too, which is why the pending ref is consumed on first use.
function onEachIndirectObject(
  parser: PdfParser,
  transform: (ref: PdfRef, obj: PDFObject) => PDFObject,
): void {
  const internals = parser as unknown as {
    parseIndirectObjectHeader: () => PdfRef
    parseObject: () => PDFObject
  }
  const readHeader = internals.parseIndirectObjectHeader
  const readObject = internals.parseObject
  if (typeof readHeader !== 'function' || typeof readObject !== 'function') {
    throw new Error('this pdf-lib version is not supported for decryption')
  }
  let pending: PdfRef | null = null
  internals.parseIndirectObjectHeader = function parseIndirectObjectHeader() {
    pending = readHeader.call(this)
    return pending
  }
  internals.parseObject = function parseObject() {
    const ref = pending
    pending = null
    const obj = readObject.call(this)
    return ref ? transform(ref, obj) : obj
  }
}

function decryptObject(handler: SecurityHandler, ref: PdfRef, obj: PDFObject): PDFObject {
  if (handler.encryptRef && ref === handler.encryptRef) return obj
  // Cross-reference streams are never encrypted; pdf-lib reads them right after this returns.
  if (isStreamOfType(obj, 'XRef')) return obj

  const stringKey = objectKey(handler, ref, handler.stringCipher)
  function decryptString(data: Uint8Array): Uint8Array {
    return decryptBytes(handler.stringCipher, stringKey, data)
  }
  if (!(obj instanceof PDFRawStream)) return decryptStrings(obj, decryptString)

  decryptStrings(obj.dict, decryptString)
  if (isStreamOfType(obj, 'Metadata') && !handler.encryptMetadata) return obj
  const key = objectKey(handler, ref, handler.streamCipher)
  return PDFRawStream.of(obj.dict, decryptBytes(handler.streamCipher, key, obj.contents))
}

function decryptStrings(obj: PDFObject, decrypt: (data: Uint8Array) => Uint8Array): PDFObject {
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    return PDFHexString.of(toHex(decrypt(obj.asBytes())))
  }
  if (obj instanceof PDFDict) {
    for (const [key, value] of obj.entries()) obj.set(key, decryptStrings(value, decrypt))
  } else if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) obj.set(i, decryptStrings(obj.get(i), decrypt))
  }
  return obj
}

function isStreamOfType(obj: PDFObject, type: string): boolean {
  return obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Type')) === PDFName.of(type)
}

function cipherFor(
  encrypt: PdfDict,
  version: number,
  entry: 'StrF' | 'StmF',
): CipherKind {
  if (version < 4) return 'rc4'
  const filterName = encrypt.get(PDFName.of(entry)) ?? PDFName.of('Identity')
  if (filterName === PDFName.of('Identity')) return 'none'
  if (!(filterName instanceof PDFName)) throw new Error(`invalid /${entry} crypt filter`)
  const filters = encrypt.lookupMaybe(PDFName.of('CF'), PDFDict)
  const method = filters?.lookupMaybe(filterName, PDFDict)?.get(PDFName.of('CFM'))
  switch (method?.toString()) {
    case '/V2':
      return 'rc4'
    case '/AESV2':
      return 'aesv2'
    case '/AESV3':
      return 'aesv3'
    case '/None':
      return 'none'
    default:
      throw new Error(`unsupported crypt filter method ${String(method)}`)
  }
}

function keyLengthBytes(encrypt: PdfDict, version: number, revision: number): number {
  if (revision === 2) return 5
  if (revision >= 5) return 32
  let bits = numberEntry(encrypt, 'Length')
  if (version === 4) {
    const filters = encrypt.lookupMaybe(PDFName.of('CF'), PDFDict)
    const stmFilter = encrypt.get(PDFName.of('StmF'))
    const filter =
      stmFilter instanceof PDFName ? filters?.lookupMaybe(stmFilter, PDFDict) : undefined
    const filterLength = filter ? numberEntry(filter, 'Length') : undefined
    // Crypt filter dicts give /Length in bytes per the spec, but writers disagree.
    if (filterLength) bits = filterLength <= 32 ? filterLength * 8 : filterLength
  }
  return (bits ?? 40) / 8
}

function numberEntry(dict: PdfDict, key: string): number | undefined {
  return dict.lookupMaybe(PDFName.of(key), PDFNumber)?.asNumber()
}

function stringEntry(dict: PdfDict, key: string): Uint8Array {
  const value = dict.lookup(PDFName.of(key))
  return value instanceof PDFString || value instanceof PDFHexString
    ? value.asBytes()
    : new Uint8Array(0)
}

function firstIdBytes(context: PDFContext): Uint8Array {
  const ids = context.lookup(context.trailerInfo.ID)
  if (!(ids instanceof PDFArray) || ids.size() === 0) return new Uint8Array(0)
  const first = ids.lookup(0)
  return first instanceof PDFString || first instanceof PDFHexString
    ? first.asBytes()
    : new Uint8Array(0)
}

// ── Key derivation ──────────────────────────────────────────────────────────

const PASSWORD_PADDING = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
])

// Revisions 2–4 (RC4 / AES-128): Algorithm 2, verified against /U with
// Algorithms 4/5; the owner password unlocks the user password via Algorithm 7.
function legacyFileKey(password: string, p: EncryptParams): Uint8Array | null {
  const candidate = latin1Bytes(password)
  const asUser = legacyKeyFromUserPassword(candidate, p)
  if (legacyUserKeyMatches(asUser, p)) return asUser
  const asOwner = legacyKeyFromUserPassword(userPasswordFromOwner(candidate, p), p)
  return legacyUserKeyMatches(asOwner, p) ? asOwner : null
}

function legacyKeyFromUserPassword(password: Uint8Array, p: EncryptParams): Uint8Array {
  const permissions = new Uint8Array(4)
  new DataView(permissions.buffer).setInt32(0, p.permissions, true)
  const skipMetadata =
    p.revision >= 4 && !p.encryptMetadata ? Uint8Array.of(0xff, 0xff, 0xff, 0xff) : new Uint8Array(0)
  let hash = digest(
    'md5',
    padPassword(password),
    p.owner.subarray(0, 32),
    permissions,
    p.firstId,
    skipMetadata,
  )
  if (p.revision >= 3) {
    for (let i = 0; i < 50; i++) hash = digest('md5', hash.subarray(0, p.keyLength))
  }
  return hash.subarray(0, p.keyLength)
}

function legacyUserKeyMatches(key: Uint8Array, p: EncryptParams): boolean {
  if (p.revision === 2) return bytesEqual(rc4(key, PASSWORD_PADDING), p.user.subarray(0, 32))
  let check = rc4(key, digest('md5', PASSWORD_PADDING, p.firstId))
  for (let i = 1; i <= 19; i++) check = rc4(xorEach(key, i), check)
  return bytesEqual(check, p.user.subarray(0, 16))
}

function userPasswordFromOwner(ownerPassword: Uint8Array, p: EncryptParams): Uint8Array {
  let hash = digest('md5', padPassword(ownerPassword))
  if (p.revision >= 3) {
    for (let i = 0; i < 50; i++) hash = digest('md5', hash)
  }
  const key = hash.subarray(0, p.keyLength)
  let userPassword = p.owner.subarray(0, 32)
  if (p.revision === 2) return rc4(key, userPassword)
  for (let i = 19; i >= 0; i--) userPassword = rc4(xorEach(key, i), userPassword)
  return userPassword
}

// Revisions 5–6 (AES-256): Algorithm 2.A — /U and /O each carry a hash plus
// validation and key salts, and the file key is unwrapped from /UE or /OE.
function aes256FileKey(password: string, p: EncryptParams): Uint8Array | null {
  const pw = new TextEncoder().encode(password.normalize('NFKC')).subarray(0, 127)
  const user = p.user.subarray(0, 48)
  const zeroIv = new Uint8Array(16)
  if (bytesEqual(hash2B(pw, p.user.subarray(32, 40), new Uint8Array(0), p), p.user.subarray(0, 32))) {
    const key = hash2B(pw, p.user.subarray(40, 48), new Uint8Array(0), p)
    return aesCbcRaw('aes-256-cbc', 'decrypt', key, zeroIv, p.userEncrypted.subarray(0, 32))
  }
  if (bytesEqual(hash2B(pw, p.owner.subarray(32, 40), user, p), p.owner.subarray(0, 32))) {
    const key = hash2B(pw, p.owner.subarray(40, 48), user, p)
    return aesCbcRaw('aes-256-cbc', 'decrypt', key, zeroIv, p.ownerEncrypted.subarray(0, 32))
  }
  return null
}

// Algorithm 2.B. Revision 5 (Adobe's pre-ISO extension) stops after the first SHA-256.
function hash2B(password: Uint8Array, salt: Uint8Array, userKey: Uint8Array, p: EncryptParams): Uint8Array {
  let k = digest('sha256', password, salt, userKey)
  if (p.revision === 5) return k
  const hashes = ['sha256', 'sha384', 'sha512']
  for (let round = 0; ; round++) {
    const block = concatBytes(password, k, userKey)
    const k1 = new Uint8Array(block.length * 64)
    for (let i = 0; i < 64; i++) k1.set(block, i * block.length)
    const e = aesCbcRaw('aes-128-cbc', 'encrypt', k.subarray(0, 16), k.subarray(16, 32), k1)
    // The first 16 bytes of E as a big-endian integer mod 3 equals their byte sum mod 3, since 256 ≡ 1 (mod 3).
    let sum = 0
    for (let i = 0; i < 16; i++) sum += e[i]
    k = digest(hashes[sum % 3], e)
    if (round >= 63 && e[e.length - 1] <= round - 31) break
  }
  return k.subarray(0, 32)
}

// Algorithm 1: RC4 and AES-128 mix the object number into a per-object key.
function objectKey(handler: SecurityHandler, ref: PdfRef, cipher: CipherKind): Uint8Array {
  if (cipher === 'aesv3' || cipher === 'none') return handler.fileKey
  const { objectNumber: n, generationNumber: g } = ref
  const salt = cipher === 'aesv2' ? Uint8Array.of(0x73, 0x41, 0x6c, 0x54) : new Uint8Array(0)
  const key = digest(
    'md5',
    handler.fileKey,
    Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, g & 0xff, (g >> 8) & 0xff),
    salt,
  )
  return key.subarray(0, Math.min(handler.fileKey.length + 5, 16))
}

// ── Ciphers ─────────────────────────────────────────────────────────────────

function decryptBytes(cipher: CipherKind, key: Uint8Array, data: Uint8Array): Uint8Array {
  switch (cipher) {
    case 'none':
      return data
    case 'rc4':
      return rc4(key, data)
    case 'aesv2':
      return aesDecryptWithIv('aes-128-cbc', key, data)
    case 'aesv3':
      return aesDecryptWithIv('aes-256-cbc', key, data)
  }
}

// AES payloads are a 16-byte IV followed by PKCS#5-padded ciphertext. Padding
// is stripped leniently: some writers leave trailing bytes that aren't a whole
// block or pad incorrectly, and viewers tolerate both.
function aesDecryptWithIv(algorithm: string, key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length < 32) return new Uint8Array(0)
  const bodyLength = Math.floor((data.length - 16) / 16) * 16
  const plain = aesCbcRaw(algorithm, 'decrypt', key, data.subarray(0, 16), data.subarray(16, 16 + bodyLength))
  const pad = plain[plain.length - 1]
  return pad >= 1 && pad <= 16 ? plain.subarray(0, plain.length - pad) : plain
}

function aesCbcRaw(
  algorithm: string,
  mode: 'encrypt' | 'decrypt',
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array,
): Uint8Array {
  const cipher =
    mode === 'encrypt'
      ? nodeCrypto.createCipheriv(algorithm, key, iv)
      : nodeCrypto.createDecipheriv(algorithm, key, iv)
  cipher.setAutoPadding(false)
  return concatBytes(cipher.update(data), cipher.final())
}

// Implemented here because OpenSSL 3 and BoringSSL builds don't reliably ship RC4.
function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256)
  for (let i = 0; i < 256; i++) s[i] = i
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff
    ;[s[i], s[j]] = [s[j], s[i]]
  }
  const out = new Uint8Array(data.length)
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 0xff
    j = (j + s[i]) & 0xff
    ;[s[i], s[j]] = [s[j], s[i]]
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff]
  }
  return out
}

// ── Byte helpers ────────────────────────────────────────────────────────────

function digest(algorithm: string, ...parts: Uint8Array[]): Uint8Array {
  const hash = nodeCrypto.createHash(algorithm)
  for (const part of parts) hash.update(part)
  return new Uint8Array(hash.digest())
}

function padPassword(password: Uint8Array): Uint8Array {
  const out = new Uint8Array(32)
  const n = Math.min(32, password.length)
  out.set(password.subarray(0, n))
  out.set(PASSWORD_PADDING.subarray(0, 32 - n), n)
  return out
}

function latin1Bytes(text: string): Uint8Array {
  return Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 0xff)
}

function xorEach(key: Uint8Array, value: number): Uint8Array {
  return key.map((b) => b ^ value)
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length || a.length === 0) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}
