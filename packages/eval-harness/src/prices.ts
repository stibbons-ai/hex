/**
 * LiteLLM's model price data (`model_prices_and_context_window.json`): per-token prices and the
 * PDF-input flag of each model, fetched once per eval run. Untrusted input: each field the eval
 * reads is decoded on its own, and a field that doesn't decode is named, never trusted: a
 * malformed price makes its model unpriced, a malformed `supports_pdf_input` leaves PDF input
 * unknown, a malformed `litellm_provider` matches no model. An entry that is no object is left
 * out, never the rest of the file.
 */
import type { TokenUsage } from "@hex/adapters";
import { messageOf } from "@hex/adapters";
import { Option, Schema } from "effect";

/** Where the price data comes from unless `HEX_EVAL_PRICES_URL` says otherwise. */
export const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** How long the fetch may take before the run goes on without prices. */
const FETCH_TIMEOUT_MS = 30_000;

/** USD per token. */
const Price = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));

/** The fields of a LiteLLM entry the eval reads, each with its schema; the rest are ignored. */
const FIELDS = {
  litellm_provider: Schema.String,
  input_cost_per_token: Price,
  output_cost_per_token: Price,
  cache_read_input_token_cost: Price,
  supports_pdf_input: Schema.Boolean,
} as const;
type Field = keyof typeof FIELDS;

/** The fields that price a model: a malformed one leaves it unpriced. */
const PRICE_FIELDS: readonly Field[] = [
  "input_cost_per_token",
  "output_cost_per_token",
  "cache_read_input_token_cost",
];

/**
 * One LiteLLM entry as far as the eval reads it: each field's value when it decodes; absent when
 * missing or `null` (as some entries have it), or when it doesn't decode, which `malformed` then
 * names.
 */
type PriceEntry = { readonly [F in Field]?: (typeof FIELDS)[F]["Type"] } & {
  readonly malformed: readonly Field[];
};

const decoders = Object.fromEntries(
  Object.entries(FIELDS).map(([field, schema]) => [field, Schema.decodeUnknownOption(schema)]),
) as Record<Field, (input: unknown) => Option.Option<unknown>>;

/** `value` as a {@link PriceEntry}; undefined when it is no JSON object. */
function decodeEntry(value: unknown): PriceEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const entry: Record<string, unknown> = {};
  const malformed: Field[] = [];
  for (const field of Object.keys(FIELDS) as Field[]) {
    if (raw[field] === undefined || raw[field] === null) continue;
    const decoded = decoders[field](raw[field]);
    if (Option.isSome(decoded)) entry[field] = decoded.value;
    else malformed.push(field);
  }
  return { ...entry, malformed } as PriceEntry;
}

/** The fetched price data, by where it came from: its entries by LiteLLM key, or why there is none. */
export type PriceData = { readonly url: string } & (
  | { readonly status: "available"; readonly entries: ReadonlyMap<string, PriceEntry> }
  | { readonly status: "unavailable"; readonly error: string }
);

/**
 * The price data in `json` (LiteLLM's file from `url`, parsed): every entry that is an object,
 * decoded field by field. Unavailable when `json` is no object of entries.
 */
export function decodePriceData(url: string, json: unknown): PriceData {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { url, status: "unavailable", error: "the price data is no JSON object" };
  }
  const entries = new Map<string, PriceEntry>();
  for (const [key, value] of Object.entries(json)) {
    const entry = decodeEntry(value);
    if (entry !== undefined) entries.set(key, entry);
  }
  return { url, status: "available", entries };
}

/**
 * The price data at `url`, fetched once; unavailable (with the reason) when the fetch fails,
 * answers no 2xx, takes over 30 s or isn't JSON, so the run goes on unpriced.
 */
export async function fetchPriceData(url: string): Promise<PriceData> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return { url, status: "unavailable", error: `HTTP ${response.status}` };
    return decodePriceData(url, await response.json());
  } catch (error) {
    return { url, status: "unavailable", error: messageOf(error) };
  }
}

/** USD per token of a priced model. */
export interface Rates {
  readonly input: number;
  readonly output: number;
  /** For cached input tokens; `null` when LiteLLM names none (cached tokens cost `input`). */
  readonly cachedInput: number | null;
}

/** What the price data says about one model. */
export interface ModelPrices {
  /** The LiteLLM key of the model's entry; `null` when none matches. */
  readonly entry: string | null;
  /** The entry's `supports_pdf_input`; `null` (unknown) without an entry or the flag. */
  readonly pdfInput: boolean | null;
  /** The model's per-token prices, or why it is unpriced. */
  readonly pricing:
    | { readonly status: "priced"; readonly rates: Rates }
    | { readonly status: "unpriced"; readonly reason: string };
}

/**
 * The LiteLLM provider of a model-router provider: Google's Gemini API is LiteLLM's `gemini`
 * (as of 2026-11-05 its unprefixed `vertex_ai-language-models` entries are Vertex AI's); every
 * other provider keeps its name.
 */
const litellmProvider = (provider: string) => (provider === "google" ? "gemini" : provider);

/**
 * What `prices` says about `model` (`provider/model`). Its entry: the first of the keys
 * `<litellm provider>/<model>` and `<model>` whose `litellm_provider` is the model's LiteLLM
 * provider ({@link litellmProvider}), so `openai/gpt-5-mini` is `gpt-5-mini`,
 * `anthropic/claude-haiku-4-5` is `claude-haiku-4-5` and `google/gemini-2.5-flash` is
 * `gemini/gemini-2.5-flash`. Priced when that entry has an input and an output price, not both
 * zero, and none of its three prices is malformed; its `supports_pdf_input` counts either way.
 */
export function modelPrices(prices: PriceData, model: string): ModelPrices {
  const unpriced = (reason: string): ModelPrices => ({
    entry: null,
    pdfInput: null,
    pricing: { status: "unpriced", reason },
  });
  if (prices.status === "unavailable") return unpriced(`price data unavailable: ${prices.error}`);
  const slash = model.indexOf("/");
  const provider = litellmProvider(model.slice(0, slash));
  const name = model.slice(slash + 1);
  const keys = [`${provider}/${name}`, name];
  const key = keys.find(
    (candidate) => prices.entries.get(candidate)?.litellm_provider === provider,
  );
  if (key === undefined) {
    // An entry under one of the keys whose provider doesn't decode may well be this model's: say
    // so rather than "no entry", and don't exclude it on its PDF flag, which is a guess then.
    const unreadable = keys.find((candidate) =>
      prices.entries.get(candidate)?.malformed.includes("litellm_provider"),
    );
    if (unreadable !== undefined) {
      const reason = `LiteLLM entry ${unreadable} has a malformed litellm_provider`;
      return { entry: unreadable, pdfInput: null, pricing: { status: "unpriced", reason } };
    }
    return unpriced(`no LiteLLM entry (${keys.join(" or ")} with litellm_provider ${provider})`);
  }
  const entry = prices.entries.get(key)!;
  const found = (pricing: ModelPrices["pricing"]): ModelPrices => ({
    entry: key,
    pdfInput: entry.supports_pdf_input ?? null,
    pricing,
  });
  const malformedPrices = entry.malformed.filter((field) => PRICE_FIELDS.includes(field));
  if (malformedPrices.length > 0) {
    const reason = `LiteLLM entry ${key} has a malformed ${malformedPrices.join(" and ")}`;
    return found({ status: "unpriced", reason });
  }
  const { input_cost_per_token: input, output_cost_per_token: output } = entry;
  if (input === undefined || output === undefined) {
    const missing = [
      ...(input === undefined ? ["input_cost_per_token"] : []),
      ...(output === undefined ? ["output_cost_per_token"] : []),
    ];
    const reason = `LiteLLM entry ${key} has no ${missing.join(" and no ")}`;
    return found({ status: "unpriced", reason });
  }
  if (input === 0 && output === 0) {
    return found({ status: "unpriced", reason: `zero prices in LiteLLM entry ${key}` });
  }
  const rates = { input, output, cachedInput: entry.cache_read_input_token_cost ?? null };
  return found({ status: "priced", rates });
}

/**
 * The USD cost of one call's `usage` at `rates`: input tokens at the input price, output tokens
 * (reasoning tokens included) at the output price, and cached input tokens, when both reported
 * and priced, at the cached-input price instead of the input price.
 */
export function callCost(
  rates: Rates,
  { inputTokens, outputTokens, cachedInputTokens }: TokenUsage,
): number {
  const cached = rates.cachedInput === null ? 0 : Math.min(cachedInputTokens ?? 0, inputTokens);
  return (
    (inputTokens - cached) * rates.input +
    cached * (rates.cachedInput ?? 0) +
    outputTokens * rates.output
  );
}
