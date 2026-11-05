import { describe, expect, test } from "bun:test";
import { MAX_FILE_NAME_BYTES, freeFileName, isSafeFileName, safeFileName } from "../src";

const utf8 = (text: string) => new TextEncoder().encode(text).length;

describe("freeFileName", () => {
  test.each([
    ["free name kept", "name.pdf", [], "name.pdf"],
    ["first collision", "name.pdf", ["name.pdf"], "name (1).pdf"],
    ["second collision", "name.pdf", ["name.pdf", "name (1).pdf"], "name (2).pdf"],
    ["a gap is reused", "name.pdf", ["name.pdf", "name (2).pdf"], "name (1).pdf"],
    ["no extension", "name", ["name"], "name (1)"],
    ["multi-dot name", "a.b.pdf", ["a.b.pdf"], "a.b (1).pdf"],
    ["dotfile", ".env", [".env"], ".env (1)"],
    ["trailing dot", "name.", ["name."], "name. (1)"],
    ["exact compare", "Name.pdf", ["name.pdf"], "Name.pdf"],
    ["counter after an existing counter", "x (1).pdf", ["x (1).pdf"], "x (1) (1).pdf"],
  ])("%s", (_case, desired, taken, expected) => {
    expect(freeFileName(desired, new Set(taken))).toBe(expected);
  });
});

describe("safeFileName", () => {
  test.each([
    [
      "kept as is",
      "Rechnung 2026-10 (Kopie).pdf",
      "application/pdf",
      "Rechnung 2026-10 (Kopie).pdf",
    ],
    ["path traversal", "../../x.pdf", "application/pdf", "x.pdf"],
    ["slash path", "a/b.pdf", "application/pdf", "b.pdf"],
    ["Windows path", "C:\\Users\\d\\scan.pdf", "application/pdf", "scan.pdf"],
    ["dot", ".", "application/pdf", "document-3.pdf"],
    ["dot dot", "..", "application/pdf", "document-3.pdf"],
    ["trailing slash", "dir/", "application/pdf", "document-3.pdf"],
    ["empty", "", "image/png", "document-3.png"],
    ["missing", undefined, "image/jpeg; name=x", "document-3.jpg"],
    ["missing, octet-stream PDF", undefined, "application/octet-stream", "document-3.pdf"],
    [".partial suffix", "x.pdf.partial", "application/pdf", "x.pdf"],
    ["only .partial", ".partial", "application/pdf", "partial"],
    ["repeated .partial", "x.partial.partial", "application/pdf", "x"],
    ["hidden", ".hidden.pdf", "application/pdf", "hidden.pdf"],
    ["NUL and control characters", "a\u0000b\u0007\nc.pdf", "application/pdf", "abc.pdf"],
    ["bidi override", "invoice\u202Efdp.exe", "application/pdf", "invoicefdp.exe"],
    ["surrounding whitespace", "  scan.pdf \t", "application/pdf", "scan.pdf"],
    ["NFD becomes NFC", "Re\u0301sume\u0301.pdf", "application/pdf", "Résumé.pdf"],
  ])("%s", (_case, original, mimeType, expected) => {
    expect(safeFileName(original, mimeType, 3)).toBe(expected);
  });

  test("a long name is cut to the byte limit with its extension kept", () => {
    const name = safeFileName(`${"ä".repeat(300)}.pdf`, "application/pdf", 1);
    expect(name.endsWith("ä.pdf")).toBe(true);
    expect(utf8(name)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
    expect(utf8(name)).toBeGreaterThan(MAX_FILE_NAME_BYTES - 2);
  });

  test("a long name never cuts a code point in half", () => {
    const name = safeFileName(`${"😀".repeat(100)}.pdf`, "application/pdf", 1);
    expect(name).toBe(`${"😀".repeat(49)}.pdf`);
  });

  test("an overlong extension is not kept whole", () => {
    const name = safeFileName(`x.${"y".repeat(300)}`, "application/pdf", 1);
    expect(utf8(name)).toBe(MAX_FILE_NAME_BYTES);
    expect(name.startsWith("x.yyy")).toBe(true);
  });

  test("cutting never leaves a .partial ending", () => {
    const original = `${"a".repeat(MAX_FILE_NAME_BYTES - 8)}.partial${"b".repeat(100)}`;
    const name = safeFileName(original, "application/pdf", 1);
    expect(name).toBe("a".repeat(MAX_FILE_NAME_BYTES - 8));
  });
});

describe("isSafeFileName", () => {
  test.each([
    ["Rechnung (1).pdf", true],
    ["document-3.pdf", true],
    ["a".repeat(MAX_FILE_NAME_BYTES), true],
    ["a".repeat(MAX_FILE_NAME_BYTES + 1), false],
    ["", false],
    [".", false],
    ["..", false],
    [".hidden.pdf", false],
    ["a/b.pdf", false],
    ["a\\b.pdf", false],
    ["x\0.pdf", false],
    ["x\u202E.pdf", false],
    [" x.pdf", false],
    ["x.pdf ", false],
    ["x.pdf.partial", false],
    ["x.pdf.PARTIAL", false],
  ])("%j → %p", (name, expected) => {
    expect(isSafeFileName(name)).toBe(expected);
  });

  test.each([
    "../../x.pdf",
    "..",
    "",
    "\u0000\u0007",
    "x.pdf.partial",
    " .hidden ",
    `${"ä".repeat(300)}.pdf`,
    `x.${"y".repeat(300)}`,
    `${"a".repeat(MAX_FILE_NAME_BYTES - 8)}.partial${"b".repeat(100)}`,
  ])("every safeFileName result is safe: %j", (original) => {
    expect(isSafeFileName(safeFileName(original, "application/pdf", 1))).toBe(true);
  });
});
