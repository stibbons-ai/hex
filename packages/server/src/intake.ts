// Dev command: `bun run intake <path.eml>` runs the Intake workflow once, in process, on one
// `.eml` against the configured data directory and Outbox, forwarding its Documents to the
// configured targets, and prints what it did.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dateExtractorLayer, messageOf, readEml, smtpMailerLayer } from "@hex/adapters";
import { Effect } from "effect";
import { loadForwardingConfig, loadIntakeConfig } from "./config";
import { IntakeRunError, runIntake } from "./intake-workflow";
import type { ForwardingAttempt, IntakeResult } from "./intake-workflow";
import { dataPaths } from "./paths";

/** One target's Forwarding as Daniel reads it. */
function describeForwarding(attempt: ForwardingAttempt): string {
  switch (attempt.status) {
    case "forwarded":
      return `  forwarded to ${attempt.target}`;
    case "forwarded-earlier":
      return `  already forwarded to ${attempt.target} earlier`;
    case "failed":
      return `  forwarding to ${attempt.target} failed: ${attempt.reason}`;
  }
}

/**
 * The outcome as Daniel reads it: where each Document went, marking those filed by the received
 * date because no Document date was found, or why nothing was filed; then each target's
 * Forwarding.
 */
function describe(
  { messageId, status, filings, forwardings }: IntakeResult,
  outboxDirectory: string,
): string {
  const filed =
    status === "already-processed"
      ? [`hex intake: ${messageId} was already processed; nothing filed`]
      : filings.length === 0
        ? [`hex intake: ${messageId} has no Documents; nothing filed`]
        : [
            `hex intake: ${messageId}: filed ${filings.length === 1 ? "1 Document" : `${filings.length} Documents`} into ${outboxDirectory}`,
            ...filings.map(
              ({ path, fellBack }) =>
                `  ${path}${fellBack ? " (no usable Document date; filed by received date)" : ""}`,
            ),
          ];
  return [...filed, ...forwardings.map(describeForwarding)].join("\n");
}

async function main(argv: readonly string[]): Promise<string> {
  if (argv.length !== 1 || !argv[0]) throw new Error("usage: bun run intake <path.eml>");
  const source = resolve(argv[0]);
  const bytes = await readFile(source).catch((error: unknown) => {
    throw new Error(`cannot read ${source} (${messageOf(error)})`, { cause: error });
  });
  const intake = await Effect.runPromise(readEml(bytes, source));
  const configPath = process.env.HEX_CONFIG ? resolve(process.env.HEX_CONFIG) : undefined;
  const { category, model } = await loadIntakeConfig(configPath);
  const forwarding = await loadForwardingConfig(configPath, process.env);
  const paths = dataPaths(process.env);
  const result = await runIntake(intake, {
    paths,
    category,
    dateExtractor: dateExtractorLayer(model),
    mailer: forwarding && smtpMailerLayer(forwarding.smtp),
    forwarding,
  });
  return describe(result, paths.outboxDirectory);
}

try {
  console.log(await main(process.argv.slice(2)));
} catch (error) {
  // The targets that got the Documents although another branch failed, and those that failed.
  if (error instanceof IntakeRunError && error.forwardings.length > 0) {
    console.log(error.forwardings.map(describeForwarding).join("\n"));
  }
  console.error(`hex intake: ${messageOf(error)}`);
  process.exitCode = 1;
}
