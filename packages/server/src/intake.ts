// Dev command: `bun run intake <path.eml>` runs the Intake workflow once, in process, on one
// `.eml` against the configured data directory and Outbox, forwarding its Documents to the
// configured targets, and prints what it did.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dateExtractorLayer, messageOf, readEml, smtpMailerLayer } from "@hex/adapters";
import { normalizeMessageId } from "@hex/domain";
import { Effect } from "effect";
import { loadForwardingConfig, loadIntakeConfig } from "./config";
import { IntakeRunError, runIntake } from "./intake-workflow";
import type { IntakeResult } from "./intake-workflow";
import { dataPaths } from "./paths";

/**
 * The Filings as Daniel reads them: where each Document went, marking those filed by the
 * received date because no Document date was found.
 */
function describeFilings(
  messageId: string,
  filings: readonly { readonly path: string; readonly fellBack?: boolean }[],
  outboxDirectory: string,
): string[] {
  const count = filings.length === 1 ? "1 Document" : `${filings.length} Documents`;
  return [
    `hex intake: ${messageId}: filed ${count} into ${outboxDirectory}`,
    ...filings.map(
      ({ path, fellBack }) =>
        `  ${path}${fellBack ? " (no usable Document date; filed by received date)" : ""}`,
    ),
  ];
}

/** A target's Forwarding that succeeded, by this run or an earlier one. */
const describeForwarding = ({ target, status }: IntakeResult["forwardings"][number]) =>
  status === "forwarded" ? `  forwarded to ${target}` : `  already forwarded to ${target} earlier`;

/** The outcome as Daniel reads it: the Filings, or why nothing was filed; then each Forwarding. */
function describe(
  { messageId, status, filings, forwardings }: IntakeResult,
  outboxDirectory: string,
): string {
  let filed: string[];
  if (status === "already-processed") {
    filed = [`hex intake: ${messageId} was already processed; nothing filed`];
  } else if (filings.length === 0) {
    filed = [`hex intake: ${messageId} has no Documents; nothing filed`];
  } else {
    filed = describeFilings(messageId, filings, outboxDirectory);
  }
  return [...filed, ...forwardings.map(describeForwarding)].join("\n");
}

/**
 * What a failed run did nonetheless: this run's Filings and the targets recorded as having the
 * Documents. Each failed branch is left to the error, which names it.
 */
function describeFailedRun(
  messageId: string,
  { filings, forwardings }: IntakeRunError,
  outboxDirectory: string,
): string[] {
  return [
    ...(filings.length === 0 ? [] : describeFilings(messageId, filings, outboxDirectory)),
    ...forwardings.flatMap((attempt) =>
      attempt.status === "forwarded" || attempt.status === "forwarded-earlier"
        ? [describeForwarding(attempt)]
        : [],
    ),
  ];
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
  }).catch((error: unknown) => {
    if (error instanceof IntakeRunError) {
      const done = describeFailedRun(
        normalizeMessageId(intake.messageId),
        error,
        paths.outboxDirectory,
      );
      if (done.length > 0) console.log(done.join("\n"));
    }
    throw error;
  });
  return describe(result, paths.outboxDirectory);
}

try {
  console.log(await main(process.argv.slice(2)));
} catch (error) {
  console.error(`hex intake: ${messageOf(error)}`);
  process.exitCode = 1;
}
