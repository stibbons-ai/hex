// What becomes of an Intake's mail in the intake mailbox, and the failed-run policy that decides
// it: shared by the Intake workflow's last step and the mailbox watcher.
import { IntakeLedger, Mailbox, outcomeFolder } from "@hex/adapters";
import type { MailOutcome } from "@hex/adapters";
import { Effect, Option, Schema } from "effect";

const Outcomes = Schema.Literals(["processed", "failed"]);

/** What happened to the Intake's mail in the watched folder. */
export const MailFate = Schema.Union([
  /** Every copy in the watched folder went to the outcome's folder. */
  Schema.Struct({ status: Schema.Literal("moved"), to: Outcomes, copies: Schema.Int }),
  /** No copy in the watched folder (an Intake not from the mailbox, or moved already). */
  Schema.Struct({ status: Schema.Literal("not-in-mailbox"), to: Outcomes }),
  /** The move failed (the mailbox unreachable): the mail stays until a later scan moves it. */
  Schema.Struct({ status: Schema.Literal("not-moved"), to: Outcomes, reason: Schema.String }),
  /** The run failed with runs left: the mail stays in the watched folder for a retry. */
  Schema.Struct({ status: Schema.Literal("kept-for-retry") }),
]);
export type MailFate = typeof MailFate.Type;

/** An Intake's failed runs so far (this one included), and what happened to its mail. */
export interface FailedRun {
  readonly failedRuns: number;
  readonly mail: MailFate;
}

/** An Intake fails permanently on its failed run number {@link MAX_FAILED_RUNS}. */
export const MAX_FAILED_RUNS = 5;

/**
 * How long after its `failedRuns`-th failed run an Intake is retried at the earliest: 5 min,
 * doubling with each failed run (5, 10, 20, 40 min).
 */
export const retryDelayMs = (failedRuns: number) => 5 * 60_000 * 2 ** (failedRuns - 1);

/**
 * Moves every copy of the Intake's mail in the watched folder to the outcome's folder. A move
 * that fails is reported in the fate, never failing: the Intake's outcome stands.
 */
export const moveMail = (messageId: string, to: MailOutcome) =>
  Mailbox.use((mailbox) => mailbox.moveMessageId(messageId, to)).pipe(
    Effect.map((copies): MailFate =>
      copies > 0 ? { status: "moved", to, copies } : { status: "not-in-mailbox", to },
    ),
    Effect.catchTag("MailboxError", ({ message }) =>
      Effect.succeed<MailFate>({ status: "not-moved", to, reason: message }),
    ),
  );

/**
 * The Intake fails permanently: its failed runs are forgotten, so moving it back retries it
 * afresh, and its mail goes to `hex/failed`. Forgotten first: a move that fails leaves the Intake
 * retried rather than stuck.
 */
export const failPermanently = (messageId: string) =>
  IntakeLedger.use((ledger) => ledger.clearFailedRuns(messageId)).pipe(
    Effect.andThen(moveMail(messageId, "failed")),
  );

/**
 * Records the failed run `runId` of the Intake. On its {@link MAX_FAILED_RUNS}th failed run the
 * Intake fails permanently ({@link failPermanently}); before that its mail stays for a retry.
 */
export const recordFailedRun = (messageId: string, runId: string) =>
  Effect.gen(function* () {
    const { count } = yield* IntakeLedger.use((ledger) => ledger.recordFailedRun(messageId, runId));
    const mail: MailFate =
      count < MAX_FAILED_RUNS ? { status: "kept-for-retry" } : yield* failPermanently(messageId);
    return { failedRuns: count, mail } satisfies FailedRun;
  });

/** Where the mail went, as the end of a sentence about the Intake. */
export function describeMove(mail: MailFate): string {
  switch (mail.status) {
    case "moved":
      return `its mail was moved to ${outcomeFolder(mail.to)}`;
    case "not-in-mailbox":
      return "no mail of it was in the watched folder";
    case "not-moved":
      return `moving its mail to ${outcomeFolder(mail.to)} failed (${mail.reason})`;
    case "kept-for-retry":
      return "its mail, if in the watched folder, stays there for a retry";
  }
}

/** A failed run's consequence for the Intake, as Daniel reads it after the failure. */
export function describeFailedRun({ failedRuns, mail }: FailedRun): string {
  if (failedRuns >= MAX_FAILED_RUNS) {
    return `failed run ${failedRuns} of ${MAX_FAILED_RUNS}, so the Intake failed permanently: ${describeMove(mail)}`;
  }
  return `failed run ${failedRuns} of ${MAX_FAILED_RUNS}: ${describeMove(mail)} no sooner than ${retryDelayMs(failedRuns) / 60_000} min from now`;
}

/** What happened to the mail, as a failed run's error carries it (from the move step), if it does. */
export function mailFateOf(error: unknown): MailFate | undefined {
  return error instanceof Object && "mail" in error
    ? Option.getOrUndefined(Schema.decodeUnknownOption(MailFate)(error.mail))
    : undefined;
}
