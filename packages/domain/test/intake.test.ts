import { describe, expect, test } from "bun:test";
import { MIN_IMAGE_DOCUMENT_BYTES, detectDocuments, normalizeMessageId } from "../src";

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
