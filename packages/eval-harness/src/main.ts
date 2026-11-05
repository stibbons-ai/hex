/**
 * `bun run eval`: runs the eval by hand, with the models `HEX_CONFIG` lists (`eval.models`, else
 * `intake.model`; each API key from the provider's usual variable), on the fixture folder
 * `HEX_EVAL_FIXTURES` (default: the committed synthetic set), and writes its reports under
 * `HEX_EVAL_RESULTS` (default: `<repo>/eval-results/`). LiteLLM's price data is fetched once per
 * run from `HEX_EVAL_PRICES_URL` (default: LiteLLM's file on GitHub). Relative paths resolve
 * against the directory you ran it from, as for `fixtures:generate`. Refuses to run when `CI` is
 * set to a non-empty value: evals cost real model calls. Exits 1 under `CI`, on a config or
 * fixture error or a results folder that can't be written to (all before any model call), and,
 * after writing the reports, when a model call failed or no model was left to evaluate.
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dateExtractorLayer, messageOf } from "@hex/adapters";
import { loadEvalConfig } from "@hex/server";
import { LITELLM_PRICES_URL, fetchPriceData } from "./prices.ts";
import { formatMs, formatRatio, formatUsd } from "./report.ts";
import type { ModelReport } from "./report.ts";
import { runEval } from "./run.ts";
import { syntheticFolder } from "./synthetic/generate.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

/** One model's summary line. */
function modelLine({ model, extraction, cost, latency }: ModelReport): string {
  const costText =
    cost.status === "priced" ? `cost ${formatUsd(cost.usd)}` : `unpriced (${cost.reason})`;
  const latencyText =
    latency.medianMs === null || latency.maxMs === null
      ? "no calls"
      : `latency median ${formatMs(latency.medianMs)}, max ${formatMs(latency.maxMs)}`;
  return `  ${model}: exact ${formatRatio(extraction.exact)}, month ${formatRatio(extraction.month)}; not sent ${extraction.notSent}, failed ${extraction.failed}; ${costText}; ${latencyText}`;
}

async function main(): Promise<number> {
  const { npm_lifecycle_event, INIT_CWD, npm_config_local_prefix, CI } = process.env;
  if (CI) {
    console.error("hex eval: CI is set; evals run only by hand, with real API keys");
    return 1;
  }
  const callerDirectory =
    npm_lifecycle_event === "eval"
      ? (INIT_CWD ?? npm_config_local_prefix ?? process.cwd())
      : process.cwd();
  const fromCaller = (path: string | undefined) =>
    path ? resolve(callerDirectory, path) : undefined;
  const fixtures = fromCaller(process.env.HEX_EVAL_FIXTURES) ?? syntheticFolder;
  const resultsRoot = fromCaller(process.env.HEX_EVAL_RESULTS) ?? join(repoRoot, "eval-results");
  const { models } = await loadEvalConfig(fromCaller(process.env.HEX_CONFIG));
  const prices = await fetchPriceData(process.env.HEX_EVAL_PRICES_URL || LITELLM_PRICES_URL);
  const { report, folder } = await runEval({
    fixtures,
    models,
    dateExtractor: dateExtractorLayer,
    prices,
    resultsRoot,
  });
  const { detection } = report;
  console.log(
    [
      `hex eval: ${models.length === 1 ? models[0] : `${models.length} models`} on ${fixtures}`,
      `  Price data: ${prices.url}${prices.status === "unavailable" ? ` unavailable (${prices.error}); every model unpriced` : ""}`,
      `  Document detection: precision ${formatRatio(detection.precision)}, recall ${formatRatio(detection.recall)}`,
      "  Document date:",
      ...report.models.map(modelLine),
      ...report.excluded.map(({ model, reason }) => `  ${model}: excluded, ${reason}`),
      `  Reports: ${join(folder, "report.md")}`,
      `           ${join(folder, "report.json")}`,
    ].join("\n"),
  );
  if (report.models.length === 0) {
    console.error("hex eval: every configured model was excluded; see the report");
    return 1;
  }
  const failed = report.models.reduce((sum, { extraction }) => sum + extraction.failed, 0);
  if (failed === 0) return 0;
  console.error(`hex eval: ${failed} model call(s) failed; see the report`);
  return 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`hex eval: ${messageOf(error)}`);
  process.exitCode = 1;
}
