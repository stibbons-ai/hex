import { describe, expect, test } from "bun:test";
import {
  MIN_IMAGE_DOCUMENT_BYTES,
  contentIdReferences,
  documentMediaType,
  isDocument,
  normalizeContentId,
} from "../src";

const big = MIN_IMAGE_DOCUMENT_BYTES;
const tiny = MIN_IMAGE_DOCUMENT_BYTES - 1;

describe("isDocument", () => {
  // [MIME type, Content-Disposition, referenced by cid:, size, file name, Document?]
  test.each([
    // PDFs: any disposition, any size, unless the body shows them by cid:
    ["application/pdf", "attachment", false, 50_000, "r.pdf", true],
    ["application/pdf", "inline", false, 50_000, "r.pdf", true],
    ["application/pdf", undefined, false, 50_000, "r.pdf", true],
    ["application/pdf", "attachment", false, 1, "r.pdf", true],
    ["application/pdf", "attachment", true, 50_000, "r.pdf", false],
    ['Application/PDF; name="r.pdf"', "attachment", false, 50_000, "r.pdf", true],
    ["application/octet-stream", "attachment", false, 50_000, "Scan.PDF", true],
    ["application/octet-stream", "attachment", false, 50_000, "scan.bin", false],
    ["application/octet-stream", "attachment", false, 50_000, undefined, false],
    // Images: real attachments at or above the threshold
    ["image/jpeg", "attachment", false, big, "scan.jpg", true],
    ["image/jpeg", "attachment", false, tiny, "scan.jpg", false],
    ["IMAGE/PNG", "attachment", false, big, "scan.png", true],
    ["image/heic", undefined, false, big, "IMG_0001.HEIC", true],
    // Apple Mail sends scans inline without a cid: reference
    ["image/jpeg", "inline", false, big, "Scan.jpeg", true],
    ["image/jpeg", "inline", false, tiny, "logo.jpeg", false],
    // Referenced by cid: decoration, whatever the disposition or size
    ["image/png", "inline", true, big, "logo.png", false],
    ["image/png", "attachment", true, big, "logo.png", false],
    ["image/png", undefined, true, big, undefined, false],
    // SVG and everything else: never a Document
    ["image/svg+xml", "attachment", false, big, "logo.svg", false],
    ["text/calendar", "attachment", false, big, "invite.ics", false],
    ["text/plain", "attachment", false, big, "notes.txt", false],
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "attachment",
      false,
      big,
      "letter.docx",
      false,
    ],
    ["message/rfc822", "attachment", false, big, "forwarded.eml", false],
  ] as const)(
    "%s, %s, cid %p, %d bytes, %s → %p",
    (mimeType, disposition, referencedByCid, size, fileName, expected) => {
      expect(isDocument({ mimeType, disposition, referencedByCid, size, fileName })).toBe(expected);
    },
  );
});

describe("documentMediaType", () => {
  const bytes = (...values: number[]) => Uint8Array.from(values);
  const ascii = (text: string) => new TextEncoder().encode(text);
  /** `text` after `offset` filler bytes. */
  const at = (offset: number, text: string) => {
    const content = new Uint8Array(offset + text.length).fill(0x20);
    content.set(ascii(text), offset);
    return content;
  };
  const PDF = ascii("%PDF-1.7\n");
  const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
  const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const GIF = ascii("GIF89a....");
  const WEBP = ascii("RIFF\u0010\u0000\u0000\u0000WEBPVP8 ");
  const HEIC = ascii("\u0000\u0000\u0000\u0018ftypheic\u0000\u0000\u0000\u0000mif1heic");
  const TIFF = bytes(0x49, 0x49, 0x2a, 0x00);
  const GARBAGE = ascii("jjjjjjjjjjjj");

  // [MIME type as sent, file name, content, media type the model gets]
  test.each([
    ["application/pdf", "r.pdf", PDF, "application/pdf"],
    ['Application/PDF; name="r.pdf"', "r.pdf", PDF, "application/pdf"],
    ["application/octet-stream", "Scan.PDF", PDF, "application/pdf"],
    // %PDF may start after leading junk, up to where Mastra still finds it
    ["application/pdf", "r.pdf", at(500, "%PDF-1.4"), "application/pdf"],
    ["application/pdf", "r.pdf", at(1022, "%PDF-1.4"), "application/pdf"],
    ["application/pdf", "r.pdf", at(1023, "%PDF-1.4"), undefined],
    ["application/pdf", "r.pdf", at(1100, "%PDF-1.4"), undefined],
    ["application/pdf", "r.pdf", GARBAGE, undefined],
    ["application/pdf", "r.pdf", new Uint8Array(0), undefined],
    ["application/octet-stream", "scan.bin", PDF, undefined],
    // Images go by their content's signature
    ["image/jpeg", "scan.jpg", JPEG, "image/jpeg"],
    ["image/jpg", "scan.jpg", JPEG, "image/jpeg"],
    ["image/pjpeg", "scan.jpg", JPEG, "image/jpeg"],
    ["IMAGE/PNG", undefined, PNG, "image/png"],
    ["image/gif", "scan.gif", GIF, "image/gif"],
    ["image/gif", "scan.gif", ascii("GIF87a...."), "image/gif"],
    ["image/webp", "scan.webp", WEBP, "image/webp"],
    // Mislabelled but real: sent as what the content is
    ["image/jpeg", "scan.jpg", PNG, "image/png"],
    ["image/heic", "IMG_0001.HEIC", JPEG, "image/jpeg"],
    // Content that isn't such an image: never sent, filed by the received date
    ["image/jpeg", "scan.jpg", GARBAGE, undefined],
    ["image/png", "scan.png", PDF, undefined],
    ["image/webp", "scan.webp", ascii("RIFF\u0010\u0000\u0000\u0000WAVEfmt "), undefined],
    ["image/heic", "IMG_0001.HEIC", HEIC, undefined],
    ["image/tiff", "scan.tif", TIFF, undefined],
    ["image/bmp", "scan.bmp", ascii("BM6\u0000\u0000\u0000"), undefined],
    // Not a Document type at all, whatever the content
    ["text/plain", "notes.txt", JPEG, undefined],
  ] as const)("%s named %s → %p", (mimeType, fileName, content, expected) => {
    expect(documentMediaType({ mimeType, fileName, content })).toBe(expected);
  });
});

describe("contentIdReferences", () => {
  test("finds every cid: URL in the HTML, decoded and normalised", () => {
    const html = `<img src="cid:Logo@Example.com"><img src=cid:part2%40mail>
      <div style="background:url(cid:bg.png)"></div><a href="https://example.com/cid:no">x</a>`;
    expect(contentIdReferences(html)).toEqual(
      new Set(["logo@example.com", "part2@mail", "bg.png"]),
    );
  });

  test("matches a Content-ID header value once normalised", () => {
    const references = contentIdReferences('<img src="CID:logo@x">');
    expect(references.has(normalizeContentId(" <LOGO@x> "))).toBe(true);
    expect(references.has(normalizeContentId("<other@x>"))).toBe(false);
  });

  test("keeps a reference with broken percent-encoding as written", () => {
    expect(contentIdReferences('<img src="cid:a%zz">')).toEqual(new Set(["a%zz"]));
  });
});
