// What becomes of an Intake run's Intake report: posted by the Intake workflow, its fate in the
// run's result.
import { messageOf } from "@hex/adapters";
import type { Intake } from "@hex/adapters";
import { normalizeMessageId, renderIntakeReport } from "@hex/domain";
import type { IntakeReportInput, ReportConsequence } from "@hex/domain";
import { Effect, Option, Schema } from "effect";
import { MAX_FAILED_RUNS, retryDelayMs } from "./mail-fate";
import type { FailedRun } from "./mail-fate";
import { MainChannel } from "./main-channel";

/**
 * What became of the run's Intake report: posted to the Main channel, not posted since no Main
 * channel is configured, or not posted since posting failed (the Intake's outcome stands).
 */
export const ReportFate = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["sent", "off"]) }),
  Schema.Struct({ status: Schema.Literal("not-sent"), reason: Schema.String }),
]);
export type ReportFate = typeof ReportFate.Type;

/**
 * A failed run's consequence for its Intake, as the Intake report tells it: by its effective
 * failed runs, the ledger's plus `inMemory` (those the mailbox watcher held back in memory, the
 * ledger failing to count them), the count the watcher retries and fails it by. Kept for a retry
 * by the ledger but at the limit by that count, the Intake fails permanently at the watcher's next
 * look.
 */
export function reportConsequence(
  { failedRuns, mail }: FailedRun,
  inMemory: number,
): ReportConsequence {
  if (mail.status !== "kept-for-retry") {
    return { status: "failed-permanently", failedRuns, maxFailedRuns: MAX_FAILED_RUNS, mail };
  }
  const effective = failedRuns + inMemory;
  if (effective >= MAX_FAILED_RUNS) {
    return { status: "failing-permanently", failedRuns: effective, maxFailedRuns: MAX_FAILED_RUNS };
  }
  return {
    status: "retry",
    failedRuns: effective,
    maxFailedRuns: MAX_FAILED_RUNS,
    retryInMinutes: retryDelayMs(effective) / 60_000,
  };
}

/**
 * Posts the Intake report on `report` for `intake` to the Main channel; a post that fails, even
 * with a defect, is only its fate, never a failure.
 */
export const postReport = (
  { messageId, subject, sender }: Intake,
  report: Omit<IntakeReportInput, "intake">,
) =>
  MainChannel.use((channel) =>
    channel.post(
      renderIntakeReport({
        intake: { messageId: normalizeMessageId(messageId), subject, sender },
        ...report,
      }),
    ),
  ).pipe(
    Effect.map((status): ReportFate => ({ status })),
    Effect.catchTag("MainChannelError", ({ message }) =>
      Effect.succeed<ReportFate>({ status: "not-sent", reason: message }),
    ),
    Effect.catchDefect((defect) =>
      Effect.succeed<ReportFate>({
        status: "not-sent",
        reason: `rendering or posting it failed unexpectedly: ${messageOf(defect)}`,
      }),
    ),
  );

/** What became of a failed run's Intake report, as its error carries it, if it does. */
export function reportFateOf(error: unknown): ReportFate | undefined {
  return error instanceof Object && "report" in error
    ? Option.getOrUndefined(Schema.decodeUnknownOption(ReportFate)(error.report))
    : undefined;
}
