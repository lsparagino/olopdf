# Regenerates the encrypted PDFs used by src/utils/pdfEncryption.spec.ts.
# Two independent producers (MuPDF, pypdf) so the decryptor is checked against
# implementations other than itself. Requires: pip install pymupdf pypdf
#
#   python scripts/make-encryption-fixtures.py

from pathlib import Path

import fitz
from pypdf import PdfReader, PdfWriter

OUT = Path(__file__).resolve().parent.parent / 'src' / 'utils' / 'fixtures' / 'encryption'
OUT.mkdir(parents=True, exist_ok=True)

src = fitz.open()
for i in range(2):
    page = src.new_page()
    page.insert_text((72, 100), f'Hello encrypted page {i + 1}', fontsize=24)
    page.draw_rect(fitz.Rect(72, 150, 300, 300), color=(1, 0, 0), fill=(0, 0, 1))
src.set_toc([[1, 'Chapter One', 1], [1, 'Chapter Two', 2]])
src.set_metadata({'title': 'Secret Title'})
plain = src.tobytes()
(OUT / 'plain.pdf').write_bytes(plain)

# Owner-locked with an empty user password is the common real-world case: the
# file opens without a prompt but carries an /Encrypt dictionary.
PRINT_ONLY = int(fitz.PDF_PERM_PRINT)
MUPDF = [
    ('mupdf-rc4-40.pdf', fitz.PDF_ENCRYPT_RC4_40, '', False),
    ('mupdf-rc4-128.pdf', fitz.PDF_ENCRYPT_RC4_128, '', False),
    ('mupdf-aes-128-objstm.pdf', fitz.PDF_ENCRYPT_AES_128, '', True),
    ('mupdf-aes-256-objstm.pdf', fitz.PDF_ENCRYPT_AES_256, '', True),
    ('mupdf-rc4-128-user-password.pdf', fitz.PDF_ENCRYPT_RC4_128, 'secret', False),
    ('mupdf-aes-256-user-password.pdf', fitz.PDF_ENCRYPT_AES_256, 'secret', False),
]
for name, method, user_pw, objstm in MUPDF:
    doc = fitz.open('pdf', plain)
    doc.save(
        str(OUT / name),
        encryption=method,
        owner_pw='owner',
        user_pw=user_pw,
        permissions=PRINT_ONLY,
        use_objstms=int(objstm),
    )

for name, algorithm in [('pypdf-aes-128.pdf', 'AES-128'), ('pypdf-aes-256-r5.pdf', 'AES-256-R5')]:
    writer = PdfWriter(clone_from=PdfReader(OUT / 'plain.pdf'))
    writer.encrypt(user_password='', owner_password='owner', algorithm=algorithm)
    with open(OUT / name, 'wb') as fh:
        writer.write(fh)

for f in sorted(OUT.glob('*.pdf')):
    doc = fitz.open(f)
    enc = (doc.metadata or {}).get('encryption') if not doc.needs_pass else 'needs password'
    print(f'{f.name:36} {f.stat().st_size:6} B  {enc}')
