import { afterEach, describe, expect, test } from "bun:test";
import type { MastraModelConfig } from "@mastra/core/llm";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { Effect, Exit } from "effect";
import { DateExtractor, dateExtractorLayer } from "../src";
import type { DocumentFile } from "../src";

type MockOptions = ConstructorParameters<typeof MastraLanguageModelV2Mock>[0];

/** What the model was called with, as far as these tests look at it. */
interface Call {
  prompt: { role: string; content: unknown }[];
  responseFormat?: { type: string; schema?: unknown };
}

/**
 * A mock language model (through Mastra's model path, as the router's models are) that records
 * every call and answers `reply` as its text, or fails with it when it is an Error.
 */
function scriptedModel(reply: string | Error) {
  const calls: Call[] = [];
  const model = new MastraLanguageModelV2Mock({
    doGenerate: async (options: Call) => {
      calls.push(options);
      if (reply instanceof Error) throw reply;
      return {
        content: [{ type: "text", text: reply }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
  } as unknown as MockOptions);
  // Mastra's mock and its model type disagree under exactOptionalPropertyTypes.
  return { model: model as unknown as MastraModelConfig, calls };
}

const PDF = new TextEncoder().encode("%PDF-1.4\nRechnungsdatum 05.10.2026\n%%EOF\n");
/** A PNG signature and IHDR chunk start: enough for a model input part. */
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

const pdfDocument: DocumentFile = {
  content: PDF,
  mediaType: "application/pdf",
  fileName: "Rechnung.pdf",
};

const extract = (model: MastraModelConfig, document: DocumentFile) =>
  Effect.runPromiseExit(
    DateExtractor.use((extractor) => extractor.extract(document)).pipe(
      Effect.provide(dateExtractorLayer(model)),
    ),
  );

const success = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
  return exit.value;
};

/** The user message's parts of a call. */
const userParts = (call: Call | undefined) =>
  call?.prompt.find(({ role }) => role === "user")?.content as Record<string, unknown>[];

describe("DateExtractor (live layer on a mock model)", () => {
  test("a PDF goes to the model natively; a structured answer comes back as the date", async () => {
    const { model, calls } = scriptedModel('{"year":2026,"month":10,"day":5}');
    const answer = success(await extract(model, pdfDocument));
    expect(answer).toEqual({ year: 2026, month: 10, day: 5 });
    expect(calls).toHaveLength(1);
    const parts = userParts(calls[0]);
    const file = parts.find(({ type }) => type === "file");
    expect(file).toMatchObject({ mediaType: "application/pdf" });
    expect(Buffer.from(file?.data as string, "base64")).toEqual(Buffer.from(PDF));
    // The file name is no hint the model may date the Document by.
    expect(JSON.stringify(calls[0]?.prompt)).not.toContain("Rechnung.pdf");
    expect(calls[0]?.responseFormat).toMatchObject({
      type: "json",
      schema: { required: ["year", "month", "day"] },
    });
  });

  test("an image goes to the model with its media type and bytes", async () => {
    const { model, calls } = scriptedModel('{"year":null,"month":null,"day":null}');
    const answer = success(
      await extract(model, { content: PNG, mediaType: "image/png", fileName: "Beleg.png" }),
    );
    expect(answer).toEqual({ year: null, month: null, day: null });
    const file = userParts(calls[0]).find(({ type }) => type === "file");
    expect(file).toMatchObject({ mediaType: "image/png" });
    expect(Buffer.from(file?.data as string, "base64")).toEqual(Buffer.from(PNG));
  });

  test.each([
    ["not JSON", "The invoice is dated 5 October 2026."],
    ["a string year", '{"year":"2026","month":10,"day":5}'],
    ["missing fields", '{"year":2026}'],
    ["a fractional day", '{"year":2026,"month":10,"day":5.5}'],
  ])("an answer that is %s is no usable date, not an error", async (_case, reply) => {
    const { model } = scriptedModel(reply);
    expect(success(await extract(model, pdfDocument))).toBeUndefined();
  });

  describe("a failed model call", () => {
    const key = "sk-hex-test-0123456789abcdef";
    afterEach(() => {
      delete process.env.HEX_TEST_API_KEY;
    });

    test("is the extractor's error, naming the Document and the model, never the API key", async () => {
      process.env.HEX_TEST_API_KEY = key;
      const { model } = scriptedModel(new Error(`401 Incorrect API key provided: ${key}`));
      const exit = await extract(model, pdfDocument);
      expect(Exit.isFailure(exit)).toBe(true);
      const message = String(exit);
      expect(message).toContain("DateExtractionError");
      expect(message).toContain(
        'reading the Document date of "Rechnung.pdf" with mock-provider/mock-model-id failed: 401 Incorrect API key provided: HEX_TEST_API_KEY',
      );
      expect(message).not.toContain(key);
    });
  });
});
