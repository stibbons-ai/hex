import { IntakeLedger, Mailbox, MailboxError, messageOf, readEml } from "@hex/adapters";
import type { Intake, MailOutcome } from "@hex/adapters";
import { normalizeMessageId } from "@hex/domain";
import { Cause, Effect, Exit, Fiber, Option, Schema } from "effect";
import type { IntakeResult, IntakeRuntime } from "./intake-workflow";
import {
  MAX_FAILED_RUNS,
  describeFailedRun,
  describeMove,
  failPermanently,
  mailFateOf,
  moveMail,
  notMoved,
  recordFailedRun,
  retryDelayMs,
} from "./mail-fate";
import type { FailedRun, MailFate, MoveFate } from "./mail-fate";

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
  listActiveWorkflowRuns(): Promise<{ runs: readonly { runId: string; snapshot: unknown }[] }>;
}

export interface MailboxWatcherOptions {
  /** The runtime the workflow runs on, with the Mailbox to watch. */
  runtime: IntakeRuntime;
  workflow: IntakeWorkflow;
  /** How long the watcher waits for news of new mail after a look before it looks anyway. */
  pollMs: number;
  log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  /** The current time in epoch milliseconds; tests pass their own. */
  now?: () => number;
  /** How long to wait before the `attempt`-th try after a failure; tests pass their own. */
  retryDelayAfterFailure?: (attempt: number) => number;
  /** Calls `tick` every `ms` until the returned function is called; tests pass their own. */
  every?: (ms: number, tick: () => void) => () => void;
}

export interface MailboxWatcher {
  /**
   * Stops taking mail and closes the mailbox's connection. A run in progress goes on, but what
   * the watcher would do after it (moving its mail by UID, logging its outcome, counting a run that
   * ended before its move step) does not happen.
   */
  stop(): Promise<void>;
}

/** 1 s after the first failure, doubling, at most 60 s. */
const defaultRetryDelay = (attempt: number) => Math.min(1000 * 2 ** (attempt - 1), 60_000);

const defaultEvery = (ms: number, tick: () => void) => {
  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
};

/** How long a run of the watcher's own may go before it warns, and again each time after. */
export const LONG_RUN_MS = 10 * 60_000;

/** The Message-ID of an active run's input, if its snapshot (stored as JSON or not) shows one. */
const ActiveInput = Schema.Struct({
  context: Schema.Struct({ input: Schema.Struct({ messageId: Schema.String }) }),
});
const decodeActiveInput = Schema.decodeUnknownOption(
  Schema.Union([ActiveInput, Schema.fromJsonString(ActiveInput)]),
);

/** Whether a failure at one mail ends the look: the connection is gone, or the UIDs are stale. */
const endsLook = (error: unknown): error is MailboxError =>
  error instanceof MailboxError && error.reason !== "refused";

/**
 * Watches the intake mailbox: looks at the watched folder at once, after every new-mail
 * notification, and again `pollMs` after a look without news, and starts one Intake workflow run
 * per Intake, one run at a time. Never starts a run for a Message-ID with an active run in
 * storage (one resumed after a restart, say), and for an Intake already processed only moves its
 * mail to `hex/processed`; copies of one Message-ID start one run. An Intake whose runs failed is
 * retried no sooner than {@link retryDelayMs} after its last failed run, and fails permanently on
 * its {@link MAX_FAILED_RUNS}th. A mail that can't become an Intake goes to `hex/failed` at once,
 * without a run. Every action goes by the Message-ID hex reads from the mail, the one the run,
 * the ledger and the active runs know it by; the server's reading decides only to pass over a
 * mail without fetching it (another copy seen in this look, an active run, a retry still
 * waiting), so when the two differ, it can hold back a mail hex would run. A run of its own still
 * going after {@link LONG_RUN_MS} is a warning, repeated as long as it goes on: no other mail is
 * taken meanwhile. A failure with one mail is logged at warn, naming its UID and the server's
 * Message-ID, and the look goes on with the next. A lost connection, UIDs that changed meaning, a
 * failure to list the folder or the active runs, or to wait for news, ends the look at warn
 * (anything unexpected at error), and the watcher tries again after a growing delay, for as long
 * as it runs.
 */
export function watchMailbox({
  runtime,
  workflow,
  pollMs,
  log,
  now = Date.now,
  retryDelayAfterFailure = defaultRetryDelay,
  every = defaultEvery,
}: MailboxWatcherOptions): MailboxWatcher {
  let stopped = false;
  /** Message-IDs whose skip because of an active run was logged; dropped once no longer active. */
  let activeLogged = new Set<string>();
  /** Active runs whose input could not be read, warned about once. */
  const unreadableRuns = new Set<string>();

  /** The Intake runs active in storage: their run ids by Message-ID (normalised). */
  const activeRuns = Effect.tryPromise({
    try: () => workflow.listActiveWorkflowRuns(),
    catch: (cause) => new Error(`listing the active Intake runs failed: ${messageOf(cause)}`),
  }).pipe(
    Effect.map(
      ({ runs }) =>
        new Map(
          runs.flatMap(({ runId, snapshot }) =>
            Option.match(decodeActiveInput(snapshot), {
              onNone: () => {
                if (!unreadableRuns.has(runId)) {
                  unreadableRuns.add(runId);
                  log.warn(
                    `hex: mailbox: the active Intake run ${runId} shows no Message-ID; its Intake isn't guarded against a second run`,
                  );
                }
                return [];
              },
              onSome: ({ context }) => [
                [normalizeMessageId(context.input.messageId), runId] as const,
              ],
            }),
          ),
        ),
    ),
  );

  /**
   * Logs `line`: a warning when the move failed or the mail goes to `hex/failed`. Called as
   * methods: loggers need `this`.
   */
  const logBy = (fate: MailFate, line: string) => {
    if (fate.status === "not-moved" || ("to" in fate && fate.to === "failed")) log.warn(line);
    else log.info(line);
  };

  /**
   * `fate` of a move to `fate.to`, finished by moving the mail at `uid` by its UID: when the move
   * found no copy by Message-ID (the server reads the Message-ID differently from hex, say), and,
   * once more, when a move to `hex/failed` failed (else the next look would run the Intake afresh).
   * No mail at that UID makes it `not-in-mailbox` (a failed move that went through after all, say);
   * a move by UID that fails makes it `not-moved`, with the error when that ends the look.
   */
  const settle = <To extends MailOutcome>(uid: number, fate: MoveFate<To>) =>
    fate.status === "not-in-mailbox" || (fate.status === "not-moved" && fate.to === "failed")
      ? Mailbox.use((mailbox) => mailbox.moveUid(uid, fate.to)).pipe(
          Effect.map(
            (moved) =>
              [
                (moved
                  ? { status: "moved", to: fate.to, copies: 1 }
                  : { status: "not-in-mailbox", to: fate.to }) as MoveFate<To>,
                undefined,
              ] as const,
          ),
          Effect.catchTag("MailboxError", (error) =>
            Effect.succeed([
              notMoved(fate.to, error.message),
              endsLook(error) ? error : undefined,
            ] as const),
          ),
        )
      : Effect.succeed([fate, undefined] as const);

  /**
   * `fate` settled ({@link settle}) and logged as `describe` puts it (`undefined`: not logged);
   * then a settling error that ends the look ends it.
   */
  const settleLogged = <To extends MailOutcome>(
    uid: number,
    fate: MoveFate<To>,
    describe: (settled: MoveFate<To>) => string | undefined,
  ) =>
    Effect.gen(function* () {
      const [settled, ending] = yield* settle(uid, fate);
      const line = describe(settled);
      if (line !== undefined) logBy(settled, line);
      if (ending) return yield* Effect.fail(ending);
    });

  /** The mail at `uid` of the processed Intake `messageId` moved to `hex/processed`, logged. */
  const settleProcessed = (messageId: string, uid: number, what: string) =>
    Effect.gen(function* () {
      yield* settleLogged(
        uid,
        yield* moveMail(messageId, "processed"),
        (settled) => `hex: Intake ${messageId}: ${what}; ${describeMove(settled)}`,
      );
    });

  /** The failed run `runId` recorded, the mail at `uid` settled, the consequence warned of. */
  const countFailedRun = (messageId: string, runId: string, uid: number) =>
    Effect.gen(function* () {
      const failed = yield* recordFailedRun(messageId, runId);
      const line = (mail: FailedRun["mail"]) =>
        `hex: Intake ${messageId}: ${describeFailedRun({ ...failed, mail })}`;
      // Kept for a retry, or moved to (or failing to move to) `hex/failed`: a warning either way.
      if (failed.mail.status === "kept-for-retry") log.warn(line(failed.mail));
      else yield* settleLogged(uid, failed.mail, line);
    });

  /**
   * `run`'s start, warning each {@link LONG_RUN_MS} it goes on: the watcher takes no other mail
   * meanwhile.
   */
  const startWatched = (run: IntakeRun, intake: Intake) =>
    Effect.suspend(() => {
      const startedAt = now();
      const stopWarning = every(LONG_RUN_MS, () => {
        const minutes = Math.round((now() - startedAt) / 60_000);
        try {
          log.warn(
            `hex: Intake ${intake.messageId}: its run ${run.runId} has been running for ${minutes} min; the mailbox watcher takes no other mail until it ends`,
          );
        } catch {
          // A logger that fails here has no caller to tell; the next tick tries again.
        }
      });
      return Effect.result(Effect.tryPromise(() => run.start({ inputData: intake }))).pipe(
        Effect.ensuring(Effect.sync(stopWarning)),
      );
    });

  /** Runs the workflow on `intake`, the mail at `uid`, and logs what came of it. */
  const process = (intake: Intake, uid: number) =>
    Effect.gen(function* () {
      const { messageId } = intake;
      const run = yield* Effect.tryPromise({
        try: () => workflow.createRun(),
        catch: (cause) => new Error(`creating its run failed: ${messageOf(cause)}`),
      });
      const started = yield* startWatched(run, intake);
      if (started._tag === "Failure") {
        log.warn(
          `hex: Intake ${messageId}: its run failed: ${messageOf(started.failure.cause ?? started.failure)}`,
        );
        // Mastra can fail to store a run's end after every step ran: then it is processed.
        if (yield* IntakeLedger.use((ledger) => ledger.find(messageId))) {
          return yield* settleProcessed(messageId, uid, "processed nonetheless");
        }
        return yield* countFailedRun(messageId, run.runId, uid);
      }
      const result = started.success;
      if (result.status === "success" && "result" in result) {
        const { status, mail } = result.result;
        yield* settleLogged(
          uid,
          mail,
          (settled) => `hex: Intake ${messageId}: ${status}; ${describeMove(settled)}`,
        );
        return;
      }
      // Mastra's failed result carries the step's error as it serialised it, `message` included.
      const error = "error" in result ? result.error : undefined;
      const reason = error ? error.message : `the run ended ${result.status}`;
      log.warn(`hex: Intake ${messageId}: the run failed: ${reason}`);
      const fate = mailFateOf(error);
      if (fate) {
        if (fate.status !== "kept-for-retry") {
          // The run's own line told the fate; one the watcher changed gets a line of its own.
          yield* settleLogged(uid, fate, (settled) =>
            settled.status === fate.status && settled.status !== "not-moved"
              ? undefined
              : `hex: Intake ${messageId}: failed permanently; ${describeMove(settled)}`,
          );
        }
        return;
      }
      // Ended before its move step counted it (an unreadable ledger, a defect, a ledger that
      // failed to count or end the failed runs there): counted here instead.
      yield* countFailedRun(messageId, run.runId, uid);
    });

  /** One look at the watched folder: every mail in it, one at a time. */
  const scan = Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    const ledger = yield* IntakeLedger;
    const mails = yield* mailbox.list;
    if (mails.length === 0) return;
    const active = yield* activeRuns;
    activeLogged = new Set([...activeLogged].filter((id) => active.has(id)));
    /** Message-IDs passed over in this look, or run: a later copy of one is passed over. */
    const seen = new Set<string>();

    /**
     * Whether to pass over the Intake `messageId` without looking further: another copy was seen
     * in this look, it has an active run (warned of once), or it waits for its retry. Decides
     * only to pass over: moves nothing, counts nothing.
     */
    const passOver = (messageId: string) =>
      Effect.gen(function* () {
        if (seen.has(messageId)) return true;
        const runId = active.get(messageId);
        if (runId !== undefined) {
          if (!activeLogged.has(messageId)) {
            activeLogged.add(messageId);
            log.warn(
              `hex: Intake ${messageId}: its run ${runId} is active; its mail is left to that run until the run ends or hex restarts`,
            );
          }
          return true;
        }
        const failed = yield* ledger.failedRuns(messageId);
        return (
          failed !== undefined &&
          failed.count < MAX_FAILED_RUNS &&
          now() < Date.parse(failed.lastFailedAt) + retryDelayMs(failed.count)
        );
      });

    /**
     * Whether to start a run for the Intake `messageId` (hex's reading), the mail at `uid`: not
     * when it is passed over, nor when it is settled without one: already processed (its mail
     * moved), or its runs reached the limit without it failing permanently (the process died, or
     * ending the count failed, in between: it fails permanently now).
     */
    const shouldRun = (messageId: string, uid: number) =>
      Effect.gen(function* () {
        if (yield* passOver(messageId)) return false;
        if (yield* ledger.find(messageId)) {
          yield* settleProcessed(messageId, uid, "already processed");
          return false;
        }
        const failed = yield* ledger.failedRuns(messageId);
        if (failed && failed.count >= MAX_FAILED_RUNS) {
          yield* settleLogged(
            uid,
            yield* failPermanently(messageId),
            (settled) => `hex: Intake ${messageId}: failed permanently; ${describeMove(settled)}`,
          );
          return false;
        }
        return true;
      });

    /**
     * The mail at `uid`, listed with the server's reading of its Message-ID. Both readings come
     * normalised: the listing's by the Mailbox, hex's by `readEml`.
     */
    const look = (uid: number, listed: string | undefined) =>
      Effect.gen(function* () {
        if (listed !== undefined && (yield* passOver(listed))) {
          seen.add(listed);
          return;
        }
        const source = yield* mailbox.source(uid);
        if (!source) return;
        const read = yield* Effect.result(readEml(source, `${mailbox.folder} UID ${uid}`));
        if (read._tag === "Failure") {
          log.warn(`hex: mailbox: ${read.failure.message}; moving it to hex/failed`);
          yield* mailbox.moveUid(uid, "failed");
          return;
        }
        const intake = read.success;
        const run = yield* shouldRun(intake.messageId, uid);
        seen.add(intake.messageId);
        if (listed !== undefined) seen.add(listed);
        if (run && !stopped) yield* process(intake, uid);
      });

    for (const { uid, messageId: listed } of mails) {
      if (stopped) return;
      const mail = `UID ${uid} (${listed ?? "no Message-ID"} as the server reads it)`;
      yield* look(uid, listed).pipe(
        Effect.tapCause((cause) =>
          Effect.sync(() => {
            if (Cause.hasDies(cause))
              log.error(`hex: mailbox: ${mail}: something unexpected failed`);
          }),
        ),
        Effect.catch((error) => {
          if (!endsLook(error)) {
            log.warn(`hex: mailbox: ${mail}: ${messageOf(error)}; going on with the next mail`);
            return Effect.void;
          }
          return Effect.fail(new MailboxError({ ...error, message: `${mail}: ${error.message}` }));
        }),
      );
    }
  });

  const watch = Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    log.info(
      `hex: mailbox: watching ${mailbox.folder}, looking again ${pollMs / 1000} s after a look without news`,
    );
    let failures = 0;
    while (!stopped) {
      const looked = yield* Effect.exit(scan.pipe(Effect.andThen(mailbox.waitForChange(pollMs))));
      if (Exit.isSuccess(looked)) {
        failures = 0;
        continue;
      }
      if (stopped || Cause.hasInterruptsOnly(looked.cause)) return;
      failures++;
      const delay = retryDelayAfterFailure(failures);
      const retrying = `trying again in ${delay / 1000} s (attempt ${failures})`;
      if (Cause.hasDies(looked.cause)) {
        log.error(
          `hex: mailbox: the watcher failed unexpectedly: ${Cause.pretty(looked.cause)}; ${retrying}`,
        );
      } else {
        log.warn(`hex: mailbox: ${messageOf(Cause.squash(looked.cause))}; ${retrying}`);
      }
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
