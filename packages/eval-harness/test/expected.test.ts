import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "effect";
import { decodeExpectedSet, loadExpectedSet } from "../src/index.ts";
import { syntheticFolder } from "../src/synthetic/generate.ts";

const intake = (overrides: Record<string, unknown> = {}) => ({
  file: "01-a.eml",
  documents: [{ fileName: "a.pdf", documentDate: "2026-11-02" }],
  ...overrides,
});
const dated = (documentDate: unknown) =>
  intake({ documents: [{ fileName: "a.pdf", documentDate }] });

const message = (input: unknown) => {
  const result = decodeExpectedSet(input);
  return Result.isFailure(result) ? result.failure.message : "ok";
};

describe("expected.json schema", () => {
  test("the committed synthetic set decodes", async () => {
    expect(await loadExpectedSet(syntheticFolder)).toHaveProperty("intakes");
  });

  test.each([
    ["a Document date", intake()],
    ["a Document without a date", dated(null)],
    [
      "a zero-Document Intake with a description",
      intake({ documents: [], description: "no attachments" }),
    ],
    ["29 February in a leap year", dated("2028-02-29")],
  ])("accepts %s", (_, accepted) => {
    expect(message({ intakes: [accepted] })).toBe("ok");
  });

  test.each([
    ["a German date", dated("02.11.2026"), "02.11.2026"],
    ["an unpadded ISO date", dated("2026-11-2"), "2026-11-2"],
    ["30 February", dated("2026-02-30"), "2026-02-30"],
    ["29 February in a common year", dated("2026-02-29"), "2026-02-29"],
    ["month 13", dated("2026-13-01"), "2026-13-01"],
    ["a missing documentDate", intake({ documents: [{ fileName: "a.pdf" }] }), "documentDate"],
    [
      "a duplicate fileName within an Intake",
      intake({
        documents: [
          { fileName: "a.pdf", documentDate: "2026-11-02" },
          { fileName: "a.pdf", documentDate: null },
        ],
      }),
      'duplicate fileName "a.pdf"',
    ],
    ["a file that is not an .eml", intake({ file: "01-a.txt" }), '["file"]'],
    ["a file with a path", intake({ file: "../01-a.eml" }), '["file"]'],
    ["a mistyped key", intake({ descripton: "typo" }), "descripton"],
    [
      "an unknown Document key",
      intake({ documents: [{ fileName: "a.pdf", documentDate: null, isDocument: false }] }),
      "isDocument",
    ],
  ])("rejects %s", (_, rejected, detail) => {
    expect(message({ intakes: [rejected] })).toContain(detail);
  });

  test("rejects a duplicate file across the set", () => {
    expect(message({ intakes: [intake(), intake()] })).toContain('duplicate file "01-a.eml"');
  });

  test("allows the same fileName in different Intakes", () => {
    expect(message({ intakes: [intake(), intake({ file: "02-b.eml" })] })).toBe("ok");
  });

  test("reports every problem at once", () => {
    const report = message({ intakes: [dated("2026-02-30"), intake({ file: "b.txt" })] });
    expect(report).toContain("2026-02-30");
    expect(report).toContain('[1]["file"]');
  });

  test.each([
    ["is not JSON", "{"],
    ["does not decode", JSON.stringify({ intakes: [dated("2026-02-30")] })],
  ])("loading names the file when it %s", async (_, content) => {
    const folder = await mkdtemp(join(tmpdir(), "hex-expected-"));
    try {
      await Bun.write(join(folder, "expected.json"), content);
      await expect(loadExpectedSet(folder)).rejects.toThrow(join(folder, "expected.json"));
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
