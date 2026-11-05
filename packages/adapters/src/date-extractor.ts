import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { noopLogger } from "@mastra/core/logger";
import { StreamErrorRetryProcessor } from "@mastra/core/processors";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { messageOf } from "./errors";
import { toMastraSchema } from "./schema";

/**
 * The model's answer to "what is this Document's date": all three `null` when it found none.
 * Plain integers, not checked to be a real day: the caller decodes the answer with this schema
 * and leaves that to the domain (`isCalendarDate`/`planFiling`).
 */
export const DocumentDateAnswer = Schema.Struct({
  year: Schema.NullOr(Schema.Int),
  month: Schema.NullOr(Schema.Int),
  day: Schema.NullOr(Schema.Int),
});
export type DocumentDateAnswer = typeof DocumentDateAnswer.Type;

/** One Document as the model reads it. */
export interface DocumentFile {
  readonly content: Uint8Array;
  /** The media type the model gets it as (`documentMediaType`), e.g. `application/pdf`. */
  readonly mediaType: string;
  /** The name it is filed under; for error messages only, the model never sees it. */
  readonly fileName: string;
}

/**
 * The model call failed (network, auth, missing API key, rate limit, provider error). It carries
 * no cause: a provider's error holds the request, the Document's content included, and the
 * workflow persists its failure.
 */
export class DateExtractionError extends Data.TaggedError("DateExtractionError")<{
  readonly message: string;
}> {}

/** Reads a Document's Document date with a model. */
export class DateExtractor extends Context.Service<
  DateExtractor,
  {
    /**
     * The model's answer for `document`, undecoded: undefined when the model's reply yields no
     * object matching the schema (no JSON, a schema mismatch, an empty reply, one cut off at the
     * token limit or withheld by a content filter). Fails only when the model call itself fails,
     * never for an unusable answer.
     */
    readonly extract: (document: DocumentFile) => Effect.Effect<unknown, DateExtractionError>;
  }
>()("hex/DateExtractor") {}

const INSTRUCTIONS = `You read the Document date from a business document: an invoice, receipt, credit note or similar, in German or English.

The Document date is the date the document was issued: the invoice date (Rechnungsdatum), voucher date (Belegdatum), receipt date (Quittungsdatum), or the issue date printed in its header. It is never a due date (Fälligkeitsdatum, zahlbar bis), a delivery or service date or period (Lieferdatum, Leistungsdatum, Leistungszeitraum), an order date (Bestelldatum), or the date the document was printed or sent.

Use only what is printed on the document itself, never its file name. Answer with the year (four digits), month (1 to 12) and day of the Document date. When the document shows no such date, or you can't read it, answer null for year, month and day.`;

/** How an error names the model: its router id, else the instance's provider and model id. */
function modelName(model: MastraModelConfig): string {
  if (typeof model === "string") return model;
  const { provider, modelId } = model as { provider?: unknown; modelId?: unknown };
  return typeof provider === "string" && typeof modelId === "string"
    ? `${provider}/${modelId}`
    : "the configured model";
}

/**
 * `message` with the value of each set `*_API_KEY` variable replaced by its name. Values under 8
 * characters are left alone (too likely to match ordinary text), and credentials under other
 * names (`AWS_SECRET_ACCESS_KEY`, `*_TOKEN`) are not scrubbed.
 */
function withoutApiKeys(message: string): string {
  return Object.entries(process.env).reduce(
    (text, [name, value]) =>
      name.endsWith("_API_KEY") && value && value.length >= 8 ? text.replaceAll(value, name) : text,
    message,
  );
}

/**
 * How much of a provider's error message an error keeps: some quote the rejected request, the
 * Document's content included, and the workflow persists its failure.
 */
const MAX_PROVIDER_MESSAGE = 300;

/** The HTTP status of the provider call `error` (or one of its causes) failed with, if any. */
function httpStatusOf(error: unknown): number | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Object; depth++) {
    const { name, statusCode, cause } = current as {
      name?: unknown;
      statusCode?: unknown;
      cause?: unknown;
    };
    if (name === "AI_APICallError" && typeof statusCode === "number") return statusCode;
    current = cause;
  }
  return undefined;
}

/** Options of {@link dateExtractorLayer}. */
export interface DateExtractorOptions {
  /** Wait before retrying a transient provider error (rate limit, overload); default 3000 ms. */
  readonly retryDelayMs?: number;
}

/**
 * The DateExtractor on `model`: a Mastra model-router id (`provider/model`, its API key from the
 * provider's usual variable, e.g. `OPENAI_API_KEY`) or a model instance (tests pass a mock). Each
 * Document goes to the model natively as a file part with its media type; the answer comes back
 * as structured output. A reply that yields no object matching the schema (see `extract`) is
 * undefined (Mastra's `warn` strategy), not an error. The agent logs nothing: the error carries
 * what went wrong.
 */
export function dateExtractorLayer(
  model: MastraModelConfig,
  { retryDelayMs = 3000 }: DateExtractorOptions = {},
): Layer.Layer<DateExtractor> {
  // Never register this Agent on a Mastra instance: its logger would replace the no-op one and
  // log provider errors, which hold the request and with it the Document.
  const agent = new Agent({
    id: "hex-date-extractor",
    name: "hex-date-extractor",
    instructions: INSTRUCTIONS,
    model,
    // Mastra's default error processors include one that, when a provider refuses the file,
    // replaces it with a placeholder text and asks again: the model would answer without the
    // Document. Only transient errors the provider marks retryable are retried, twice, as the
    // default retry processor does; its extra matchers (ECONNRESET / socket hang up, Gemini's
    // MALFORMED_FUNCTION_CALL) are not kept: a reset connection fails the run, and a re-run
    // retries it.
    errorProcessorDefaults: false,
    errorProcessors: [new StreamErrorRetryProcessor({ maxRetries: 2, delayMs: retryDelayMs })],
  });
  agent.__setLogger(noopLogger);
  const schema = toMastraSchema(DocumentDateAnswer);
  return Layer.succeed(DateExtractor, {
    extract: ({ content, mediaType, fileName }) =>
      Effect.tryPromise({
        try: (signal) =>
          agent.generate(
            [
              {
                role: "user",
                content: [
                  { type: "file", data: content, mimeType: mediaType },
                  { type: "text", text: "What is this document's Document date?" },
                ],
              },
            ],
            { structuredOutput: { schema, errorStrategy: "warn" }, abortSignal: signal },
          ),
        catch: (cause) => {
          const reason = withoutApiKeys(messageOf(cause)) || "the provider gave no message";
          const shown =
            reason.length > MAX_PROVIDER_MESSAGE
              ? `${reason.slice(0, MAX_PROVIDER_MESSAGE)}…`
              : reason;
          const status = httpStatusOf(cause);
          return new DateExtractionError({
            message: `reading the Document date of ${JSON.stringify(fileName)} with ${modelName(model)} failed${status === undefined ? "" : ` (HTTP ${status})`}: ${shown}`,
          });
        },
      }).pipe(Effect.map(({ object }): unknown => object)),
  });
}
