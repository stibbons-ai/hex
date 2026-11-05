import { describe, expect, test } from "bun:test";
import { headerDate, headerText, mailbox } from "../src/synthetic/mime.ts";

const decodeWords = (header: string) =>
  [...header.matchAll(/=\?UTF-8\?B\?([^?]*)\?=/g)]
    .map(([, base64]) => Buffer.from(base64!, "base64").toString("utf8"))
    .join("");

describe("MIME header writers", () => {
  test("a long non-ASCII header folds into encoded words of at most 75 characters that decode to the text", () => {
    const text = "Rückfrage zur Gutschrift über 1.234,56 € für Bürobedarf, Lieferung März";
    const lines = headerText(text).split("\n ");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(75);
    expect(decodeWords(headerText(text))).toBe(text);
  });

  test("an encoded name is folded before the address, keeping every line within 76 characters", () => {
    const header = `From: ${mailbox({ name: "Beispiel Bürobedarf GmbH", address: "rechnung@buerobedarf.example" })}`;
    const lines = header.split("\n");
    expect(lines.at(-1)).toBe(" <rechnung@buerobedarf.example>");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(76);
  });

  test.each([
    "2026-02-30T09:00:00+01:00",
    "2026-11-02T25:00:00+01:00",
    "2026-11-02T09:60:00+01:00",
    "2026-11-02T09:00:00+99:99",
  ])("rejects the impossible send time %s", (sent) => {
    expect(() => headerDate(sent)).toThrow(sent);
  });
});
