// Dev command: `bun run intake <path.eml>` runs the Intake workflow once, in process, on one
// `.eml` against the configured data directory and Outbox, and prints what it did.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createLocalStore, readEml } from "@hex/adapters";
import { Mastra } from "@mastra/core/mastra";
import { Effect } from "effect";
import { closeInOrder } from "./close";
import { loadIntakeConfig } from "./config";
import { INTAKE_WORKFLOW_ID, createIntakeRuntime, createIntakeWorkflow } from "./intake-workflow";
import type { IntakeResult } from "./intake-workflow";
import { dataPaths } from "./paths";

/** The outcome as Daniel reads it: where each Document went, or why nothing was filed. */
function describe(result: IntakeResult, outboxDirectory: string): string {
  const { messageId, status, filings } = result;
  if (status === "already-processed") {
    return `hex intake: ${messageId} was already processed; nothing filed`;
  }
  if (filings.length === 0) return `hex intake: ${messageId} has no Documents; nothing filed`;
  const count = filings.length === 1 ? "1 Document" : `${filings.length} Documents`;
  return [
    `hex intake: ${messageId}: filed ${count} into ${outboxDirectory}`,
    ...filings.map(({ path }) => `  ${path}`),
  ].join("\n");
}

async function main(argv: readonly string[]): Promise<string> {
  if (argv.length !== 1 || !argv[0]) throw new Error("usage: bun run intake <path.eml>");
  const source = resolve(argv[0]);
  const bytes = await readFile(source).catch((error: unknown) => {
    throw new Error(`cannot read ${source} (${(error as Error).message})`, { cause: error });
  });
  const intake = await Effect.runPromise(readEml(bytes, source));
  const configPath = process.env.HEX_CONFIG;
  const { category } = await loadIntakeConfig(configPath ? resolve(configPath) : undefined);
  const paths = dataPaths(process.env);
  const storage = await createLocalStore(paths.databasePath);
  const runtime = createIntakeRuntime(paths);
  const mastra = new Mastra({
    storage,
    logger: false,
    workflows: { [INTAKE_WORKFLOW_ID]: createIntakeWorkflow({ runtime, category }) },
  });
  try {
    await storage.init();
    const run = await mastra.getWorkflow(INTAKE_WORKFLOW_ID).createRun();
    const result = await run.start({ inputData: intake });
    if (result.status !== "success") {
      const reason = result.status === "failed" ? result.error.message : result.status;
      throw new Error(`the Intake workflow did not finish: ${reason}`);
    }
    return describe(result.result, paths.outboxDirectory);
  } finally {
    await closeInOrder([() => mastra.shutdown(), () => storage.close(), () => runtime.dispose()]);
  }
}

try {
  console.log(await main(process.argv.slice(2)));
} catch (error) {
  console.error(`hex intake: ${(error as Error).message}`);
  process.exitCode = 1;
}
