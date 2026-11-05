import { afterEach, describe, expect, test } from "bun:test";
import type { MastraModelConfig } from "@mastra/core/llm";
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock";
import { documentMediaType } from "@hex/domain";
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
 * every call and answers the n-th call with `replies[n]` (the last one for any later call) as its
 * text, reporting one input and one output token, or fails with it when it is an Error.
 */
function scriptedModel(...replies: (string | Error)[]) {
  return usageModel({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }, ...replies);
}

/** {@link scriptedModel}, reporting `usage` (the AI SDK's) on each answer. */
function usageModel(usage: Record<string, number> | undefined, ...replies: (string | Error)[]) {
  const calls: Call[] = [];
  const model = new MastraLanguageModelV2Mock({
    doGenerate: async (options: Call) => {
      calls.push(options);
      const reply = replies[Math.min(calls.length, replies.length) - 1]!;
      if (reply instanceof Error) throw reply;
      return {
        content: [{ type: "text", text: reply }],
        finishReason: "stop",
        usage,
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
      Effect.provide(dateExtractorLayer(model, { retryDelayMs: 0 })),
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
    const { answer, usage } = success(await extract(model, pdfDocument));
    expect(answer).toEqual({ year: 2026, month: 10, day: 5 });
    expect(usage).toEqual({ inputTokens: 1, outputTokens: 1 });
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
    const { answer } = success(
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
    expect(success(await extract(model, pdfDocument)).answer).toBeUndefined();
  });

  describe("the call's token usage, as the provider reported it", () => {
    const reply = '{"year":2026,"month":10,"day":5}';

    test("input and output, with cached-input and reasoning tokens when reported", async () => {
      const { model } = usageModel(
        {
          inputTokens: 1200,
          outputTokens: 80,
          totalTokens: 1280,
          cachedInputTokens: 1024,
          reasoningTokens: 64,
        },
        reply,
      );
      expect(success(await extract(model, pdfDocument)).usage).toEqual({
        inputTokens: 1200,
        outputTokens: 80,
        cachedInputTokens: 1024,
        reasoningTokens: 64,
      });
    });

    test("none when the provider reported input tokens but no output count", async () => {
      const { model } = usageModel({ inputTokens: 1200 }, reply);
      expect(success(await extract(model, pdfDocument)).usage).toBeUndefined();
    });

    test("none when the provider reported no counts; the answer still counts", async () => {
      const { model } = usageModel(undefined, reply);
      expect(success(await extract(model, pdfDocument))).toEqual({
        answer: { year: 2026, month: 10, day: 5 },
        usage: undefined,
      });
    });

    test("of the call that answered, after a retried transient error", async () => {
      const overloaded = Object.assign(new Error("503 Service Unavailable"), {
        name: "AI_APICallError",
        statusCode: 503,
        isRetryable: true,
      });
      const { model, calls } = usageModel(
        { inputTokens: 300, outputTokens: 20, totalTokens: 320 },
        overloaded,
        reply,
      );
      expect(success(await extract(model, pdfDocument)).usage).toEqual({
        inputTokens: 300,
        outputTokens: 20,
      });
      expect(calls).toHaveLength(2);
    });
  });

  describe("Mastra sends every Document hex's sniff (documentMediaType) lets through", () => {
    const ascii = (text: string) => new TextEncoder().encode(text);
    const pdfAt1022 = new Uint8Array(1030).fill(0x20);
    pdfAt1022.set(ascii("%PDF-1.4"), 1022);
    // [case, declared type, content: only the signature hex checks for]
    test.each([
      ["a PDF with %PDF at byte 1022", "application/pdf", pdfAt1022],
      ["a JPEG", "image/jpeg", Uint8Array.from([0xff, 0xd8])],
      ["a PNG", "image/png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47])],
      ["a GIF87a", "image/gif", ascii("GIF87a")],
      ["a GIF89a", "image/gif", ascii("GIF89a")],
      ["a WebP", "image/webp", ascii("RIFF\u0000\u0000\u0000\u0000WEBP")],
    ])("%s", async (_case, declared, content) => {
      const mediaType = documentMediaType({ mimeType: declared, fileName: "x", content });
      expect(mediaType).toBe(declared);
      const { model, calls } = scriptedModel('{"year":null,"month":null,"day":null}');
      success(await extract(model, { content, mediaType: declared, fileName: "x" }));
      expect(JSON.stringify(calls[0]?.prompt)).not.toContain("Attachment unavailable");
      const file = userParts(calls[0]).find(({ type }) => type === "file");
      expect(file).toMatchObject({ mediaType: declared });
      expect(Buffer.from(file?.data as string, "base64")).toEqual(Buffer.from(content));
    });
  });

  describe("a transient provider error (retryable, e.g. 503)", () => {
    const overloaded = () =>
      Object.assign(new Error("503 Service Unavailable"), {
        name: "AI_APICallError",
        statusCode: 503,
        isRetryable: true,
      });

    test("is retried: the next answer counts", async () => {
      const { model, calls } = scriptedModel(overloaded(), '{"year":2026,"month":10,"day":5}');
      expect(success(await extract(model, pdfDocument)).answer).toEqual({
        year: 2026,
        month: 10,
        day: 5,
      });
      expect(calls).toHaveLength(2);
    });

    test("fails the call after two retries", async () => {
      const { model, calls } = scriptedModel(overloaded(), overloaded(), overloaded(), "{}");
      const exit = await extract(model, pdfDocument);
      expect(String(exit)).toContain("DateExtractionError");
      expect(String(exit)).toContain("failed (HTTP 503): 503 Service Unavailable");
      expect(calls).toHaveLength(3);
    });
  });

  describe("a failed model call", () => {
    const key = "sk-hex-test-0123456789abcdef";
    afterEach(() => {
      delete process.env.HEX_TEST_API_KEY;
    });

    test("is the extractor's error, naming the Document and the model, never the API key", async () => {
      process.env.HEX_TEST_API_KEY = key;
      // A refused key, as the provider SDK raises it: not retryable, so exactly one call.
      const refused = Object.assign(new Error(`401 Incorrect API key provided: ${key}`), {
        name: "AI_APICallError",
        statusCode: 401,
        isRetryable: false,
      });
      const { model, calls } = scriptedModel(refused, '{"year":2026,"month":10,"day":5}');
      const exit = await extract(model, pdfDocument);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(calls).toHaveLength(1);
      const message = String(exit);
      expect(message).toContain("DateExtractionError");
      expect(message).toContain(
        'reading the Document date of "Rechnung.pdf" with mock-provider/mock-model-id failed (HTTP 401): 401 Incorrect API key provided: HEX_TEST_API_KEY',
      );
      expect(message).not.toContain(key);
    });

    test("a provider refusing the file fails the call; the model is never asked without it", async () => {
      // What an AI SDK provider throws for a file type it won't send; Mastra's default error
      // processors would replace the file by a placeholder and ask again.
      const refusal = Object.assign(
        new Error("'file part media type application/pdf' functionality not supported."),
        {
          name: "AI_UnsupportedFunctionalityError",
          functionality: "file part media type application/pdf",
        },
      );
      const { model, calls } = scriptedModel(refusal, '{"year":2026,"month":10,"day":5}');
      const exit = await extract(model, pdfDocument);
      expect(String(exit)).toContain(
        "DateExtractionError: reading the Document date of \"Rechnung.pdf\" with mock-provider/mock-model-id failed: 'file part media type application/pdf' functionality not supported.",
      );
      expect(calls).toHaveLength(1);
    });

    test("keeps at most 300 characters of the provider's message", async () => {
      const quoted = "x".repeat(1000);
      const { model } = scriptedModel(new Error(`400 invalid file: ${quoted}`));
      const exit = await extract(model, pdfDocument);
      expect(Exit.isFailure(exit)).toBe(true);
      const message = String(exit);
      expect(message).toContain(`failed: 400 invalid file: ${"x".repeat(300 - 18)}…`);
      expect(message).not.toContain("x".repeat(300));
    });

    test("redacts an API key before the cut, even one straddling character 300", async () => {
      process.env.HEX_TEST_API_KEY = key;
      // The key starts 10 characters before the cut; cutting first would leave its prefix.
      const { model } = scriptedModel(new Error(`${"y".repeat(290)}${key} tail`));
      const message = String(await extract(model, pdfDocument));
      expect(message).toContain(`failed: ${"y".repeat(290)}HEX_TEST_A…`);
      expect(message).not.toContain(key.slice(0, 10));
    });

    test.each([
      ["empty", ""],
      ["whitespace only", "  \n "],
    ])(
      "a provider error whose message is %s still says what failed: its HTTP status",
      async (_case, text) => {
        const tooLarge = Object.assign(new Error(text), {
          name: "AI_APICallError",
          statusCode: 413,
          isRetryable: false,
          responseBody: "",
        });
        const { model, calls } = scriptedModel(tooLarge);
        expect(String(await extract(model, pdfDocument))).toContain(
          'reading the Document date of "Rechnung.pdf" with mock-provider/mock-model-id failed (HTTP 413): no message',
        );
        expect(calls).toHaveLength(1);
      },
    );

    test("a status below 400 (a body that couldn't be read) is not shown as the failure", async () => {
      const unreadable = Object.assign(new Error("Invalid JSON response"), {
        name: "AI_APICallError",
        statusCode: 200,
        isRetryable: false,
      });
      const { model } = scriptedModel(unreadable);
      expect(String(await extract(model, pdfDocument))).toContain(
        "with mock-provider/mock-model-id failed: Invalid JSON response",
      );
    });
  });
});
