import { isCalendarDate } from "@hex/domain";
import type { CalendarDate } from "@hex/domain";
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { noopLogger } from "@mastra/core/logger";
import { StreamErrorRetryProcessor } from "@mastra/core/processors";
import { Context, Data, Effect, Layer, Option, Schema } from "effect";
import { excerpt, messageOf, redact } from "./errors";
import { toMastraSchema } from "./schema";

/**
 * The model's answer to "what is this Document's date": all three `null` when it found none.
 * Plain integers, not checked to be a real day: {@link documentDateOf} decodes an answer with
 * this schema and checks that.
 */
export const DocumentDateAnswer = Schema.Struct({
  year: Schema.NullOr(Schema.Int),
  month: Schema.NullOr(Schema.Int),
  day: Schema.NullOr(Schema.Int),
});
export type DocumentDateAnswer = typeof DocumentDateAnswer.Type;

const decodeAnswer = Schema.decodeUnknownOption(DocumentDateAnswer);

/**
 * The Document date in a model's answer: present only when the answer decodes as
 * {@link DocumentDateAnswer} with no `null` and names a real day (`isCalendarDate`). Anything else
 * (no date found, malformed, 30 February) is none, as `planFiling` would fall back on it.
 */
export function documentDateOf(answer: unknown): CalendarDate | undefined {
  const decoded = decodeAnswer(answer);
  if (Option.isNone(decoded)) return undefined;
  const { year, month, day } = decoded.value;
  if (year === null || month === null || day === null) return undefined;
  const date = { year, month, day };
  return isCalendarDate(date) ? date : undefined;
}

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

/**
 * The provider-reported tokens of one model call, as Mastra's model router reports them:
 * `inputTokens` includes `cachedInputTokens`, `outputTokens` includes
 * `reasoningTokens`. The two details are present only when the provider reports them.
 */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
}

/** What one {@link DateExtractor} call got back. */
export interface DateExtraction {
  /**
   * The model's answer, undecoded: undefined when the model's reply yields no object matching
   * the schema (no JSON, a schema mismatch, an empty reply, one cut off at the token limit or
   * withheld by a content filter).
   */
  readonly answer: unknown;
  /** The call's tokens; undefined when the provider reported no input or output count. */
  readonly usage: TokenUsage | undefined;
}

/** Reads a Document's Document date with a model. */
export class DateExtractor extends Context.Service<
  DateExtractor,
  {
    /**
     * The model's answer for `document` and the call's token usage. Fails only when the model
     * call itself fails, never for an unusable answer.
     */
    readonly extract: (
      document: DocumentFile,
    ) => Effect.Effect<DateExtraction, DateExtractionError>;
  }
>()("hex/DateExtractor") {}

/** The usage Mastra reports for one step of a call. */
interface StepUsage {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly cachedInputTokens?: number | undefined;
  readonly reasoningTokens?: number | undefined;
}

const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "reasoningTokens",
] as const;

/**
 * The call's usage: the sum over its steps. Not Mastra's `totalUsage`: after a retried
 * transient error (an attempt that reported nothing) `totalUsage` loses the counts (as of
 * `@mastra/core` 1.80.0), while the step that answered keeps them. A field no step reported
 * stays absent; without both an input and an output count the call has no usage.
 */
function tokenUsageOf(steps: readonly { readonly usage?: StepUsage | undefined }[]) {
  const sum: Partial<Record<(typeof USAGE_FIELDS)[number], number>> = {};
  for (const { usage } of steps) {
    for (const field of USAGE_FIELDS) {
      const count = usage?.[field];
      if (count !== undefined) sum[field] = (sum[field] ?? 0) + count;
    }
  }
  const { inputTokens, outputTokens, ...details } = sum;
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens, ...details } satisfies TokenUsage;
}

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
  return redact(
    message,
    Object.entries(process.env).flatMap(([name, value]) =>
      name.endsWith("_API_KEY") && value && value.length >= 8 ? [[value, name] as const] : [],
    ),
  );
}

/**
 * The HTTP error status (400 and up) of the provider call `error` (or one of its causes) failed
 * with, if any; a 2xx whose body couldn't be read has none worth showing.
 */
function httpStatusOf(error: unknown): number | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Object; depth++) {
    const { name, statusCode, cause } = current as {
      name?: unknown;
      statusCode?: unknown;
      cause?: unknown;
    };
    if (name === "AI_APICallError" && typeof statusCode === "number" && statusCode >= 400) {
      return statusCode;
    }
    current = cause;
  }
  return undefined;
}

/** Options of {@link dateExtractorLayer}. */
export interface DateExtractorOptions {
  /**
   * Least wait before retrying a transient provider error (rate limit, overload, a dropped or
   * refused connection); longer when the provider asks (Retry-After, up to 30 s). Default 3000 ms.
   */
  readonly retryDelayMs?: number;
  /**
   * Most time one `extract` call may take, retries included; past it the call (and its HTTP
   * request) is aborted and fails with a {@link DateExtractionError}. Default 120 000 ms. Nothing
   * below has a whole-call deadline: Mastra's `modelSettings.timeout` is unset by default, the AI
   * SDK providers fetch with only the caller's signal, and Bun's `fetch` only has a 5-minute
   * socket idle timeout that any received byte restarts. A silent provider would hold the mailbox
   * watcher at least 5 minutes per attempt, one that trickles bytes for good.
   */
  readonly timeoutMs?: number;
}

/**
 * The DateExtractor on `model`: a Mastra model-router id (`provider/model`, its API key from the
 * provider's usual variable, e.g. `OPENAI_API_KEY`) or a model instance (tests pass a mock). Each
 * Document goes to the model natively as a file part with its media type; the answer comes back
 * as structured output. A reply that yields no object matching the schema (see `extract`) is
 * undefined (Mastra's `warn` strategy), not an error. A call taking longer than `timeoutMs` is
 * aborted and fails. The agent logs nothing: the error carries what went wrong.
 */
export function dateExtractorLayer(
  model: MastraModelConfig,
  { retryDelayMs = 3000, timeoutMs = 120_000 }: DateExtractorOptions = {},
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
    // Document. Transient errors the provider marks retryable (rate limit, overload, a dropped or
    // refused connection, which Mastra's provider wraps as retryable) are retried twice, as the
    // default retry processor does; its Gemini MALFORMED_FUNCTION_CALL matcher is not kept.
    errorProcessorDefaults: false,
    errorProcessors: [new StreamErrorRetryProcessor({ maxRetries: 2, delayMs: retryDelayMs })],
  });
  agent.__setLogger(noopLogger);
  const schema = toMastraSchema(DocumentDateAnswer);
  const modelShown = modelName(model);
  return Layer.succeed(DateExtractor, {
    extract: ({ content, mediaType, fileName }) => {
      const reading = `reading the Document date of ${JSON.stringify(fileName)} with ${modelShown}`;
      return Effect.tryPromise({
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
          const shown = excerpt(withoutApiKeys(messageOf(cause)));
          const status = httpStatusOf(cause);
          return new DateExtractionError({
            message: `${reading} failed${status === undefined ? "" : ` (HTTP ${status})`}: ${shown}`,
          });
        },
      }).pipe(
        // Interrupting `tryPromise` aborts its signal, and with it the request.
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.fail(
              new DateExtractionError({ message: `${reading} timed out after ${timeoutMs} ms` }),
            ),
        }),
        Effect.map(({ object, steps }): DateExtraction => ({
          answer: object,
          usage: tokenUsageOf(steps),
        })),
      );
    },
  });
}
