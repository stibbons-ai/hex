import { IntakeLedger, Mailbox, messageOf, readEml } from "@hex/adapters";
import type { Intake } from "@hex/adapters";
import { normalizeMessageId } from "@hex/domain";
import { Effect, Fiber, Option, Schema } from "effect";
import type { IntakeResult, IntakeRuntime } from "./intake-workflow";
import {
  MAX_FAILED_RUNS,
  describeFailedRun,
  describeMove,
  failPermanently,
  mailFateOf,
  moveMail,
  recordFailedRun,
  retryDelayMs,
} from "./mail-fate";
import type { MailFate } from "./mail-fate";

/** One run of the Intake workflow, as the watcher starts it. */
interface IntakeRun {
  readonly runId: string;
  start(args: {
    inputData: Intake;
  }): Promise<
    | { status: "success"; result: IntakeResult }
    | { status: "failed"; error: Error }
    | { status: string }
  >;
}

/** The registered Intake workflow: what the watcher needs of it. */
export interface IntakeWorkflow {
  createRun(): Promise<IntakeRun>;
  /** Runs running or waiting in storage, with their snapshots (the input among them). */
  listActiveWorkflowRuns(): Promise<{ runs: readonly { snapshot: unknown }[] }>;
}

export interface MailboxWatcherOptions {
  /** The runtime the workflow runs on, with the Mailbox to watch. */
  runtime: IntakeRuntime;
  workflow: IntakeWorkflow;
  /** How long the watcher waits for news of new mail before it looks anyway. */
  pollMs: number;
  log: { info(message: string): void; warn(message: string): void };
  /** The current time in epoch milliseconds; tests pass their own. */
  now?: () => number;
  /** How long to wait before the `attempt`-th try after a failure; tests pass their own. */
  retryDelayAfterFailure?: (attempt: number) => number;
}

export interface MailboxWatcher {
  /** Stops taking mail (a run in progress goes on) and closes the mailbox's connection. */
  stop(): Promise<void>;
}

/** 1 s after the first failure, doubling, at most 60 s. */
const defaultRetryDelay = (attempt: number) => Math.min(1000 * 2 ** (attempt - 1), 60_000);

/** The Message-ID of an active run's input, if its snapshot (stored as JSON or not) shows one. */
const ActiveInput = Schema.Struct({
  context: Schema.Struct({ input: Schema.Struct({ messageId: Schema.String }) }),
});
const decodeActiveInput = Schema.decodeUnknownOption(
  Schema.Union([ActiveInput, Schema.fromJsonString(ActiveInput)]),
);

/**
 * Watches the intake mailbox: looks at the watched folder at once, after every new-mail
 * notification and at least every `pollMs`, and starts one Intake workflow run per Intake, one
 * run at a time. Never starts a run for a Message-ID with an active run in storage (one resumed
 * after a restart, say), and for an Intake already processed only moves its mail to
 * `hex/processed`; copies of one Message-ID start one run. An Intake whose runs failed is retried
 * no sooner than {@link retryDelayMs} after its last failed run, and fails permanently on its
 * {@link MAX_FAILED_RUNS}th. A mail that can't become an Intake goes to `hex/failed` at once,
 * without a run. A failure (the connection lost, say) is logged and the watcher tries again
 * after a growing delay, for as long as it runs.
 */
export function watchMailbox({
  runtime,
  workflow,
  pollMs,
  log,
  now = Date.now,
  retryDelayAfterFailure = defaultRetryDelay,
}: MailboxWatcherOptions): MailboxWatcher {
  let stopped = false;

  /** The Message-IDs (normalised) of the Intake runs active in storage. */
  const activeMessageIds = Effect.tryPromise({
    try: () => workflow.listActiveWorkflowRuns(),
    catch: (cause) => new Error(`listing the active Intake runs failed: ${messageOf(cause)}`),
  }).pipe(
    Effect.map(
      ({ runs }) =>
        new Set(
          runs.flatMap(({ snapshot }) =>
            Option.match(decodeActiveInput(snapshot), {
              onNone: () => [],
              onSome: ({ context }) => [normalizeMessageId(context.input.messageId)],
            }),
          ),
        ),
    ),
  );

  /**
   * The mail at `uid` moved to `fate`'s folder when the run found no copy by Message-ID (the
   * server reads the Message-ID differently from hex, say), else `fate` as is.
   */
  const settleByUid = (uid: number, fate: MailFate) =>
    fate.status === "not-in-mailbox"
      ? Mailbox.use((mailbox) => mailbox.moveUid(uid, fate.to)).pipe(
          Effect.as<MailFate>({ status: "moved", to: fate.to, copies: 1 }),
        )
      : Effect.succeed(fate);

  /** Runs the workflow on `intake`, the mail at `uid`, and logs what came of it. */
  const process = (intake: Intake, uid: number) =>
    Effect.gen(function* () {
      const { messageId } = intake;
      const { runId, result } = yield* Effect.tryPromise({
        try: async () => {
          const run = await workflow.createRun();
          return { runId: run.runId, result: await run.start({ inputData: intake }) };
        },
        catch: (cause) => new Error(`starting its run failed: ${messageOf(cause)}`),
      });
      if (result.status === "success" && "result" in result) {
        const { status, mail } = result.result;
        const fate = yield* settleByUid(uid, mail);
        log.info(`hex: Intake ${messageId}: ${status}; ${describeMove(fate)}`);
        return;
      }
      // Mastra's failed result carries the step's error as it serialised it, `message` included.
      const error = "error" in result ? result.error : undefined;
      const reason = error ? error.message : `the run ended ${result.status}`;
      const fate = mailFateOf(error);
      if (fate) {
        yield* settleByUid(uid, fate);
        log.warn(`hex: Intake ${messageId}: the run failed: ${reason}`);
        return;
      }
      // Ended before its move step (an unreadable ledger, a defect): counted here instead.
      const failed = yield* recordFailedRun(messageId, runId);
      yield* settleByUid(uid, failed.mail);
      log.warn(`hex: Intake ${messageId}: the run failed: ${reason}; ${describeFailedRun(failed)}`);
    });

  /**
   * Whether to start a run for the Intake `messageId`: not when it has an active run or waits for
   * its retry, nor when it is settled without one (already processed, or failed permanently
   * without its mail moved then).
   */
  const shouldRun = (messageId: string, active: ReadonlySet<string>) =>
    Effect.gen(function* () {
      if (active.has(messageId)) return false;
      const ledger = yield* IntakeLedger;
      if (yield* ledger.find(messageId)) {
        const fate = yield* moveMail(messageId, "processed");
        log.info(`hex: Intake ${messageId}: already processed; ${describeMove(fate)}`);
        return false;
      }
      const failed = yield* ledger.failedRuns(messageId);
      if (!failed) return true;
      if (failed.count >= MAX_FAILED_RUNS) {
        const fate = yield* failPermanently(messageId);
        log.warn(`hex: Intake ${messageId}: failed permanently; ${describeMove(fate)}`);
        return false;
      }
      return now() >= Date.parse(failed.lastFailedAt) + retryDelayMs(failed.count);
    });

  /** One look at the watched folder: every mail in it, one at a time. */
  const scan = Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    const mails = yield* mailbox.list;
    if (mails.length === 0) return;
    const active = yield* activeMessageIds;
    /** Message-IDs passed over in this scan, or run: a later copy of one is passed over. */
    const seen = new Set<string>();
    const skipped = (messageId: string) =>
      Effect.gen(function* () {
        const skip = seen.has(messageId) || !(yield* shouldRun(messageId, active));
        if (skip) seen.add(messageId);
        return skip;
      });
    for (const { uid, messageId: listed } of mails) {
      if (stopped) return;
      if (listed !== undefined && (yield* skipped(listed))) continue;
      const source = yield* mailbox.source(uid);
      if (!source) continue;
      const read = yield* Effect.result(readEml(source, `${mailbox.folder} UID ${uid}`));
      if (read._tag === "Failure") {
        log.warn(`hex: mailbox: ${read.failure.message}; moving it to hex/failed`);
        yield* mailbox.moveUid(uid, "failed");
        continue;
      }
      const intake = read.success;
      // Listed without a Message-ID the server could see: checked now, by the parsed one.
      if (listed === undefined && (yield* skipped(intake.messageId))) continue;
      seen.add(intake.messageId);
      if (stopped) return;
      yield* process(intake, uid);
    }
  });

  const watch = Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    log.info(`hex: mailbox: watching ${mailbox.folder}, looking at least every ${pollMs / 1000} s`);
    let failures = 0;
    while (!stopped) {
      const looked = yield* Effect.result(scan.pipe(Effect.andThen(mailbox.waitForChange(pollMs))));
      if (looked._tag === "Success") {
        failures = 0;
        continue;
      }
      failures++;
      const delay = retryDelayAfterFailure(failures);
      log.warn(
        `hex: mailbox: ${messageOf(looked.failure)}; trying again in ${delay / 1000} s (attempt ${failures})`,
      );
      yield* Effect.sleep(delay);
    }
  });

  const fiber = runtime.runFork(watch);
  return {
    async stop() {
      stopped = true;
      await runtime.runPromise(Fiber.interrupt(fiber));
      await runtime.runPromise(Mailbox.use((mailbox) => mailbox.close));
    },
  };
}
