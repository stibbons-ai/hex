/**
 * Seam test of the eval (issues #12, #13): `runEval` on fixture folders with scripted
 * DateExtractors per model and a scripted price table, asserting the computed figures and the
 * reports it writes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateExtractionError, DateExtractor } from "@hex/adapters";
import type { TokenUsage } from "@hex/adapters";
import { Effect, Layer, Schema } from "effect";
import { Report, decodePriceData, loadExpectedSet, runEval } from "../src/index.ts";
import type { EvalOptions, ExpectedSet } from "../src/index.ts";
import { syntheticFolder } from "../src/synthetic/generate.ts";

let directory: string;
let labels: ExpectedSet;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-eval-run-"));
  labels = await loadExpectedSet(syntheticFolder);
});

afterAll(() => rm(directory, { recursive: true, force: true }));

afterEach(() => setSystemTime());

/** The model's answer naming `date` (`YYYY-MM-DD`), or no date. */
function answer(date: string | null) {
  if (date === null) return { year: null, month: null, day: null };
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
}

const USAGE: TokenUsage = { inputTokens: 1000, outputTokens: 50 };

/** What a scripted call answers: the model's answer and the usage it reports, or a failure. */
interface Reply {
  answer: unknown;
  usage?: TokenUsage | undefined;
}

/**
 * A DateExtractor answering per file name: `script` if it has the name (a bare answer reports
 * {@link USAGE}), else the label with {@link USAGE}; each call takes `delayMs` first.
 */
function scriptedExtractor(
  script: Readonly<Record<string, unknown>> = {},
  { delayMs = 0 }: { delayMs?: number } = {},
) {
  const truth = new Map(
    labels.intakes.flatMap(({ documents }) =>
      documents.map(({ fileName, documentDate }) => [fileName, answer(documentDate)] as const),
    ),
  );
  const calls: string[] = [];
  const layer = Layer.succeed(DateExtractor, {
    extract: ({ fileName }) => {
      calls.push(fileName);
      const scripted = Object.hasOwn(script, fileName) ? script[fileName] : truth.get(fileName);
      const result =
        scripted instanceof DateExtractionError
          ? Effect.fail(scripted)
          : Effect.succeed(
              scripted instanceof Object && "answer" in scripted
                ? { usage: undefined, ...(scripted as Reply) }
                : { answer: scripted, usage: USAGE },
            );
      return delayMs === 0 ? result : Effect.andThen(Effect.sleep(delayMs), result);
    },
  });
  return { layer, calls };
}

/** The scripted price table's URL; nothing listens there. */
const PRICES_URL = "http://127.0.0.1:9/prices.json";

/** LiteLLM's entries for the scripted models, an odd one and a malformed one among them. */
const priceTable = {
  sample_spec: { litellm_provider: "one of https://docs.litellm.ai/docs/providers", mode: "chat" },
  "gpt-5-mini": {
    litellm_provider: "openai",
    input_cost_per_token: 2.5e-7,
    output_cost_per_token: 2e-6,
    supports_pdf_input: true,
    max_tokens: 128000,
  },
  "claude-haiku-4-5": {
    litellm_provider: "anthropic",
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
    cache_read_input_token_cost: 1e-7,
    supports_pdf_input: true,
  },
  // The Gemini API's entry, and Vertex AI's under the bare name at another price.
  "gemini/gemini-2.5-flash": {
    litellm_provider: "gemini",
    input_cost_per_token: 3e-7,
    output_cost_per_token: 2.5e-6,
  },
  "gemini-2.5-flash": {
    litellm_provider: "vertex_ai-language-models",
    input_cost_per_token: 9,
    output_cost_per_token: 9,
    supports_pdf_input: false,
  },
  "gpt-text-only": {
    litellm_provider: "openai",
    input_cost_per_token: 1e-7,
    supports_pdf_input: false,
  },
  "gpt-broken": { litellm_provider: "openai", input_cost_per_token: "cheap" },
};
const prices = decodePriceData(PRICES_URL, priceTable);

/** No price data, as after a failed fetch. */
const noPrices = { url: PRICES_URL, status: "unavailable", error: "HTTP 503" } as const;

/** `runEval` with one scripted model, `scripted/model`, on `layer`, no price data by default. */
const runOne = (
  layer: Layer.Layer<DateExtractor>,
  options: Pick<EvalOptions, "fixtures" | "resultsRoot"> & Partial<EvalOptions>,
) =>
  runEval({ models: ["scripted/model"], dateExtractor: () => layer, prices: noPrices, ...options });

let folders = 0;
/** A fresh, not yet created path under the temp directory. */
const newFolder = (name: string) => join(directory, `${name}-${++folders}`);

/**
 * A fixture folder with copies of the synthetic `.eml`s `intakes` names, labelled by them; `edit`
 * rewrites a mail's text (byte for byte as latin1), or leaves it out by returning undefined.
 */
async function fixtureFolder(
  intakes: ExpectedSet["intakes"],
  edit: (file: string, mail: string) => string | undefined = (_, mail) => mail,
): Promise<string> {
  const folder = await mkdtemp(join(directory, "fixtures-"));
  for (const { file } of intakes) {
    const mail = edit(file, await readFile(join(syntheticFolder, file), "latin1"));
    if (mail !== undefined) await writeFile(join(folder, file), mail, "latin1");
  }
  await writeFile(join(folder, "expected.json"), JSON.stringify({ intakes }));
  return folder;
}

const label = (file: string) => labels.intakes.find((intake) => intake.file === file)!;

describe("runEval on the synthetic set", () => {
  test("computes detection and Document date figures and writes both reports", async () => {
    const { layer, calls } = scriptedExtractor({
      "Rechnung-RE-2026-1042.pdf": answer("2026-11-03"), // wrong day, right month
      "PP-3301.pdf": answer("2026-10-01"), // wrong month
      "INV-2026-0815.pdf": answer(null), // no date for a dated Document
      "Kostenvoranschlag.pdf": answer("2026-06-01"), // a date for the undated Document
      "Kassenbeleg.png": { year: 2026, month: 2, day: 30 }, // no real day: none
      "scan-0001.pdf": new DateExtractionError({ message: "provider down" }),
    });
    const resultsRoot = newFolder("results");
    const { report, folder } = await runOne(layer, { fixtures: syntheticFolder, resultsRoot });

    expect(calls).toHaveLength(14);
    const { intakes: detectionRows, ...detection } = report.detection;
    expect(detection).toEqual({
      truePositives: 14,
      falsePositives: 0,
      falseNegatives: 0,
      precision: { count: 14, total: 14, value: 1 },
      recall: { count: 14, total: 14, value: 1 },
    });
    const [model] = report.models;
    expect(report.models).toHaveLength(1);
    expect(model!.extraction).toEqual({
      exact: { count: 8, total: 14, value: 8 / 14 },
      month: { count: 9, total: 14, value: 9 / 14 },
      notSent: 0,
      failed: 1,
    });
    const row = (file: string) => model!.intakes.find((intake) => intake.file === file)!;
    expect(row("01-de-pdf-invoice.eml").documents).toEqual([
      {
        fileName: "Rechnung-RE-2026-1042.pdf",
        expected: "2026-11-02",
        status: "answered",
        predicted: "2026-11-03",
        exact: false,
        month: true,
        latencyMs: expect.any(Number),
        tokens: { input: 1000, output: 50, cachedInput: null, reasoning: null },
        costUsd: null,
      },
    ]);
    expect(row("07-en-scan-pdf.eml").documents).toEqual([
      {
        fileName: "scan-0001.pdf",
        expected: "2026-08-07",
        status: "failed",
        error: "provider down",
        exact: false,
        month: false,
        latencyMs: expect.any(Number),
      },
    ]);
    expect(row("14-de-undated-document.eml").documents[0]).toMatchObject({
      expected: null,
      predicted: "2026-06-01",
      exact: false,
      month: false,
    });
    expect(row("13-de-multiple-documents.eml").documents[2]).toMatchObject({
      fileName: "Kassenbeleg.png",
      predicted: null,
      exact: false,
      month: false,
    });
    expect(detectionRows.find(({ file }) => file === "08-de-inline-logo.eml")).toEqual({
      file: "08-de-inline-logo.eml",
      truePositives: ["Rechnung-RE-2026-1077.pdf"],
      falsePositives: [],
      falseNegatives: [],
    });
    const files = labels.intakes.map(({ file }) => file);
    expect(detectionRows.map(({ file }) => file)).toEqual(files);
    expect(model!.intakes.map(({ file }) => file)).toEqual(files);
    // Without price data: unpriced with the reason, and nothing excluded.
    expect(model).toMatchObject({
      pdfInput: null,
      priceEntry: null,
      cost: { status: "unpriced", reason: "price data unavailable: HTTP 503" },
    });
    expect(report.prices).toEqual({ url: PRICES_URL, error: "HTTP 503" });
    expect(report.excluded).toEqual([]);

    expect(await readdir(resultsRoot)).toEqual([folder.slice(resultsRoot.length + 1)]);
    expect(folder.slice(resultsRoot.length + 1)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_scripted-model$/,
    );
    const json = Schema.decodeUnknownSync(Report)(
      JSON.parse(await readFile(join(folder, "report.json"), "utf8")),
    );
    expect(json).toEqual(report);
    const markdown = await readFile(join(folder, "report.md"), "utf8");
    for (const line of [
      `- Price data: ${PRICES_URL} (unavailable: HTTP 503)`,
      "| scripted/model | 8/14 (57.1 %) | 9/14 (64.3 %) | 1 | unpriced | unpriced |",
      "- scripted/model: unpriced, price data unavailable: HTTP 503",
      "| Precision | 14/14 (100.0 %) |",
      "| Recall | 14/14 (100.0 %) |",
      "| Exact (year-month-day) | 8/14 (57.1 %) |",
      "| Month (year-month) | 9/14 (64.3 %) |",
      "| Failed | 1 |",
      "### 01-de-pdf-invoice.eml (scripted/model)",
      "| Rechnung-RE-2026-1042.pdf | 2026-11-02 | 2026-11-03 | no | yes |",
      "| scan-0001.pdf | 2026-08-07 | error: provider down | no | no |",
      "| Kostenvoranschlag.pdf | none | 2026-06-01 | no | no |",
      "- Detected and labelled: Rechnung-RE-2026-1077.pdf",
    ]) {
      expect(markdown).toContain(line);
    }
  });

  test("never overwrites an earlier run's folder", async () => {
    setSystemTime(new Date("2026-11-05T15:00:00.000Z"));
    const resultsRoot = newFolder("results");
    const options = { fixtures: syntheticFolder, resultsRoot };
    const first = await runOne(scriptedExtractor().layer, options);
    const second = await runOne(scriptedExtractor().layer, options);
    expect(first.folder).toBe(join(resultsRoot, "2026-11-05T15-00-00-000Z_scripted-model"));
    expect(second.folder).toBe(`${first.folder}-2`);
    const matrix = await runEval({
      ...options,
      models: ["scripted/a", "scripted/b"],
      dateExtractor: () => scriptedExtractor().layer,
      prices: noPrices,
    });
    expect(matrix.folder).toBe(join(resultsRoot, "2026-11-05T15-00-00-000Z_matrix"));
    expect(await readdir(resultsRoot)).toHaveLength(3);
  });
});

describe("runEval on a model matrix", () => {
  test("evaluates each model on the same Documents, prices each call, excludes a model without PDF input", async () => {
    const mini = scriptedExtractor({}, { delayMs: 5 });
    const haiku = scriptedExtractor(
      Object.fromEntries(
        labels.intakes.flatMap(({ documents }) =>
          documents.map(({ fileName, documentDate }) => [
            fileName,
            {
              answer: answer(documentDate),
              usage: {
                inputTokens: 1200,
                outputTokens: 80,
                cachedInputTokens: 1024,
                reasoningTokens: 64,
              },
            },
          ]),
        ),
      ),
    );
    const gemini = scriptedExtractor({
      "PP-3301.pdf": { answer: answer("2026-09-30") }, // answered without reported usage
      "scan-0001.pdf": new DateExtractionError({ message: "provider down" }),
    });
    const unknown = scriptedExtractor({ "Rechnung-RE-2026-1042.pdf": answer(null) });
    const textOnly = scriptedExtractor();
    const layers: Record<string, ReturnType<typeof scriptedExtractor>> = {
      "openai/gpt-5-mini": mini,
      "anthropic/claude-haiku-4-5": haiku,
      "google/gemini-2.5-flash": gemini,
      "openai/gpt-text-only": textOnly,
      "openai/gpt-unlisted": unknown,
    };
    const models = [
      "openai/gpt-5-mini",
      "openai/gpt-text-only",
      "anthropic/claude-haiku-4-5",
      "google/gemini-2.5-flash",
      "openai/gpt-unlisted",
    ] as const;
    const asked: string[] = [];
    const { report, folder } = await runEval({
      fixtures: syntheticFolder,
      models,
      dateExtractor: (model) => {
        asked.push(model);
        return layers[model]!.layer;
      },
      prices,
      resultsRoot: newFolder("results"),
    });

    // Excluded before any call; every other model saw the same 14 Documents, one at a time.
    expect(asked).not.toContain("openai/gpt-text-only");
    expect(textOnly.calls).toEqual([]);
    expect(report.excluded).toEqual([
      {
        model: "openai/gpt-text-only",
        reason: "no PDF input (LiteLLM entry gpt-text-only: supports_pdf_input false)",
      },
    ]);
    for (const { calls } of [mini, haiku, gemini, unknown]) expect(calls).toEqual(mini.calls);
    expect(mini.calls).toHaveLength(14);
    expect(report.models.map(({ model }) => model)).toEqual([
      "openai/gpt-5-mini",
      "anthropic/claude-haiku-4-5",
      "google/gemini-2.5-flash",
      "openai/gpt-unlisted",
    ]);
    // Detection once per run, not per model.
    expect(report.detection.truePositives).toBe(14);
    expect(report.models.every((model) => !("detection" in model))).toBe(true);

    const [miniReport, haikuReport, geminiReport, unknownReport] = report.models;
    // 1000 input tokens at $0.25/M and 50 output at $2/M per call, 14 calls.
    expect(miniReport).toMatchObject({
      pdfInput: true,
      priceEntry: "gpt-5-mini",
      extraction: { exact: { count: 14, total: 14 }, failed: 0 },
      tokens: { input: 14_000, output: 700, cachedInput: null, reasoning: null },
    });
    expect(miniReport!.cost).toEqual({ status: "priced", usd: expect.closeTo(14 * 3.5e-4, 12) });
    expect(miniReport!.costPerDocument).toEqual({
      status: "priced",
      usd: expect.closeTo(3.5e-4, 12),
    });
    // 176 uncached input tokens at $1/M, 1024 cached at $0.10/M, 80 output (64 reasoning) at $5/M.
    const haikuCall = 176e-6 + 1024e-7 + 80 * 5e-6;
    expect(haikuReport).toMatchObject({
      priceEntry: "claude-haiku-4-5",
      tokens: { input: 14 * 1200, output: 14 * 80, cachedInput: 14 * 1024, reasoning: 14 * 64 },
    });
    expect(haikuReport!.cost).toEqual({
      status: "priced",
      usd: expect.closeTo(14 * haikuCall, 12),
    });
    const haikuRow = haikuReport!.intakes[0]!.documents[0]!;
    expect(haikuRow).toMatchObject({ status: "answered", costUsd: expect.closeTo(haikuCall, 12) });
    // The Gemini API's entry, not Vertex AI's; PDF input unknown there, so it runs. A call
    // without reported usage leaves the whole model unpriced; a failed call is no answered call.
    expect(geminiReport).toMatchObject({
      pdfInput: null,
      priceEntry: "gemini/gemini-2.5-flash",
      extraction: { exact: { count: 13, total: 14 }, failed: 1 },
      cost: { status: "unpriced", reason: "1 answered call(s) reported no token usage" },
      costPerDocument: { status: "unpriced", reason: "1 answered call(s) reported no token usage" },
      tokens: { input: 12_000, output: 600 },
      latency: { calls: 14 },
    });
    expect(unknownReport).toMatchObject({
      pdfInput: null,
      priceEntry: null,
      extraction: { exact: { count: 13, total: 14 } },
      cost: {
        status: "unpriced",
        reason:
          "no LiteLLM entry (openai/gpt-unlisted or gpt-unlisted with litellm_provider openai)",
      },
    });
    // Latency of every call made, failed ones included; the scripted delay shows in it.
    for (const model of report.models) {
      for (const row of model.intakes.flatMap(({ documents }) => documents)) {
        if (row.status !== "not-sent") expect(row.latencyMs).toBeGreaterThanOrEqual(0);
      }
      expect(model.latency.calls).toBe(14);
      expect(model.latency.maxMs).toBeGreaterThanOrEqual(model.latency.medianMs!);
    }
    expect(miniReport!.latency.medianMs).toBeGreaterThanOrEqual(4);

    expect(folder).toEndWith("_matrix");
    expect(
      Schema.decodeUnknownSync(Report)(
        JSON.parse(await readFile(join(folder, "report.json"), "utf8")),
      ),
    ).toEqual(report);
    const markdown = await readFile(join(folder, "report.md"), "utf8");
    const table = markdown.slice(
      markdown.indexOf("## Models"),
      markdown.indexOf("## Document detection"),
    );
    expect(table).toContain(
      "| openai/gpt-5-mini | 14/14 (100.0 %) | 14/14 (100.0 %) | 0 | $0.004900 | $0.000350 |",
    );
    expect(table).toContain(" | yes |\n");
    expect(table).toContain(
      "| anthropic/claude-haiku-4-5 | 14/14 (100.0 %) | 14/14 (100.0 %) | 0 | $0.009498 | $0.000678 |",
    );
    expect(table).toContain(
      "| google/gemini-2.5-flash | 13/14 (92.9 %) | 13/14 (92.9 %) | 1 | unpriced | unpriced |",
    );
    expect(table).toMatch(/\| openai\/gpt-unlisted \| .* \| PDF input unknown \|\n/);
    expect(table).toContain(
      "- google/gemini-2.5-flash: unpriced, 1 answered call(s) reported no token usage",
    );
    expect(table).toContain(
      "- openai/gpt-text-only: no PDF input (LiteLLM entry gpt-text-only: supports_pdf_input false)",
    );
    expect(markdown).toContain("## Document dates by anthropic/claude-haiku-4-5");
    expect(markdown).toContain("| Tokens | 16800 in (14336 cached), 1120 out (896 reasoning) |");
    expect(markdown).toMatch(
      /\| Rechnung-RE-2026-1042\.pdf \| 2026-11-02 \| 2026-11-02 \| yes \| yes \| \d+ ms \| 1200 in \(1024 cached\), 80 out \(64 reasoning\) \| \$0\.000678 \|/,
    );
    expect(markdown).toContain("| PP-3301.pdf | 2026-09-30 | 2026-09-30 | yes | yes |");
    expect(markdown).toMatch(
      /\| PP-3301\.pdf \| 2026-09-30 \| 2026-09-30 \| yes \| yes \| \d+ ms \| not reported \| unpriced \|/,
    );
  });

  test("excludes every model without PDF input: no call, the reports list them", async () => {
    const { layer, calls } = scriptedExtractor();
    const { report, folder } = await runEval({
      fixtures: syntheticFolder,
      models: ["openai/gpt-text-only"],
      dateExtractor: () => layer,
      prices,
      resultsRoot: newFolder("results"),
    });
    expect(calls).toEqual([]);
    expect(report.models).toEqual([]);
    expect(report.excluded.map(({ model }) => model)).toEqual(["openai/gpt-text-only"]);
    expect(await readFile(join(folder, "report.md"), "utf8")).toContain(
      "- openai/gpt-text-only: no PDF input",
    );
  });
});

describe("runEval on edited labels", () => {
  test("counts false positives and false negatives; an unsendable labelled Document is not sent", async () => {
    const multiple = label("13-de-multiple-documents.eml");
    const fixtures = await fixtureFolder([
      {
        ...multiple,
        documents: [
          ...multiple.documents.filter(({ fileName }) => fileName !== "Kassenbeleg.png"),
          { fileName: "Hinweise.txt", documentDate: null },
        ],
      },
      { ...label("08-de-inline-logo.eml"), documents: [] },
      label("11-en-zero-documents-ics.eml"),
    ]);
    const { layer, calls } = scriptedExtractor();
    const { report } = await runOne(layer, { fixtures, resultsRoot: newFolder("results") });
    const { intakes: rows, ...detection } = report.detection;
    expect(detection).toEqual({
      truePositives: 2,
      falsePositives: 2,
      falseNegatives: 1,
      precision: { count: 2, total: 4, value: 0.5 },
      recall: { count: 2, total: 3, value: 2 / 3 },
    });
    expect(rows[0]).toEqual({
      file: "13-de-multiple-documents.eml",
      truePositives: ["Rechnung-RE-2026-0612.pdf", "Gutschrift-GS-2026-0031.pdf"],
      falsePositives: ["Kassenbeleg.png"],
      falseNegatives: ["Hinweise.txt"],
    });
    expect(rows[1]!.falsePositives).toEqual(["Rechnung-RE-2026-1077.pdf"]);
    // The undated .txt is never sent, so "no date" is right for it.
    expect(calls).toEqual(["Rechnung-RE-2026-0612.pdf", "Gutschrift-GS-2026-0031.pdf"]);
    const [model] = report.models;
    expect(model!.intakes[0]!.documents[2]).toEqual({
      fileName: "Hinweise.txt",
      expected: null,
      status: "not-sent",
      exact: true,
      month: true,
    });
    expect(model!.extraction).toEqual({
      exact: { count: 3, total: 3, value: 1 },
      month: { count: 3, total: 3, value: 1 },
      notSent: 1,
      failed: 0,
    });
    // A Document never sent takes no call, so no latency.
    expect(model!.latency.calls).toBe(2);
  });

  test("reports figures without a denominator as not applicable", async () => {
    const fixtures = await fixtureFolder([
      label("11-en-zero-documents-ics.eml"),
      label("12-de-zero-documents-plain.eml"),
    ]);
    const { report, folder } = await runOne(scriptedExtractor().layer, {
      fixtures,
      resultsRoot: newFolder("results"),
      prices,
      models: ["openai/gpt-5-mini"],
    });
    const none = { count: 0, total: 0, value: null };
    expect(report.detection.precision).toEqual(none);
    expect(report.detection.recall).toEqual(none);
    const [model] = report.models;
    expect(model!.extraction.exact).toEqual(none);
    expect(model!.extraction.month).toEqual(none);
    // No call: no latency, no tokens, and no cost: unpriced, never $0.
    expect(model!.latency).toEqual({ calls: 0, medianMs: null, maxMs: null });
    expect(model!.tokens).toBeNull();
    expect(model!.cost).toEqual({ status: "unpriced", reason: "no answered call" });
    expect(model!.costPerDocument).toEqual(model!.cost);
    const json = JSON.parse(await readFile(join(folder, "report.json"), "utf8"));
    expect(json.detection.precision.value).toBeNull();
    const markdown = await readFile(join(folder, "report.md"), "utf8");
    expect(markdown).toContain("| Precision | 0/0 (n/a) |");
    expect(markdown).toContain("| Exact (year-month-day) | 0/0 (n/a) |");
  });

  test("collects every fixture error, before any model call, writing nothing", async () => {
    const invoice = label("01-de-pdf-invoice.eml");
    const multiple = label("13-de-multiple-documents.eml");
    const fixtures = await fixtureFolder(
      [
        { ...invoice, documents: [{ fileName: "Missing.pdf", documentDate: "2026-11-02" }] },
        multiple,
        label("02-en-pdf-invoice.eml"),
      ],
      (file, mail) => {
        if (file === "02-en-pdf-invoice.eml") return undefined;
        // Two attachments named like the invoice.
        return mail.replaceAll("Gutschrift-GS-2026-0031.pdf", "Rechnung-RE-2026-0612.pdf");
      },
    );
    const { layer, calls } = scriptedExtractor();
    const resultsRoot = newFolder("results");
    const run = runOne(layer, { fixtures, resultsRoot });
    const message = await run.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    expect(message.split("\n")).toEqual([
      "fixture errors:",
      `${join(fixtures, "01-de-pdf-invoice.eml")}: expected.json labels "Missing.pdf", but the mail has no attachment of that name`,
      `${join(fixtures, "13-de-multiple-documents.eml")}: expected.json labels "Rechnung-RE-2026-0612.pdf", but the mail has 2 attachments of that name`,
      `${join(fixtures, "13-de-multiple-documents.eml")}: expected.json labels "Gutschrift-GS-2026-0031.pdf", but the mail has no attachment of that name`,
      expect.stringContaining(
        `ENOENT: no such file or directory, open '${join(fixtures, "02-en-pdf-invoice.eml")}'`,
      ),
    ]);
    expect(calls).toEqual([]);
    expect(await readdir(resultsRoot).catch(() => "missing")).toBe("missing");
  });

  test("labels a nameless attachment by the name hex files it under", async () => {
    const invoice = label("01-de-pdf-invoice.eml");
    const fixtures = await fixtureFolder(
      [{ ...invoice, documents: [{ fileName: "document-1.pdf", documentDate: "2026-11-02" }] }],
      (_, mail) => mail.replaceAll(/; (?:file)?name="Rechnung-RE-2026-1042\.pdf"/g, ""),
    );
    const { layer, calls } = scriptedExtractor({ "document-1.pdf": answer("2026-11-02") });
    const { report } = await runOne(layer, { fixtures, resultsRoot: newFolder("results") });
    expect(calls).toEqual(["document-1.pdf"]);
    expect(report.detection.intakes[0]!.truePositives).toEqual(["document-1.pdf"]);
    expect(report.models[0]!.intakes[0]!.documents[0]).toMatchObject({
      status: "answered",
      exact: true,
    });
  });

  test("a sent Document labelled undated is right when the model finds no date", async () => {
    const fixtures = await fixtureFolder([label("14-de-undated-document.eml")]);
    const { layer, calls } = scriptedExtractor({ "Kostenvoranschlag.pdf": answer(null) });
    const { report } = await runOne(layer, { fixtures, resultsRoot: newFolder("results") });
    expect(calls).toEqual(["Kostenvoranschlag.pdf"]);
    const [model] = report.models;
    expect(model!.intakes[0]!.documents).toEqual([
      {
        fileName: "Kostenvoranschlag.pdf",
        expected: null,
        status: "answered",
        predicted: null,
        exact: true,
        month: true,
        latencyMs: expect.any(Number),
        tokens: { input: 1000, output: 50, cachedInput: null, reasoning: null },
        costUsd: null,
      },
    ]);
    expect(model!.extraction.exact).toEqual({ count: 1, total: 1, value: 1 });
    expect(model!.extraction.month).toEqual({ count: 1, total: 1, value: 1 });
  });

  test("fails before any model call when the results folder can't be created", async () => {
    const resultsRoot = newFolder("results-file");
    await writeFile(resultsRoot, "not a folder");
    const { layer, calls } = scriptedExtractor();
    const run = runOne(layer, { fixtures: syntheticFolder, resultsRoot });
    await expect(run).rejects.toThrow(
      `the results folder ${resultsRoot} can't be written to (EEXIST`,
    );
    expect(calls).toEqual([]);
    expect(await readFile(resultsRoot, "utf8")).toBe("not a folder");
  });

  // Root ignores permission bits.
  test.skipIf(process.getuid?.() === 0)(
    "fails before any model call when the results folder is read-only",
    async () => {
      const resultsRoot = newFolder("results-read-only");
      await mkdir(resultsRoot, { mode: 0o555 });
      const { layer, calls } = scriptedExtractor();
      const run = runOne(layer, { fixtures: syntheticFolder, resultsRoot });
      await expect(run).rejects.toThrow(
        `the results folder ${resultsRoot} can't be written to (EACCES`,
      );
      expect(calls).toEqual([]);
      expect(await readdir(resultsRoot)).toEqual([]);
    },
  );

  test("refuses a results folder inside the fixture folder", async () => {
    const fixtures = await fixtureFolder([label("11-en-zero-documents-ics.eml")]);
    const run = runOne(scriptedExtractor().layer, {
      fixtures,
      resultsRoot: join(fixtures, "eval-results"),
    });
    await expect(run).rejects.toThrow("must not lie in the fixture folder");
    expect((await readdir(fixtures)).sort()).toEqual([
      "11-en-zero-documents-ics.eml",
      "expected.json",
    ]);
  });
});
