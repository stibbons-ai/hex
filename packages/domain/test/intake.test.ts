import { describe, expect, test } from "bun:test";
import {
  MIN_IMAGE_DOCUMENT_BYTES,
  detectDocuments,
  normalizeMessageId,
  withoutMessageIdComments,
} from "../src";

describe("normalizeMessageId", () => {
  test.each([
    ["<abc@example.com>", "abc@example.com"],
    ["  <abc@example.com>  ", "abc@example.com"],
    ["abc@example.com", "abc@example.com"],
    ["< abc@example.com >", "abc@example.com"],
    ["<>", ""],
    ["   ", ""],
    ["<<>>", ""],
    ["<<a@b>>", "a@b"],
    ["< <x> >", "x"],
    ["<<<a@b>>>", "a@b"],
    ["<a@b", "<a@b"],
    ["a@b>", "a@b>"],
    ["<", "<"],
  ])("%j → %j, a key that normalises to itself", (raw, expected) => {
    expect(normalizeMessageId(raw)).toBe(expected);
    expect(normalizeMessageId(normalizeMessageId(raw))).toBe(expected);
  });

  test("100,000 layers of brackets, as any sender can write, take linear time", () => {
    const layers = 100_000;
    const raw = `${"< ".repeat(layers)}deep@x${" >".repeat(layers)}`;
    const started = performance.now();
    expect(normalizeMessageId(raw)).toBe("deep@x");
    // Quadratic peeling took about 0.7 s for half as many layers.
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("withoutMessageIdComments", () => {
  test.each([
    ["<a@b>", "a@b"],
    ["<a@b> (a comment)", "a@b"],
    ["(pre) <a@b>", "a@b"],
    ["(pre)<a@b>(post)", "a@b"],
    ["<a@b>\r\n\t(folded\r\n comment)", "a@b"],
    ["<a@b> (x (nested (deeper)) y)", "a@b"],
    ["<a@b> (escaped \\) paren)", "a@b"],
    ["<a@b> (escaped \\( paren)", "a@b"],
    ["<a@b> (backslash \\\\) (second)", "a@b"],
    ["<a(b)c@d>", "a(b)c@d"],
    ["<<a(b)c@d>> (comment)", "a(b)c@d"],
    // Unclosed: the rest of the value is comment.
    ["<a@b> (open", "a@b"],
    ["<a@b> (open (nested) \\", "a@b"],
    ["(open <a@b>", ""],
    // A stray `)` outside any comment and the brackets is plain text.
    ["<a@b> )", "<a@b> )"],
    ["a@b", "a@b"],
    ["", ""],
  ])("%j → %j as a key; stripping again changes nothing", (raw, expected) => {
    const stripped = withoutMessageIdComments(raw);
    expect(normalizeMessageId(stripped)).toBe(expected);
    expect(withoutMessageIdComments(stripped)).toBe(stripped);
  });

  test.each([
    ["100,000 nested unclosed comments", `<deep@x> ${"(".repeat(100_000)}`],
    ["100,000 quoted pairs in a comment", `(${"\\(".repeat(100_000)}) <deep@x>`],
    ["100,000 comments in a row", `${"()".repeat(100_000)}<deep@x>`],
  ])("%s, as any sender can write, take linear time", (_case, raw) => {
    const started = performance.now();
    expect(normalizeMessageId(withoutMessageIdComments(raw))).toBe("deep@x");
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("detectDocuments", () => {
  const image = { mimeType: "image/png", size: MIN_IMAGE_DOCUMENT_BYTES };

  test("a part counts as referenced whatever the brackets and case of its Content-ID", () => {
    const attachments = [
      { ...image, fileName: "logo.png", contentId: "<Logo@Shop>" },
      { ...image, fileName: "scan.png", contentId: "<scan@shop>" },
      { ...image, fileName: "photo.png" },
    ];
    expect(detectDocuments(attachments, ["logo@shop"])).toEqual([
      { index: 1, fileName: "scan.png" },
      { index: 2, fileName: "photo.png" },
    ]);
    // References as an API caller may send them: bracketed, any case.
    expect(detectDocuments(attachments, ["<LOGO@shop>"])).toEqual([
      { index: 1, fileName: "scan.png" },
      { index: 2, fileName: "photo.png" },
    ]);
  });

  test("names come from the sender, made safe; a nameless one by its position", () => {
    const attachments = [
      { mimeType: "text/plain", size: 10, fileName: "notes.txt" },
      { mimeType: "application/pdf", size: 10, fileName: "../Rechnung.pdf" },
      { mimeType: "application/pdf", size: 10 },
      { ...image },
    ];
    expect(detectDocuments(attachments, [])).toEqual([
      { index: 1, fileName: "Rechnung.pdf" },
      { index: 2, fileName: "document-3.pdf" },
      { index: 3, fileName: "document-4.png" },
    ]);
  });
});
