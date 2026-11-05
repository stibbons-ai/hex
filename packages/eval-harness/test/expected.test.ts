import { describe, expect, test } from "bun:test";
import { Result } from "effect";
import { decodeExpectedSet, loadExpectedSet } from "../src/index.ts";
import { syntheticFolder } from "./paths.ts";

const intake = (overrides: Record<string, unknown> = {}) => ({
  file: "01-a.eml",
  documents: [{ fileName: "a.pdf", documentDate: "2026-11-02" }],
  ...overrides,
});

const message = (input: unknown) => {
  const result = decodeExpectedSet(input);
  return Result.isFailure(result) ? result.failure.message : "ok";
};

describe("expected.json schema", () => {
  test("the committed synthetic set decodes", async () => {
    const set = await loadExpectedSet(syntheticFolder);
    expect(set.intakes.length).toBeGreaterThanOrEqual(10);
    expect(set.intakes.length).toBeLessThanOrEqual(20);
  });

  test.each([
    ["a Document date", intake()],
    [
      "a Document without a date",
      intake({ documents: [{ fileName: "a.pdf", documentDate: null }] }),
    ],
    [
      "a zero-Document Intake with a description",
      intake({ documents: [], description: "no attachments" }),
    ],
    [
      "29 February in a leap year",
      intake({ documents: [{ fileName: "a.pdf", documentDate: "2028-02-29" }] }),
    ],
  ])("accepts %s", (_, accepted) => {
    expect(message({ intakes: [accepted] })).toBe("ok");
  });

  test.each([
    [
      "a German date",
      intake({ documents: [{ fileName: "a.pdf", documentDate: "02.11.2026" }] }),
      "02.11.2026",
    ],
    [
      "an unpadded ISO date",
      intake({ documents: [{ fileName: "a.pdf", documentDate: "2026-11-2" }] }),
      "2026-11-2",
    ],
    [
      "30 February",
      intake({ documents: [{ fileName: "a.pdf", documentDate: "2026-02-30" }] }),
      "2026-02-30",
    ],
    [
      "29 February in a common year",
      intake({ documents: [{ fileName: "a.pdf", documentDate: "2026-02-29" }] }),
      "2026-02-29",
    ],
    [
      "month 13",
      intake({ documents: [{ fileName: "a.pdf", documentDate: "2026-13-01" }] }),
      "2026-13-01",
    ],
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
  ])("rejects %s", (_, rejected, detail) => {
    expect(message({ intakes: [rejected] })).toContain(detail);
  });

  test("rejects a duplicate file across the set", () => {
    expect(message({ intakes: [intake(), intake()] })).toContain('duplicate file "01-a.eml"');
  });

  test("allows the same fileName in different Intakes", () => {
    expect(message({ intakes: [intake(), intake({ file: "02-b.eml" })] })).toBe("ok");
  });
});
