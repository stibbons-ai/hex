import { IntakeLedger, Mailbox, MailboxError, messageOf, readEml } from "@hex/adapters";
import type { Intake, MailOutcome } from "@hex/adapters";
import { normalizeMessageId } from "@hex/domain";
import { Cause, Effect, Exit, Fiber, Option, Schema } from "effect";
import { HeldBack } from "./held-back";
import { isFailedRunError } from "./intake-workflow";
import type { IntakeResult, IntakeRuntime } from "./intake-workflow";
import {
  MAX_FAILED_RUNS,
  describeFailedRun,
  describeMove,
  failPermanently,
  mailFateOf,
  moveMail,
  moved,
  notInMailbox,
  notMoved,
  recordFailedRun,
  retryDelayMs,
} from "./mail-fate";
import type { DescribeOptions, FailedRun, MailFate, MoveFate } from "./mail-fate";

/** One run of the Intake workflow, as the watcher starts it. */
export interface IntakeRun {
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
   * the watcher would do after it (moving its mail by Message-ID again or by UID, logging its
   * outcome, counting a run that ended before its move step, or holding its Intake back in memory
   * when that count fails) does not happen.
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
 * its {@link MAX_FAILED_RUNS}th. Failed runs the ledger can't count are counted in memory on top
 * of its count, until hex restarts: at {@link MAX_FAILED_RUNS}, the Intake runs no more until
 * then. A mail that can't become an Intake goes to `hex/failed` at once,
 * without a run. Every action goes by the Message-ID hex reads from the mail, the one the run,
 * the ledger and the active runs know it by; the server's reading decides only to pass over a
 * mail without fetching it (another copy seen in this look, an active run, an Intake held back
 * in memory, a retry still waiting), so when the two differ, it can hold back a mail hex would
 * run. A run of its own still
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

  /** The mail at `uid` moved to `to` by its UID, as a fate, with the error when that ends the look. */
  const moveByUid = <To extends MailOutcome>(uid: number, to: To) =>
    Mailbox.use((mailbox) => mailbox.moveUid(uid, to)).pipe(
      Effect.map((done) => [done ? moved(to, 1) : notInMailbox(to), undefined] as const),
      Effect.catchTag("MailboxError", (error) =>
        Effect.succeed([notMoved(to, error.message), endsLook(error) ? error : undefined] as const),
      ),
    );

  /**
   * `fate` of a move of the Intake `messageId`'s mail to `fate.to`, finished by moving the mail at
   * `uid` by its UID when the move found no copy by Message-ID (the server reads the Message-ID
   * differently from hex, say). For `hex/failed`, whose Intake's count is ended already (a copy
   * left behind would be run afresh): a failed move is tried again by Message-ID, then by UID, and
   * after a move by Message-ID the mail at `uid` goes too if still there, that follow-up's own
   * fate given third (the fate counts one copy more when it went, stays as it was when it
   * failed). No mail at that UID makes a failed move `not-in-mailbox` (it went through after all,
   * say); a move by UID in its place that fails makes it `not-moved`. Either move by UID that
   * fails comes with its error when that ends the look.
   */
  const settle = <To extends MailOutcome>(
    messageId: string,
    uid: number,
    fate: MoveFate<To>,
  ): Effect.Effect<
    readonly [settled: MoveFate<To>, ending: MailboxError | undefined, followUp?: MoveFate<To>],
    never,
    Mailbox
  > =>
    Effect.gen(function* () {
      if (fate.to === "failed" && fate.status === "moved") {
        const [followUp, ending] = yield* moveByUid(uid, fate.to);
        const settled = followUp.status === "moved" ? moved(fate.to, fate.copies + 1) : fate;
        return [settled, ending, followUp] as const;
      }
      if (fate.to === "failed" && fate.status === "not-moved") {
        const again = yield* moveMail(messageId, fate.to);
        if (again.status === "moved") return yield* settle(messageId, uid, again);
      }
      if (fate.status === "not-moved" && fate.to !== "failed") return [fate, undefined] as const;
      if (fate.status === "moved") return [fate, undefined] as const;
      return yield* moveByUid(uid, fate.to);
    });

  /** What came of the follow-up move by UID ({@link settle}) of a copy at `uid`, if worth a line. */
  const describeFollowUp = (uid: number, followUp: MailFate) => {
    const copy = `its mail at UID ${uid}, a copy the server reads with another Message-ID,`;
    switch (followUp.status) {
      case "moved":
        return `${copy} was moved to hex/failed too`;
      case "not-moved":
        return `${copy} couldn't be moved to hex/failed (${followUp.reason}); the mailbox watcher runs it afresh (a new series of ${MAX_FAILED_RUNS} runs) at its next look`;
      default:
        return undefined;
    }
  };

  /**
   * `fate` settled ({@link settle}) and logged as `describe` puts it (`undefined`: not logged),
   * a follow-up move by UID that moved a copy, or failed to, with a line of its own; then a
   * settling error that ends the look ends it. Called once the Intake is processed or failed
   * permanently, so its hold-back in memory, if any, ends.
   */
  const settleLogged = <To extends MailOutcome>(
    messageId: string,
    uid: number,
    fate: MoveFate<To>,
    describe: (settled: MoveFate<To>, options: DescribeOptions) => string | undefined,
  ) =>
    Effect.gen(function* () {
      (yield* HeldBack).delete(messageId);
      const [settled, ending, followUp] = yield* settle(messageId, uid, fate);
      const afterFailedMove = fate.status === "not-moved" && settled.status === "not-in-mailbox";
      const line = describe(settled, { afterFailedMove });
      if (line !== undefined) logBy(settled, line);
      if (followUp !== undefined) {
        const followUpLine = describeFollowUp(uid, followUp);
        if (followUpLine !== undefined) {
          logBy(followUp, `hex: Intake ${messageId}: ${followUpLine}`);
        }
      }
      if (ending) return yield* Effect.fail(ending);
    });

  /**
   * {@link settleLogged} for an Intake failed permanently, a failed move warned of before it is
   * tried again. A logger that throws on that warning doesn't keep the mail from settling: its
   * defect surfaces afterwards, unless settling fails too, whose failure then wins.
   */
  const settleFailed = (
    messageId: string,
    uid: number,
    fate: MoveFate<"failed">,
    describe: (settled: MoveFate<"failed">, options: DescribeOptions) => string,
  ) =>
    Effect.gen(function* () {
      const warned = yield* Effect.exit(
        fate.status === "not-moved"
          ? Effect.sync(() => log.warn(describe(fate, { retryPending: true })))
          : Effect.void,
      );
      yield* settleLogged(messageId, uid, fate, describe);
      yield* warned;
    });

  /** The mail at `uid` of the processed Intake `messageId` moved to `hex/processed`, logged. */
  const settleProcessed = (messageId: string, uid: number, what: string) =>
    Effect.gen(function* () {
      yield* settleLogged(
        messageId,
        uid,
        yield* moveMail(messageId, "processed"),
        (settled, options) =>
          `hex: Intake ${messageId}: ${what}; ${describeMove(settled, options)}`,
      );
    });

  /** Intakes whose effective failed runs reached {@link MAX_FAILED_RUNS}: not run until hex restarts. */
  const stoppedUntilRestart = new Set<string>();

  /** The Intake `messageId` runs no more until hex restarts, after `what`, logged as an error. */
  const stopUntilRestart = (messageId: string, what: string) =>
    HeldBack.useSync((heldBack) => {
      heldBack.delete(messageId);
      stoppedUntilRestart.add(messageId);
      log.error(
        `hex: Intake ${messageId}: ${what}, but the ledger can't record failed runs to fail it permanently, so hex runs it no more until it restarts; its mail stays in the watched folder, and a restart retries it`,
      );
    });

  /**
   * The warning after a failed run the ledger counted (`counted` its count now) and kept for a
   * retry, for an Intake with failed runs counted in memory too: by its effective count, at the
   * limit failed permanently by the next look. `undefined` without any in memory.
   */
  const heldLine = (messageId: string, counted: number) =>
    HeldBack.useSync((heldBack) => {
      const held = heldBack.get(messageId);
      if (held === undefined) return undefined;
      const failedRuns = counted + held.count;
      const next =
        failedRuns >= MAX_FAILED_RUNS
          ? "the mailbox watcher fails it permanently at its next look"
          : `any mail of it in the watched folder stays there; the mailbox watcher runs it again no sooner than ${retryDelayMs(failedRuns) / 60_000} min from now`;
      return `hex: Intake ${messageId}: failed run ${failedRuns} of ${MAX_FAILED_RUNS}, ${held.count} of them counted in memory: ${next}`;
    });

  /**
   * The failed run `runId` recorded, the mail at `uid` settled, the consequence warned of. A
   * failed move is warned of before it is tried again. A ledger that can't count it holds the
   * Intake back in memory instead, logged as an error ({@link holdBack}).
   */
  const countFailedRun = (messageId: string, runId: string, uid: number) =>
    Effect.gen(function* () {
      const failed = yield* recordFailedRun(messageId, runId);
      const line = (mail: FailedRun["mail"], options?: DescribeOptions) =>
        `hex: Intake ${messageId}: ${describeFailedRun({ ...failed, mail }, options)}`;
      // Kept for a retry, or moved to (or failing to move to) `hex/failed`: a warning either way.
      if (failed.mail.status === "kept-for-retry") {
        return log.warn((yield* heldLine(messageId, failed.failedRuns)) ?? line(failed.mail));
      }
      yield* settleFailed(messageId, uid, failed.mail, line);
    }).pipe(Effect.catchTag("LedgerError", ({ message }) => holdBack(messageId, message)));

  /**
   * The Intake `messageId`, whose failed run the ledger couldn't count (`message`) or, after a
   * rejected start, couldn't say whether the Intake was processed nonetheless, counted in memory
   * and held back for {@link retryDelayMs} of its effective failed runs. At
   * {@link MAX_FAILED_RUNS} it runs no more until hex restarts: the ledger can't fail it
   * permanently. A ledger that did count it to the limit (only ending the count failed) holds
   * nothing back: the next look fails it permanently. A ledger count that can't be read counts
   * as 0, said in the line. A run the ledger inserted but whose count it then failed to read
   * back (or one repeated after a restart whose ending failed) is counted twice, in the ledger
   * and here: rare, and at worst it stops one run early.
   */
  const holdBack = (messageId: string, message: string) =>
    Effect.gen(function* () {
      const heldBack = yield* HeldBack;
      const read = yield* Effect.result(IntakeLedger.use((ledger) => ledger.failedRuns(messageId)));
      const counted = read._tag === "Success" ? (read.success?.count ?? 0) : 0;
      if (counted >= MAX_FAILED_RUNS) {
        return log.error(
          `hex: Intake ${messageId}: failing it permanently failed (${message}); the next look tries again`,
        );
      }
      const count = (heldBack.get(messageId)?.count ?? 0) + 1;
      const failedRuns = counted + count;
      const unreadable =
        read._tag === "Failure" ? ` (its ledger count unreadable: ${read.failure.message})` : "";
      const uncounted = `its failed run could not be counted (${message}); failed run ${failedRuns} of ${MAX_FAILED_RUNS}${unreadable}`;
      if (failedRuns >= MAX_FAILED_RUNS) return yield* stopUntilRestart(messageId, uncounted);
      heldBack.set(messageId, { count, lastAt: now() });
      log.error(
        `hex: Intake ${messageId}: ${uncounted}, held back ${retryDelayMs(failedRuns) / 60_000} min in memory`,
      );
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
        // Mastra can fail to store a run's end after every step ran: then it is processed. A
        // ledger that can't tell holds it back as a failed run it can't count.
        const processed = yield* Effect.result(
          IntakeLedger.use((ledger) => ledger.find(messageId)),
        );
        if (processed._tag === "Failure") {
          return yield* holdBack(messageId, processed.failure.message);
        }
        if (processed.success) {
          return yield* settleProcessed(messageId, uid, "processed nonetheless");
        }
        return yield* countFailedRun(messageId, run.runId, uid);
      }
      const result = started.success;
      if (result.status === "success" && "result" in result) {
        const { status, mail } = result.result;
        yield* settleLogged(
          messageId,
          uid,
          mail,
          (settled, options) =>
            `hex: Intake ${messageId}: ${status}; ${describeMove(settled, options)}`,
        );
        return;
      }
      // Mastra's failed result carries the step's error as it serialised it, `message` included.
      // The move step's own failed run warned of itself; any other failure is told here.
      const error = "error" in result ? result.error : undefined;
      const reason = error ? error.message : `the run ended ${result.status}`;
      if (!isFailedRunError(error)) log.warn(`hex: Intake ${messageId}: the run failed: ${reason}`);
      const fate = mailFateOf(error);
      if (fate) {
        if (fate.status === "kept-for-retry") {
          // The run's line counted the ledger's failed runs only; with some in memory too, the
          // effective count gets a line of its own (none when the ledger can't be read now).
          if ((yield* HeldBack).has(messageId)) {
            const failed = yield* Effect.option(
              IntakeLedger.use((ledger) => ledger.failedRuns(messageId)),
            );
            const line = Option.isSome(failed)
              ? yield* heldLine(messageId, failed.value?.count ?? 0)
              : undefined;
            if (line !== undefined) log.warn(line);
          }
          return;
        }
        // The run's own line told the fate; a fate the watcher changed, or a failed move that
        // failed again, gets a line of its own.
        yield* settleLogged(messageId, uid, fate, (settled, options) =>
          settled.status === fate.status && settled.status !== "not-moved"
            ? undefined
            : `hex: Intake ${messageId}: failed permanently; ${describeMove(settled, options)}`,
        );
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
    const heldBack = yield* HeldBack;
    const mails = yield* mailbox.list;
    if (mails.length === 0) {
      heldBack.clear();
      return;
    }
    const active = yield* activeRuns;
    activeLogged = new Set([...activeLogged].filter((id) => active.has(id)));
    /** Message-IDs passed over in this look, or run: a later copy of one is passed over. */
    const seen = new Set<string>();

    /**
     * Whether to pass over the Intake `messageId` without looking further: another copy was seen
     * in this look, it runs no more until hex restarts, it has an active run (warned of once), or
     * it waits for its retry after the failed runs the ledger and the memory counted. Decides
     * only to pass over: moves nothing, counts nothing.
     */
    const passOver = (messageId: string) =>
      Effect.gen(function* () {
        if (seen.has(messageId) || stoppedUntilRestart.has(messageId)) return true;
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
        const held = heldBack.get(messageId);
        const failedRuns = (failed?.count ?? 0) + (held?.count ?? 0);
        // At the limit: failed permanently by `shouldRun`.
        if (failedRuns >= MAX_FAILED_RUNS) return false;
        const since = Math.max(failed ? Date.parse(failed.lastFailedAt) : 0, held?.lastAt ?? 0);
        return failedRuns > 0 && now() < since + retryDelayMs(failedRuns);
      });

    /**
     * Whether to start a run for the Intake `messageId` (hex's reading), the mail at `uid`: not
     * when it is passed over, nor when it is settled without one: already processed (its mail
     * moved), or its effective failed runs reached the limit without it failing permanently (the
     * process died, ending the count failed, or some were counted in memory): it fails
     * permanently now. When that fails for an Intake with failed runs in memory, it runs no more
     * until hex restarts.
     */
    const shouldRun = (messageId: string, uid: number) =>
      Effect.gen(function* () {
        if (yield* passOver(messageId)) return false;
        if (yield* ledger.find(messageId)) {
          yield* settleProcessed(messageId, uid, "already processed");
          return false;
        }
        const failed = yield* ledger.failedRuns(messageId);
        const inMemory = heldBack.get(messageId)?.count ?? 0;
        const failedRuns = (failed?.count ?? 0) + inMemory;
        if (failedRuns < MAX_FAILED_RUNS) return true;
        const ended = yield* Effect.result(failPermanently(messageId));
        if (ended._tag === "Failure") {
          if (inMemory === 0) return yield* Effect.fail(ended.failure);
          yield* stopUntilRestart(
            messageId,
            `failing it permanently failed (${ended.failure.message}); failed run ${failedRuns} of ${MAX_FAILED_RUNS}, ${inMemory} of them counted in memory`,
          );
          return false;
        }
        const fate = ended.success;
        const line = (mail: MailFate, options?: DescribeOptions) =>
          `hex: Intake ${messageId}: failed permanently; ${describeMove(mail, options)}`;
        yield* settleFailed(messageId, uid, fate, line);
        return false;
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
    // A hold-back whose Message-ID this full look didn't list: its mail is gone.
    const listed = new Set(
      mails.flatMap(({ messageId }) => (messageId === undefined ? [] : [messageId])),
    );
    for (const messageId of heldBack.keys()) {
      if (!listed.has(messageId) && !seen.has(messageId)) heldBack.delete(messageId);
    }
  });

  const watch = Effect.gen(function* () {
    const mailbox = yield* Mailbox;
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
