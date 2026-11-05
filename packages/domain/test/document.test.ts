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

  // [MIME type as sent, file name, content label, media type the model gets, content]
  test.each([
    ["application/pdf", "r.pdf", "a PDF header", "application/pdf", PDF],
    ['Application/PDF; name="r.pdf"', "r.pdf", "a PDF header", "application/pdf", PDF],
    ["application/octet-stream", "Scan.PDF", "a PDF header", "application/pdf", PDF],
    // %PDF may start after leading junk, up to where Mastra still finds it
    ["application/pdf", "r.pdf", "%PDF at byte 500", "application/pdf", at(500, "%PDF-1.4")],
    ["application/pdf", "r.pdf", "%PDF at byte 1022", "application/pdf", at(1022, "%PDF-1.4")],
    ["application/pdf", "r.pdf", "%PDF at byte 1023", undefined, at(1023, "%PDF-1.4")],
    ["application/pdf", "r.pdf", "%PDF at byte 1100", undefined, at(1100, "%PDF-1.4")],
    ["application/pdf", "r.pdf", "garbage", undefined, GARBAGE],
    ["application/pdf", "r.pdf", "no content", undefined, new Uint8Array(0)],
    ["application/octet-stream", "scan.bin", "a PDF header", undefined, PDF],
    // Images go by their content's signature
    ["image/jpeg", "scan.jpg", "a JPEG signature", "image/jpeg", JPEG],
    ["image/jpg", "scan.jpg", "a JPEG signature", "image/jpeg", JPEG],
    ["image/pjpeg", "scan.jpg", "a JPEG signature", "image/jpeg", JPEG],
    ["IMAGE/PNG", undefined, "a PNG signature", "image/png", PNG],
    ["image/gif", "scan.gif", "GIF89a", "image/gif", GIF],
    ["image/gif", "scan.gif", "GIF87a", "image/gif", ascii("GIF87a....")],
    ["image/webp", "scan.webp", "RIFF…WEBP", "image/webp", WEBP],
    // Mislabelled but real: sent as what the content is
    ["image/jpeg", "scan.jpg", "a PNG signature", "image/png", PNG],
    ["image/heic", "IMG_0001.HEIC", "a JPEG signature", "image/jpeg", JPEG],
    // Content that isn't such an image: never sent, filed by the received date
    ["image/jpeg", "scan.jpg", "garbage", undefined, GARBAGE],
    ["image/png", "scan.png", "a PDF header", undefined, PDF],
    [
      "image/webp",
      "scan.webp",
      "RIFF…WAVE",
      undefined,
      ascii("RIFF\u0010\u0000\u0000\u0000WAVEfmt "),
    ],
    ["image/heic", "IMG_0001.HEIC", "a HEIC ftyp box", undefined, HEIC],
    ["image/tiff", "scan.tif", "a TIFF header", undefined, TIFF],
    ["image/bmp", "scan.bmp", "a BMP header", undefined, ascii("BM6\u0000\u0000\u0000")],
    // Not a Document type at all, whatever the content
    ["text/plain", "notes.txt", "a JPEG signature", undefined, JPEG],
  ] as const)("%s named %p with %s → %p", (mimeType, fileName, _label, expected, content) => {
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
