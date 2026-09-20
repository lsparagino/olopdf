// pdf-lib only gives a dictionary its page-tree behaviour (PDFCatalog,
// PDFPageTree, PDFPageLeaf) when its /Type says so, walks /Kids with no cycle
// check, and follows every /Parent blindly. A file that breaks any of that
// either crashes getPages()/copyPages() or silently loses pages, while pdf.js
// still shows those pages — so the user sees a file they then can't merge.

import type {
  PDFArray as PdfArray,
  PDFCatalog as PdfCatalog,
  PDFContext,
  PDFDict as PdfDict,
  PDFDocument as PdfDocument,
  PDFName as PdfName,
  PDFObject,
  PDFPageLeaf as PdfPageLeaf,
  PDFPageTree as PdfPageTree,
  PDFRef as PdfRef,
} from 'pdf-lib'

const pdfLib = (window as unknown as { require: (m: string) => typeof import('pdf-lib') }).require(
  'pdf-lib',
)
const { PDFArray, PDFCatalog, PDFDict, PDFName, PDFNull, PDFNumber, PDFPageLeaf, PDFPageTree, PDFRef } =
  pdfLib

// ISO 32000-1 §7.7.3.4: the only entries a page may take from its ancestors.
const INHERITABLE_KEYS = ['Resources', 'MediaBox', 'CropBox', 'Rotate']
// US Letter is what pdf.js and MuPDF assume when no /MediaBox is found at all.
const DEFAULT_MEDIA_BOX = [0, 0, 612, 792]

interface PageEntry {
  dict: PdfDict
  // Null when the page dict was written inline in a /Kids array.
  ref: PdfRef | null
  // The tree nodes the walk passed through to reach this page, nearest first.
  ancestors: PdfDict[]
}

interface WalkFrame {
  kids: PdfArray
  next: number
  ancestors: PdfDict[]
}

// Returns true when the tree was rebuilt. Call it straight after load: pdf-lib
// caches the page list on first access and would keep serving the broken one.
export function repairPageTree(doc: PdfDocument): boolean {
  if (isPageTreeUsable(doc)) return false
  const context = doc.context
  const rootEntry = context.trailerInfo.Root
  const root = context.lookup(rootEntry)
  if (!(root instanceof PDFDict)) return false

  const pages = collectPages(context, root)
  // Nothing to recover. pdf-lib's own error is kept, since the pages may exist
  // somewhere it couldn't read (e.g. an object stream in an unsupported filter).
  if (pages.length === 0) return false
  // Read before any /Parent is rewritten below, since the old chains hold the values.
  const inherited = pages.map((page) => inheritedAttributes(context, page))

  // A flat tree is enough: page order is all that matters, and each page now
  // carries its own copy of everything it used to inherit.
  const tree = PDFPageTree.withContext(context)
  const treeRef = context.register(tree)
  pages.forEach((page, i) => {
    const leaf =
      page.dict instanceof PDFPageLeaf
        ? page.dict
        : PDFPageLeaf.fromMapWithContext(new Map(page.dict.entries()), context)
    for (const [key, value] of inherited[i]) leaf.set(key, value)
    if (!leaf.has(PDFName.of('MediaBox'))) {
      leaf.set(PDFName.of('MediaBox'), context.obj(DEFAULT_MEDIA_BOX))
    }
    leaf.set(PDFName.of('Type'), PDFName.of('Page'))
    leaf.set(PDFName.of('Parent'), treeRef)
    // Reusing the page's own ref keeps outline, link and structure-tree destinations pointing at it.
    if (page.ref) context.assign(page.ref, leaf)
    tree.Kids().push(page.ref ?? context.register(leaf))
  })
  tree.set(PDFName.of('Count'), PDFNumber.of(pages.length))

  const catalog =
    root instanceof PDFCatalog
      ? root
      : PDFCatalog.fromMapWithContext(new Map(root.entries()), context)
  catalog.set(PDFName.of('Type'), PDFName.of('Catalog'))
  catalog.set(PDFName.of('Pages'), treeRef)
  if (rootEntry instanceof PDFRef) context.assign(rootEntry, catalog)
  else context.trailerInfo.Root = context.register(catalog)
  // pdf-lib reads the catalog only once, in the PDFDocument constructor.
  ;(doc as unknown as { catalog: PdfCatalog }).catalog = catalog
  return true
}

// Mirrors the lookups pdf-lib's getPages() and copyPages() make, so a tree
// pdf-lib already reads in full is never modified.
function isPageTreeUsable(doc: PdfDocument): boolean {
  const catalog: unknown = doc.catalog
  if (!(catalog instanceof PDFCatalog)) return false
  const pages = doc.context.lookup(catalog.get(PDFName.of('Pages')))
  return pages instanceof PDFPageTree && isSubtreeUsable(doc.context, pages, new Set(), new Set())
}

function isSubtreeUsable(
  context: PDFContext,
  node: PdfPageTree,
  path: Set<PdfDict>,
  checked: Set<PdfDict>,
): boolean {
  const kids = context.lookup(node.get(PDFName.of('Kids')))
  if (!(kids instanceof PDFArray)) return false
  path.add(node)
  for (let i = 0; i < kids.size(); i++) {
    const kid = context.lookup(kids.get(i))
    if (kid instanceof PDFPageTree) {
      if (path.has(kid)) return false
      if (!checked.has(kid) && !isSubtreeUsable(context, kid, path, checked)) return false
    } else if (kid instanceof PDFPageLeaf) {
      if (!isParentChainUsable(context, kid)) return false
    } else if (kid instanceof PDFDict) {
      // A page or node without the right /Type: pdf-lib skips it and the pages are lost.
      return false
    }
  }
  path.delete(node)
  checked.add(node)
  return true
}

// copyPages() walks every page's /Parent chain to collect inherited entries,
// with no cycle check, calling ascend() on each step — which only the
// page-tree classes have. A page's lookup ignores a null /Parent; a node's doesn't.
function isParentChainUsable(context: PDFContext, leaf: PdfPageLeaf): boolean {
  const seen = new Set<PDFObject>([leaf])
  let parent = context.lookup(leaf.get(PDFName.of('Parent')))
  if (parent === PDFNull) return true
  while (parent !== undefined) {
    if (!(parent instanceof PDFPageTree || parent instanceof PDFPageLeaf)) return false
    if (seen.has(parent)) return false
    seen.add(parent)
    const next = context.lookup(parent.get(PDFName.of('Parent')))
    if (parent instanceof PDFPageLeaf && next === PDFNull) return true
    parent = next
  }
  return true
}

// Walks /Kids the way pdf.js does, so the pages and their order match what the
// viewer showed: a kid is a page when it says /Type /Page or has no /Kids,
// whatever its /Type otherwise claims. Anything already visited is skipped,
// which is what breaks cycles.
function collectPages(context: PDFContext, catalog: PdfDict): PageEntry[] {
  const pagesEntry = catalog.get(PDFName.of('Pages'))
  const root = context.lookup(pagesEntry)
  if (!(root instanceof PDFDict)) return []
  // Some writers point the catalog straight at the only page instead of at a node above it.
  if (context.lookup(root.get(PDFName.of('Type'))) === PDFName.of('Page')) {
    return [{ dict: root, ref: pagesEntry instanceof PDFRef ? pagesEntry : null, ancestors: [] }]
  }

  const pages: PageEntry[] = []
  // The catalog is seeded too: as a kid it would otherwise pass for a page, having no /Kids.
  const visited = new Set<PDFObject>([catalog, root])
  const stack: WalkFrame[] = []
  pushNode(context, stack, root, [])
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    if (frame.next >= frame.kids.size()) {
      stack.pop()
      continue
    }
    const entry = frame.kids.get(frame.next++)
    const kid = context.lookup(entry)
    if (!(kid instanceof PDFDict) || visited.has(kid)) continue
    visited.add(kid)
    if (isTreeNode(context, kid)) pushNode(context, stack, kid, frame.ancestors)
    else pages.push({ dict: kid, ref: entry instanceof PDFRef ? entry : null, ancestors: frame.ancestors })
  }
  return pages
}

function pushNode(context: PDFContext, stack: WalkFrame[], node: PdfDict, ancestors: PdfDict[]): void {
  const kids = context.lookup(node.get(PDFName.of('Kids')))
  if (kids instanceof PDFArray) stack.push({ kids, next: 0, ancestors: [node, ...ancestors] })
}

function isTreeNode(context: PDFContext, dict: PdfDict): boolean {
  const type = context.lookup(dict.get(PDFName.of('Type')))
  if (type === PDFName.of('Page')) return false
  return type === PDFName.of('Pages') || dict.has(PDFName.of('Kids'))
}

// pdf.js and MuPDF resolve inherited entries through /Parent, so that chain
// wins; the path the walk took fills in only where /Parent is missing or broken.
function inheritedAttributes(context: PDFContext, page: PageEntry): Map<PdfName, PDFObject> {
  const values = new Map<PdfName, PDFObject>()
  for (const name of INHERITABLE_KEYS) {
    const key = PDFName.of(name)
    if (page.dict.has(key)) continue
    const value =
      findOnParentChain(context, page.dict, key) ??
      page.ancestors.map((node) => node.get(key)).find((v) => v !== undefined)
    if (value !== undefined) values.set(key, value)
  }
  return values
}

function findOnParentChain(context: PDFContext, dict: PdfDict, key: PdfName): PDFObject | undefined {
  const seen = new Set<PDFObject>([dict])
  let node = context.lookup(dict.get(PDFName.of('Parent')))
  while (node instanceof PDFDict && !seen.has(node)) {
    const value = node.get(key)
    if (value !== undefined) return value
    seen.add(node)
    node = context.lookup(node.get(PDFName.of('Parent')))
  }
  return undefined
}
