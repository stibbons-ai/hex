// Dev command: `bun run intake <path.eml>` runs the Intake workflow once, in process, on one
// `.eml` against the configured data directory and Outbox, and prints what it did.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dateExtractorLayer, messageOf, readEml } from "@hex/adapters";
import { Effect } from "effect";
import { loadIntakeConfig } from "./config";
import { runIntake } from "./intake-workflow";
import type { IntakeResult } from "./intake-workflow";
import { dataPaths } from "./paths";

/**
 * The outcome as Daniel reads it: where each Document went, marking those filed by the received
 * date because no Document date was found, or why nothing was filed.
 */
function describe({ messageId, status, filings }: IntakeResult, outboxDirectory: string): string {
  if (status === "already-processed") {
    return `hex intake: ${messageId} was already processed; nothing filed`;
  }
  if (filings.length === 0) return `hex intake: ${messageId} has no Documents; nothing filed`;
  const count = filings.length === 1 ? "1 Document" : `${filings.length} Documents`;
  return [
    `hex intake: ${messageId}: filed ${count} into ${outboxDirectory}`,
    ...filings.map(({ path, fellBack }) =>
      fellBack ? `  ${path} (no Document date found; filed by received date)` : `  ${path}`,
    ),
  ].join("\n");
}

async function main(argv: readonly string[]): Promise<string> {
  if (argv.length !== 1 || !argv[0]) throw new Error("usage: bun run intake <path.eml>");
  const source = resolve(argv[0]);
  const bytes = await readFile(source).catch((error: unknown) => {
    throw new Error(`cannot read ${source} (${messageOf(error)})`, { cause: error });
  });
  const intake = await Effect.runPromise(readEml(bytes, source));
  const configPath = process.env.HEX_CONFIG;
  const { category, model } = await loadIntakeConfig(configPath ? resolve(configPath) : undefined);
  const paths = dataPaths(process.env);
  const dateExtractor = dateExtractorLayer(model);
  const result = await runIntake(intake, { paths, category, dateExtractor });
  return describe(result, paths.outboxDirectory);
}

try {
  console.log(await main(process.argv.slice(2)));
} catch (error) {
  console.error(`hex intake: ${messageOf(error)}`);
  process.exitCode = 1;
}
