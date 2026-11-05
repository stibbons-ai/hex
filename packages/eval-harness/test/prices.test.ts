import { afterAll, describe, expect, test } from "bun:test";
import { callCost, decodePriceData, fetchPriceData, modelPrices } from "../src/index.ts";
import { fakePrices } from "./fake-prices.ts";

const URL = "http://127.0.0.1:9/prices.json";

/** Entries as LiteLLM's file has them for the providers hex's candidates come from. */
const litellm = {
  sample_spec: { litellm_provider: "one of https://docs.litellm.ai/docs/providers" },
  "gpt-5.4-mini": {
    litellm_provider: "openai",
    mode: "chat",
    input_cost_per_token: 7.5e-7,
    output_cost_per_token: 4.5e-6,
    cache_read_input_token_cost: 7.5e-8,
    supports_pdf_input: true,
    supported_regions: ["global"],
  },
  "azure/gpt-5.4-nano": {
    litellm_provider: "azure",
    input_cost_per_token: 1,
    output_cost_per_token: 1,
  },
  "claude-haiku-4-5": {
    litellm_provider: "anthropic",
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
    supports_pdf_input: true,
  },
  "gemini-2.5-flash-lite": {
    litellm_provider: "vertex_ai-language-models",
    input_cost_per_token: 9,
    output_cost_per_token: 9,
    supports_pdf_input: false,
  },
  "gemini/gemini-2.5-flash-lite": {
    litellm_provider: "gemini",
    input_cost_per_token: 1e-7,
    output_cost_per_token: 4e-7,
    cache_read_input_token_cost: null,
  },
  "gpt-no-output-price": { litellm_provider: "openai", input_cost_per_token: 1e-7 },
  "gpt-no-prices": { litellm_provider: "openai", mode: "chat" },
  "gpt-free": { litellm_provider: "openai", input_cost_per_token: 0, output_cost_per_token: 0 },
  "gpt-malformed": {
    litellm_provider: "openai",
    input_cost_per_token: "1e-7",
    output_cost_per_token: 1,
  },
  "gpt-negative": {
    litellm_provider: "openai",
    input_cost_per_token: -1,
    output_cost_per_token: 1,
  },
  // A malformed price must not hide that the model can't read PDFs.
  "gpt-text-only": {
    litellm_provider: "openai",
    input_cost_per_token: 1e-7,
    output_cost_per_token: 2e-7,
    cache_read_input_token_cost: "0.1",
    supports_pdf_input: false,
  },
  "gpt-odd-flag": {
    litellm_provider: "openai",
    input_cost_per_token: 1e-7,
    output_cost_per_token: 2e-7,
    supports_pdf_input: "true",
  },
  "not-an-entry": [1, 2, 3],
};

describe("decodePriceData", () => {
  const prices = decodePriceData(URL, litellm);

  test("keeps every entry that decodes, ignoring fields the eval doesn't read", () => {
    expect(prices.status).toBe("available");
    expect(modelPrices(prices, "openai/gpt-5.4-mini")).toEqual({
      entry: "gpt-5.4-mini",
      pdfInput: true,
      pricing: { status: "priced", rates: { input: 7.5e-7, output: 4.5e-6, cachedInput: 7.5e-8 } },
    });
  });

  test("a malformed price makes its model unpriced, naming the entry and the field", () => {
    expect(modelPrices(prices, "openai/gpt-malformed")).toEqual({
      entry: "gpt-malformed",
      pdfInput: null,
      pricing: {
        status: "unpriced",
        reason: "LiteLLM entry gpt-malformed has a malformed input_cost_per_token",
      },
    });
    expect(modelPrices(prices, "openai/gpt-negative").pricing).toEqual({
      status: "unpriced",
      reason: "LiteLLM entry gpt-negative has a malformed input_cost_per_token",
    });
    expect(modelPrices(prices, "anthropic/claude-haiku-4-5").pricing.status).toBe("priced");
  });

  test("the other fields of an entry still count: supports_pdf_input false beside a malformed price", () => {
    expect(modelPrices(prices, "openai/gpt-text-only")).toEqual({
      entry: "gpt-text-only",
      pdfInput: false,
      pricing: {
        status: "unpriced",
        reason: "LiteLLM entry gpt-text-only has a malformed cache_read_input_token_cost",
      },
    });
  });

  test("a malformed supports_pdf_input is unknown; the prices still count", () => {
    expect(modelPrices(prices, "openai/gpt-odd-flag")).toEqual({
      entry: "gpt-odd-flag",
      pdfInput: null,
      pricing: { status: "priced", rates: { input: 1e-7, output: 2e-7, cachedInput: null } },
    });
  });

  test("an entry that is no object is no entry, never the whole table", () => {
    expect(modelPrices(prices, "openai/not-an-entry").pricing).toEqual({
      status: "unpriced",
      reason: "no LiteLLM entry (openai/not-an-entry or not-an-entry with litellm_provider openai)",
    });
  });

  test.each([
    ["an array", []],
    ["a string", "prices"],
    ["null", null],
  ])("%s is no price data", (_case, json) => {
    expect(decodePriceData(URL, json)).toEqual({
      url: URL,
      status: "unavailable",
      error: "the price data is no JSON object",
    });
  });
});

describe("modelPrices: provider/model to a LiteLLM entry", () => {
  const prices = decodePriceData(URL, litellm);

  test("openai/<model> is <model> of provider openai", () => {
    expect(modelPrices(prices, "openai/gpt-5.4-mini").entry).toBe("gpt-5.4-mini");
    // Azure's entry of the same model is no OpenAI price.
    expect(modelPrices(prices, "openai/gpt-5.4-nano")).toEqual({
      entry: null,
      pdfInput: null,
      pricing: {
        status: "unpriced",
        reason:
          "no LiteLLM entry (openai/gpt-5.4-nano or gpt-5.4-nano with litellm_provider openai)",
      },
    });
  });

  test("anthropic/<model> is <model> of provider anthropic", () => {
    expect(modelPrices(prices, "anthropic/claude-haiku-4-5")).toEqual({
      entry: "claude-haiku-4-5",
      pdfInput: true,
      pricing: { status: "priced", rates: { input: 1e-6, output: 5e-6, cachedInput: null } },
    });
  });

  test("google/<model> is gemini/<model> of provider gemini, not Vertex AI's bare <model>", () => {
    expect(modelPrices(prices, "google/gemini-2.5-flash-lite")).toEqual({
      entry: "gemini/gemini-2.5-flash-lite",
      pdfInput: null,
      pricing: { status: "priced", rates: { input: 1e-7, output: 4e-7, cachedInput: null } },
    });
  });

  test.each([
    ["without an output price", "gpt-no-output-price", "has no output_cost_per_token"],
    ["without prices", "gpt-no-prices", "has no input_cost_per_token and no output_cost_per_token"],
  ])("an entry %s is unpriced, naming the missing field", (_case, key, problem) => {
    expect(modelPrices(prices, `openai/${key}`)).toEqual({
      entry: key,
      pdfInput: null,
      pricing: { status: "unpriced", reason: `LiteLLM entry ${key} ${problem}` },
    });
  });

  test("an entry priced at zero for input and output is unpriced, never $0", () => {
    expect(modelPrices(prices, "openai/gpt-free").pricing).toEqual({
      status: "unpriced",
      reason: "zero prices in LiteLLM entry gpt-free",
    });
  });

  test("without price data every model is unpriced, naming the error, PDF input unknown", () => {
    const unavailable = { url: URL, status: "unavailable", error: "HTTP 503" } as const;
    expect(modelPrices(unavailable, "openai/gpt-5.4-mini")).toEqual({
      entry: null,
      pdfInput: null,
      pricing: { status: "unpriced", reason: "price data unavailable: HTTP 503" },
    });
  });
});

describe("callCost", () => {
  const rates = { input: 1e-6, output: 5e-6, cachedInput: 1e-7 };

  test("input and output tokens at their prices", () => {
    expect(callCost(rates, { inputTokens: 1000, outputTokens: 100 })).toBeCloseTo(1.5e-3, 15);
  });

  test("cached input tokens at the cached-input price instead; reasoning is output", () => {
    const usage = {
      inputTokens: 1000,
      outputTokens: 100,
      cachedInputTokens: 800,
      reasoningTokens: 60,
    };
    expect(callCost(rates, usage)).toBeCloseTo(200e-6 + 800e-7 + 500e-6, 15);
  });

  test("cached tokens beyond the input count are capped at it", () => {
    const usage = { inputTokens: 100, outputTokens: 0, cachedInputTokens: 500 };
    expect(callCost(rates, usage)).toBeCloseTo(100e-7, 15);
  });

  test("cached input tokens without a cached-input price cost the input price", () => {
    const usage = { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 800 };
    expect(callCost({ ...rates, cachedInput: null }, usage)).toBeCloseTo(1.5e-3, 15);
  });
});

describe("fetchPriceData", () => {
  const servers: { server: { stop: (force: boolean) => Promise<void> } }[] = [];
  afterAll(() => Promise.all(servers.map(({ server }) => server.stop(true))));
  const serve = (body: unknown, status?: number) => {
    const fake = fakePrices(body, status);
    servers.push(fake);
    return fake;
  };

  test("fetches and decodes the price data once", async () => {
    const fake = serve(litellm);
    const prices = await fetchPriceData(fake.url);
    expect(fake.fetches).toBe(1);
    expect(modelPrices(prices, "google/gemini-2.5-flash-lite").entry).toBe(
      "gemini/gemini-2.5-flash-lite",
    );
  });

  test("an error status is no price data, naming it", async () => {
    const fake = serve("rate limited", 429);
    expect(await fetchPriceData(fake.url)).toEqual({
      url: fake.url,
      status: "unavailable",
      error: "HTTP 429",
    });
  });

  test("a body that is no JSON is no price data", async () => {
    const fake = serve("<html>maintenance</html>");
    const prices = await fetchPriceData(fake.url);
    expect(prices).toMatchObject({ status: "unavailable", error: expect.stringContaining("JSON") });
  });

  test("an unreachable server is no price data", async () => {
    const fake = serve(litellm);
    await fake.server.stop(true);
    const prices = await fetchPriceData(fake.url);
    expect(prices).toMatchObject({ url: fake.url, status: "unavailable" });
  });
});
