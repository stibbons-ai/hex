// What becomes of an Intake's mail in the intake mailbox, and the failed-run policy that decides
// it: shared by the Intake workflow's last step and the mailbox watcher.
import { IntakeLedger, Mailbox, outcomeFolder } from "@hex/adapters";
import type { MailOutcome } from "@hex/adapters";
import { Effect, Option, Schema } from "effect";

/** How many copies a move took along: at least the one it was asked to move. */
const Copies = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** What a move of the Intake's mail to `to`'s folder did. */
const moveFates = <To extends MailOutcome>(to: To) =>
  [
    /** Every copy in the watched folder went to the outcome's folder. */
    Schema.Struct({ status: Schema.Literal("moved"), to: Schema.Literal(to), copies: Copies }),
    /** No copy in the watched folder (an Intake not from the mailbox, or moved already). */
    Schema.Struct({ status: Schema.Literal("not-in-mailbox"), to: Schema.Literal(to) }),
    /** The move failed (the mailbox unreachable): the mail stays until a later scan moves it. */
    Schema.Struct({
      status: Schema.Literal("not-moved"),
      to: Schema.Literal(to),
      reason: Schema.String,
    }),
  ] as const;

/** What happened to a processed Intake's mail. */
export const ProcessedMailFate = Schema.Union(moveFates("processed"));
export type ProcessedMailFate = typeof ProcessedMailFate.Type;

/** What happened to the mail of an Intake whose run failed. */
export const FailedRunMailFate = Schema.Union([
  /** The run failed with runs left: the mail stays in the watched folder for a retry. */
  Schema.Struct({ status: Schema.Literal("kept-for-retry") }),
  ...moveFates("failed"),
]);
export type FailedRunMailFate = typeof FailedRunMailFate.Type;

export type MailFate = ProcessedMailFate | FailedRunMailFate;

/** What a move to `To`'s folder did. */
export type MoveFate<To extends MailOutcome> = Extract<MailFate, { readonly to: To }>;

/** An Intake's failed runs so far (this one included), and what happened to its mail. */
export interface FailedRun {
  readonly failedRuns: number;
  readonly mail: FailedRunMailFate;
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
export const moveMail = <To extends MailOutcome>(messageId: string, to: To) =>
  Mailbox.use((mailbox) => mailbox.moveMessageId(messageId, to)).pipe(
    Effect.map(
      (copies) =>
        (copies > 0
          ? { status: "moved", to, copies }
          : { status: "not-in-mailbox", to }) as MoveFate<To>,
    ),
    Effect.catchTag("MailboxError", ({ message }) =>
      Effect.succeed({ status: "not-moved", to, reason: message } as MoveFate<To>),
    ),
  );

/**
 * The Intake fails permanently, on the run `runId` if a run is at hand: its failed runs stop
 * counting (in one transaction), so moving it back retries it afresh, and its mail goes to
 * `hex/failed`. Ended first: a move that fails leaves the Intake run afresh by the watcher (a
 * new series of runs) rather than stuck; the run's own row stays, so a repeat of its step after a
 * restart still ends here.
 */
export const failPermanently = (messageId: string, runId?: string) =>
  IntakeLedger.use((ledger) => ledger.endFailedRuns(messageId, runId)).pipe(
    Effect.andThen(moveMail(messageId, "failed")),
  );

/**
 * Records the failed run `runId` of the Intake. On its {@link MAX_FAILED_RUNS}th failed run (or
 * when this run already ended the Intake's runs, repeated after a restart) the Intake fails
 * permanently ({@link failPermanently}); before that its mail stays for a retry.
 */
export const recordFailedRun = (messageId: string, runId: string) =>
  Effect.gen(function* () {
    const { count, ended } = yield* IntakeLedger.use((ledger) =>
      ledger.recordFailedRun(messageId, runId),
    );
    if (!ended && count < MAX_FAILED_RUNS) {
      return { failedRuns: count, mail: { status: "kept-for-retry" } } satisfies FailedRun;
    }
    const mail = yield* failPermanently(messageId, runId);
    return { failedRuns: Math.max(count, MAX_FAILED_RUNS), mail } satisfies FailedRun;
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
      return "any mail of it in the watched folder stays there";
  }
}

/** A failed run's consequence for the Intake, as Daniel reads it after the failure. */
export function describeFailedRun({ failedRuns, mail }: FailedRun): string {
  if (mail.status !== "kept-for-retry") {
    return `failed run ${failedRuns} of ${MAX_FAILED_RUNS}, so the Intake failed permanently: ${describeMove(mail)}`;
  }
  return `failed run ${failedRuns} of ${MAX_FAILED_RUNS}: ${describeMove(mail)}; the mailbox watcher runs it again no sooner than ${retryDelayMs(failedRuns) / 60_000} min from now`;
}

/** What happened to the mail, as a failed run's error carries it (from the move step), if it does. */
export function mailFateOf(error: unknown): FailedRunMailFate | undefined {
  return error instanceof Object && "mail" in error
    ? Option.getOrUndefined(Schema.decodeUnknownOption(FailedRunMailFate)(error.mail))
    : undefined;
}
