import { describe, expect, test } from "bun:test";
import {
  MIN_IMAGE_DOCUMENT_BYTES,
  contentIdReferences,
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
