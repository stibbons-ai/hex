// Walkthrough: Daniel runs `bun run eval` by hand and reads the summary and both reports; the model
// is a fake OpenAI on loopback that answers 2 November 2026 for every Document, and LiteLLM's
// price data comes from a loopback server.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Schema } from "effect";
import { fakeOpenAI } from "../../server/test/fake-openai.ts";
import type { FakeOpenAI } from "../../server/test/fake-openai.ts";
import { Report } from "../src/index.ts";
import { syntheticFolder } from "../src/synthetic/generate.ts";
import { fakePrices } from "./fake-prices.ts";
import type { FakePrices } from "./fake-prices.ts";
import { repoRoot } from "./paths.ts";

const NOVEMBER_2 = '{"year":2026,"month":11,"day":2}';
const model = fakeOpenAI(() => NOVEMBER_2);
/** $1 per million input tokens, $2 per million output tokens; the fake reports 1 and 1 per call. */
const openaiEntry = {
  litellm_provider: "openai",
  input_cost_per_token: 1e-6,
  output_cost_per_token: 2e-6,
  supports_pdf_input: true,
};
const prices = fakePrices({
  "gpt-5.4-mini": openaiEntry,
  "gpt-5.4-nano": { ...openaiEntry, supports_pdf_input: undefined },
  "gpt-4o-mini-tts": { litellm_provider: "openai", supports_pdf_input: false },
  "claude-haiku-5-5": { ...openaiEntry, litellm_provider: "anthropic" },
});
let directory: string;
let fixtures: string;
/**
 * A config file naming `openai/gpt-5.4-mini` as `intake.model`, so a run without `eval.models`
 * reaches the fake OpenAI (the default model is Anthropic's).
 */
let intakeModelConfig: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-eval-command-"));
  fixtures = join(directory, "fixtures");
  await cp(syntheticFolder, fixtures, { recursive: true });
  intakeModelConfig = join(directory, "intake-model.json");
  await writeFile(intakeModelConfig, JSON.stringify({ intake: { model: "openai/gpt-5.4-mini" } }));
});

afterAll(async () => {
  await model.server.stop(true);
  await prices.server.stop(true);
  await rm(directory, { recursive: true, force: true });
});

let runs = 0;

/**
 * `bun run eval` from `cwd` (default the repository root), as from a person's shell: `CI`,
 * `INIT_CWD` and `npm_config_local_prefix` are removed from the inherited environment (an outer
 * `bun run test` sets the last, and Bun 1.4.2 keeps an inherited one instead of the caller's
 * directory). `HEX_CONFIG` {@link intakeModelConfig}, `HEX_EVAL_FIXTURES` blank, `HEX_EVAL_RESULTS`
 * a fresh temp folder and `HEX_EVAL_PRICES_URL` the loopback price data unless `env` sets them.
 */
async function evalCommand(
  env: Record<string, string>,
  {
    openai = model,
    cwd = repoRoot,
    priceData = prices,
  }: { openai?: FakeOpenAI; cwd?: string; priceData?: FakePrices } = {},
) {
  const { CI: _, INIT_CWD: __, npm_config_local_prefix: ___, ...inherited } = process.env;
  const results = join(directory, `results-${++runs}`);
  const child = Bun.spawn(["bun", "run", "--silent", "eval"], {
    cwd,
    env: {
      ...inherited,
      HEX_CONFIG: intakeModelConfig,
      HEX_EVAL_FIXTURES: "",
      HEX_EVAL_RESULTS: results,
      HEX_EVAL_PRICES_URL: priceData.url,
      OPENAI_BASE_URL: openai.baseUrl,
      OPENAI_API_KEY: "sk-hex-eval-walkthrough-0123456789",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code, results };
}

/** The single run folder under `results` and its decoded `report.json`. */
async function onlyReport(results: string) {
  const [run] = await readdir(results);
  expect(await readdir(results)).toHaveLength(1);
  const folder = join(results, run!);
  const report = Schema.decodeUnknownSync(Report)(
    JSON.parse(await readFile(join(folder, "report.json"), "utf8")),
  );
  return { folder, report };
}

/** Every file of `folder` with its bytes, base64. */
async function snapshot(folder: string) {
  const files = (await readdir(folder)).sort();
  return Promise.all(
    files.map(async (file) => [file, (await readFile(join(folder, file))).toString("base64")]),
  );
}

describe("bun run eval", () => {
  test("evaluates intake.model on the fixture folder, prints the figures and writes both reports", async () => {
    const before = await snapshot(fixtures);
    const requests = model.requests.length;
    const fetches = prices.fetches;
    const { stdout, stderr, code, results } = await evalCommand({ HEX_EVAL_FIXTURES: fixtures });
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const { folder, report } = await onlyReport(results);
    const latency = /latency median \d+ ms, max \d+ ms/g;
    expect(stdout.match(latency)).toHaveLength(1);
    expect(stdout.replace(latency, "latency median <n> ms, max <n> ms")).toBe(
      [
        `hex eval: openai/gpt-5.4-mini on ${fixtures}`,
        `  Price data: ${prices.url}`,
        "  Document detection: precision 14/14 (100.0 %), recall 14/14 (100.0 %)",
        "  Document date:",
        "  openai/gpt-5.4-mini: exact 2/14 (14.3 %), month 2/14 (14.3 %); not sent 0, failed 0; cost $0.000042; latency median <n> ms, max <n> ms",
        `  Reports: ${join(folder, "report.md")}`,
        `           ${join(folder, "report.json")}`,
        "",
      ].join("\n"),
    );
    expect(model.requests.length - requests).toBe(14);
    expect(prices.fetches - fetches).toBe(1);
    expect(model.requests.at(-1)!.model).toBe("gpt-5.4-mini");
    expect(folder).toEndWith("_openai-gpt-5.4-mini");
    expect(report).toMatchObject({ fixtures, prices: { url: prices.url, error: null } });
    expect(report.models[0]).toMatchObject({
      model: "openai/gpt-5.4-mini",
      pdfInput: true,
      tokens: { input: 14, output: 14 },
      cost: { status: "priced", usd: expect.closeTo(14 * 3e-6, 12) },
    });
    const markdown = await readFile(join(folder, "report.md"), "utf8");
    expect(markdown).toContain(
      "| openai/gpt-5.4-mini | 2/14 (14.3 %) | 2/14 (14.3 %) | 0 | $0.000042 | $0.000003 |",
    );
    expect(markdown).toMatch(
      /\| Rechnung-RE-2026-1042\.pdf \| 2026-11-02 \| 2026-11-02 \| yes \| yes \| \d+ ms \| 1 in \(0 cached\), 1 out \(0 reasoning\) \| \$0\.000003 \|/,
    );
    expect(await snapshot(fixtures)).toEqual(before);
  });

  test("without HEX_CONFIG evaluates the default model, anthropic/claude-haiku-5-5", async () => {
    const requests = model.requests.length;
    // No Anthropic key and a base URL nobody listens on: each call fails, none leaves the machine.
    const { stdout, code, results } = await evalCommand({
      HEX_CONFIG: "",
      HEX_EVAL_FIXTURES: fixtures,
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9/v1",
    });
    expect(code).toBe(1);
    expect(stdout).toStartWith(`hex eval: anthropic/claude-haiku-5-5 on ${fixtures}\n`);
    expect(model.requests.length).toBe(requests);
    const { folder, report } = await onlyReport(results);
    expect(folder).toEndWith("_anthropic-claude-haiku-5-5");
    expect(report.models[0]).toMatchObject({
      model: "anthropic/claude-haiku-5-5",
      priceEntry: "claude-haiku-5-5",
      extraction: { failed: 14 },
    });
  });

  test("compares the models HEX_CONFIG lists: one line each, price data fetched once", async () => {
    const config = join(directory, "matrix.json");
    await writeFile(
      config,
      JSON.stringify({
        eval: { models: ["openai/gpt-5.4-mini", "openai/gpt-4o-mini-tts", "openai/gpt-5.4-nano"] },
      }),
    );
    const requests = model.requests.length;
    const fetches = prices.fetches;
    const { stdout, stderr, code, results } = await evalCommand({
      HEX_CONFIG: config,
      HEX_EVAL_FIXTURES: fixtures,
    });
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(prices.fetches - fetches).toBe(1);
    // 14 calls per included model; none for the model without PDF input.
    const asked = model.requests.slice(requests).map(({ model: id }) => id);
    expect(asked).toEqual([...Array(14).fill("gpt-5.4-mini"), ...Array(14).fill("gpt-5.4-nano")]);
    const lines = stdout.split("\n");
    expect(lines[0]).toBe(`hex eval: 3 models on ${fixtures}`);
    expect(lines.filter((line) => line.startsWith("  openai/"))).toEqual([
      expect.stringMatching(
        /^ {2}openai\/gpt-5\.4-mini: exact 2\/14 \(14\.3 %\), .*; cost \$0\.000042; latency median \d+ ms, max \d+ ms$/,
      ),
      expect.stringMatching(
        /^ {2}openai\/gpt-5\.4-nano: exact 2\/14 \(14\.3 %\), .*; cost \$0\.000042; latency/,
      ),
      "  openai/gpt-4o-mini-tts: excluded, no PDF input (LiteLLM entry gpt-4o-mini-tts: supports_pdf_input false)",
    ]);
    const { folder, report } = await onlyReport(results);
    expect(folder).toEndWith("_matrix");
    expect(report.models.map(({ model: id, pdfInput }) => [id, pdfInput])).toEqual([
      ["openai/gpt-5.4-mini", true],
      ["openai/gpt-5.4-nano", null],
    ]);
    const markdown = await readFile(join(folder, "report.md"), "utf8");
    const table = markdown.slice(
      markdown.indexOf("## Models"),
      markdown.indexOf("## Document detection"),
    );
    expect(table).toContain(
      "| openai/gpt-5.4-mini | 2/14 (14.3 %) | 2/14 (14.3 %) | 0 | $0.000042 |",
    );
    expect(table).toMatch(/\| openai\/gpt-5\.4-nano \| .* \| PDF input unknown \|/);
    expect(table).toContain("- openai/gpt-4o-mini-tts: no PDF input");
    expect(markdown).toContain("## Document dates by openai/gpt-5.4-nano");
  });

  test("without price data the run goes on, every model unpriced", async () => {
    const down = fakePrices("unavailable", 503);
    try {
      const { stdout, code, results } = await evalCommand(
        { HEX_EVAL_FIXTURES: fixtures },
        { priceData: down },
      );
      expect(code).toBe(0);
      expect(down.fetches).toBe(1);
      expect(stdout).toContain(
        `  Price data: ${down.url} unavailable (HTTP 503); every model unpriced\n`,
      );
      expect(stdout).toContain("; unpriced (price data unavailable: HTTP 503); latency median");
      const { folder, report } = await onlyReport(results);
      expect(report.models[0]!.cost).toEqual({
        status: "unpriced",
        reason: "price data unavailable: HTTP 503",
      });
      expect(await readFile(join(folder, "report.md"), "utf8")).toContain(
        "| 2/14 (14.3 %) | 2/14 (14.3 %) | 0 | unpriced | unpriced |",
      );
    } finally {
      await down.server.stop(true);
    }
  });

  test("uses the committed synthetic set without HEX_EVAL_FIXTURES", async () => {
    const { code, results } = await evalCommand({});
    expect(code).toBe(0);
    expect((await onlyReport(results)).report.fixtures).toBe(syntheticFolder);
  });

  test("refuses to run under CI: no model call, nothing written", async () => {
    const requests = model.requests.length;
    const { stdout, stderr, code, results } = await evalCommand({
      CI: "true",
      HEX_EVAL_FIXTURES: fixtures,
    });
    expect({ code, stdout }).toEqual({ code: 1, stdout: "" });
    expect(stderr).toBe("hex eval: CI is set; evals run only by hand, with real API keys\n");
    expect(model.requests.length).toBe(requests);
    expect(await readdir(results).catch(() => "missing")).toBe("missing");
  });

  test("resolves relative HEX_EVAL_FIXTURES and HEX_EVAL_RESULTS against the caller's directory", async () => {
    const caller = join(repoRoot, "docs");
    // Inside the repo and only read: resolved from the repo root instead, it names no folder.
    const fixturesFromCaller = "../packages/eval-harness/fixtures/synthetic";
    // A relative path to a temp folder climbs past `/`, so it resolves the same from any repo
    // folder; telling this half apart would mean writing into the repo.
    const results = join(directory, "results-relative");
    const { code, stdout } = await evalCommand(
      { HEX_EVAL_FIXTURES: fixturesFromCaller, HEX_EVAL_RESULTS: relative(caller, results) },
      { cwd: caller },
    );
    expect(code).toBe(0);
    const { folder, report } = await onlyReport(results);
    expect(report.fixtures).toBe(syntheticFolder);
    expect(stdout).toContain(`on ${syntheticFolder}\n`);
    expect(stdout).toContain(join(folder, "report.json"));
  });

  test("fails on a fixture error: exit 1, no model call, nothing written", async () => {
    const broken = join(directory, "broken");
    await mkdir(broken);
    await copyFile(join(fixtures, "01-de-pdf-invoice.eml"), join(broken, "01-de-pdf-invoice.eml"));
    await writeFile(
      join(broken, "expected.json"),
      JSON.stringify({
        intakes: [
          {
            file: "01-de-pdf-invoice.eml",
            documents: [{ fileName: "Missing.pdf", documentDate: null }],
          },
        ],
      }),
    );
    const requests = model.requests.length;
    const { stdout, stderr, code, results } = await evalCommand({ HEX_EVAL_FIXTURES: broken });
    expect({ code, stdout }).toEqual({ code: 1, stdout: "" });
    expect(stderr).toBe(
      `hex eval: fixture errors:\n${join(broken, "01-de-pdf-invoice.eml")}: expected.json labels "Missing.pdf", but the mail has no attachment of that name\n`,
    );
    expect(model.requests.length).toBe(requests);
    expect(await readdir(results).catch(() => "missing")).toBe("missing");
  });

  test("records a failed model call, writes the reports and exits 1", async () => {
    let calls = 0;
    const failing = fakeOpenAI(() =>
      ++calls === 1 ? { status: 400, message: "file rejected" } : NOVEMBER_2,
    );
    try {
      const { stderr, code, results } = await evalCommand(
        { HEX_EVAL_FIXTURES: fixtures },
        { openai: failing },
      );
      expect(code).toBe(1);
      expect(stderr).toBe("hex eval: 1 model call(s) failed; see the report\n");
      const { folder, report } = await onlyReport(results);
      expect(report.models[0]!.extraction.failed).toBe(1);
      expect(report.models[0]!.intakes[0]!.documents[0]).toMatchObject({
        fileName: "Rechnung-RE-2026-1042.pdf",
        status: "failed",
        exact: false,
      });
      expect(await readFile(join(folder, "report.md"), "utf8")).toContain(
        "(HTTP 400): file rejected",
      );
    } finally {
      await failing.server.stop(true);
    }
  });

  test("a failed call of one of several models exits 1 after writing both reports", async () => {
    const config = join(directory, "one-fails.json");
    await writeFile(
      config,
      JSON.stringify({ eval: { models: ["openai/gpt-5.4-mini", "openai/gpt-5.4-nano"] } }),
    );
    // The third gpt-5.4-nano call is refused; every other call answers.
    let nanoCalls = 0;
    const failing = fakeOpenAI((request) =>
      request.model === "gpt-5.4-nano" && ++nanoCalls === 3
        ? { status: 400, message: "file rejected" }
        : NOVEMBER_2,
    );
    try {
      const { stdout, stderr, code, results } = await evalCommand(
        { HEX_CONFIG: config, HEX_EVAL_FIXTURES: fixtures },
        { openai: failing },
      );
      expect(code).toBe(1);
      expect(stderr).toBe("hex eval: 1 model call(s) failed; see the report\n");
      expect(stdout).toContain("  openai/gpt-5.4-mini: exact 2/14 (14.3 %)");
      expect(stdout).toContain("; not sent 0, failed 1;");
      const { folder, report } = await onlyReport(results);
      expect(report.models.map(({ extraction }) => extraction.failed)).toEqual([0, 1]);
      expect((await readdir(folder)).sort()).toEqual(["report.json", "report.md"]);
    } finally {
      await failing.server.stop(true);
    }
  });

  test("every configured model excluded: no call, both reports, exit 1", async () => {
    const config = join(directory, "all-excluded.json");
    await writeFile(config, JSON.stringify({ eval: { models: ["openai/gpt-4o-mini-tts"] } }));
    const requests = model.requests.length;
    const { stdout, stderr, code, results } = await evalCommand({
      HEX_CONFIG: config,
      HEX_EVAL_FIXTURES: fixtures,
    });
    expect(code).toBe(1);
    expect(stderr).toBe("hex eval: every configured model was excluded; see the report\n");
    expect(stdout).toContain(
      "  openai/gpt-4o-mini-tts: excluded, no PDF input (LiteLLM entry gpt-4o-mini-tts: supports_pdf_input false)\n",
    );
    expect(model.requests.length).toBe(requests);
    const { folder, report } = await onlyReport(results);
    expect(report.models).toEqual([]);
    expect((await readdir(folder)).sort()).toEqual(["report.json", "report.md"]);
  });
});
