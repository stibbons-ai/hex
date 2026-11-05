/**
 * `bun run eval`: runs the eval by hand, with the model hex uses (`HEX_CONFIG`, its API key from
 * the provider's usual variable), on the fixture folder `HEX_EVAL_FIXTURES` (default: the
 * committed synthetic set), and writes its reports under `HEX_EVAL_RESULTS` (default:
 * `<repo>/eval-results/`). Relative paths resolve against the directory you ran it from, as for
 * `fixtures:generate`. Refuses to run when `CI` is set to a non-empty value: evals cost real model
 * calls. Exits 1 under `CI`, on a config or fixture error (before any model call), and when a
 * model call failed (after writing the reports).
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dateExtractorLayer, messageOf } from "@hex/adapters";
import { loadIntakeConfig } from "@hex/server";
import { formatRatio } from "./report.ts";
import { runEval } from "./run.ts";
import { syntheticFolder } from "./synthetic/generate.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

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
  const { model } = await loadIntakeConfig(fromCaller(process.env.HEX_CONFIG));
  const { report, folder } = await runEval({
    fixtures,
    model,
    dateExtractor: dateExtractorLayer(model),
    resultsRoot,
  });
  const { detection, extraction } = report;
  console.log(
    [
      `hex eval: ${model} on ${fixtures}`,
      `  Document detection: precision ${formatRatio(detection.precision)}, recall ${formatRatio(detection.recall)}`,
      `  Document date: exact ${formatRatio(extraction.exact)}, month ${formatRatio(extraction.month)}; not sent ${extraction.notSent}, failed ${extraction.failed}`,
      `  Reports: ${join(folder, "report.md")}`,
      `           ${join(folder, "report.json")}`,
    ].join("\n"),
  );
  if (extraction.failed === 0) return 0;
  console.error(`hex eval: ${extraction.failed} model call(s) failed; see the report`);
  return 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`hex eval: ${messageOf(error)}`);
  process.exitCode = 1;
}
