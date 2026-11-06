// What becomes of an Intake run's Intake report: shared by the Intake workflow, which posts it,
// and the mailbox watcher, which warns when it wasn't posted.
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

/** A failed run's consequence for its Intake, as the Intake report tells it. */
export function reportConsequence({ failedRuns, mail }: FailedRun): ReportConsequence {
  if (mail.status === "kept-for-retry") {
    return {
      status: "retry",
      failedRuns,
      maxFailedRuns: MAX_FAILED_RUNS,
      retryInMinutes: retryDelayMs(failedRuns) / 60_000,
    };
  }
  return { status: "failed-permanently", failedRuns, maxFailedRuns: MAX_FAILED_RUNS, mail };
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
