import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IntakeLedger,
  LedgerError,
  createLocalStore,
  dateExtractorLayer,
  intakeLedgerLayer,
  readEml,
} from "@hex/adapters";
import type { DateExtractor, Intake } from "@hex/adapters";
import { Mastra } from "@mastra/core/mastra";
import { Clock, Effect, Layer } from "effect";
import { closeInOrder } from "../src/close";
import {
  INTAKE_WORKFLOW_ID,
  createIntakeRuntime,
  createIntakeWorkflow,
} from "../src/intake-workflow";
import type { IntakeForwarding } from "../src/intake-workflow";
import { LONG_RUN_MS, watchMailbox } from "../src/mailbox-watcher";
import type { IntakeRun, IntakeWorkflow, MailboxWatcher } from "../src/mailbox-watcher";
import { buildEml, pdfMail } from "./eml";
import { memoryMailbox } from "./memory-mailbox";
import { mockModel } from "./mock-model";
import { recordingMailer } from "./recording-mailer";
import { recordingMainChannel } from "./recording-main-channel";
import { scriptedDateExtractor } from "./scripted-extractor";
import type { Script } from "./scripted-extractor";
import { within } from "./timeouts";

let directory: string;
let instances = 0;
/** What each test opened, closed after it. */
let cleanups: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-watcher-"));
});

afterEach(async () => {
  await closeInOrder(cleanups.reverse());
  cleanups = [];
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const SEVDESK = "autobox@sevdesk.example";
const PAPERLESS = "bill@paperless.example";
const both: IntakeForwarding = {
  from: "hex@example.com",
  targets: [
    { name: "sevdesk", to: SEVDESK },
    { name: "paperless", to: PAPERLESS },
  ],
};
const DATED = { year: 2026, month: 10, day: 1 };

/** A mail with one PDF Document, as raw `.eml` bytes. */
const emlOf = (messageId: string | undefined, fileName = "Rechnung.pdf") =>
  buildEml(pdfMail(messageId, fileName));

/** A model call that waits until `release` is called; `reading` resolves when it was asked. */
function blockingModel() {
  const release = Promise.withResolvers<void>();
  const reading = Promise.withResolvers<void>();
  const script: Script = async () => {
    reading.resolve();
    await release.promise;
    return DATED;
  };
  return { script, reading: reading.promise, release: () => release.resolve() };
}

/** Lets everything already due run: a few turns of the event loop, no timer. */
async function flush() {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
}

/** A `workflow` wrap for {@link freshWatcher}: each run of the registered one started by `start`. */
const startingWith =
  (
    start: (
      run: IntakeRun,
      args: Parameters<IntakeRun["start"]>[0],
    ) => ReturnType<IntakeRun["start"]>,
  ) =>
  (registered: IntakeWorkflow): IntakeWorkflow => ({
    listActiveWorkflowRuns: () => registered.listActiveWorkflowRuns(),
    createRun: async () => {
      const run = await registered.createRun();
      return { runId: run.runId, start: (args) => start(run, args) };
    },
  });

/**
 * A fresh data directory with the real Intake workflow registered on a Mastra persisting runs
 * there, a recording Mailer forwarding to `forwarding`, an in-memory Mailbox (`idle: false`: the
 * server has no IMAP IDLE), and a watcher on them, not started yet. `workflow` wraps the
 * registered workflow (a run whose start rejects, say). `dateExtractor` replaces the scripted
 * one (`asked` then stays empty). The watcher's clock is the real one moved
 * forward by `clock.advance` (or set by `clock.offset`), and the ledger stamps failed runs on it;
 * it tries again at once after a failure.
 * Setting `failing.line` makes the next log line containing it throw, as a broken logger would.
 */
async function freshWatcher({
  script = () => DATED,
  dateExtractor: liveExtractor,
  forwarding,
  idle = true,
  workflow: wrap = (registered) => registered,
}: {
  script?: Script;
  dateExtractor?: Layer.Layer<DateExtractor>;
  forwarding?: IntakeForwarding;
  idle?: boolean;
  workflow?: (registered: IntakeWorkflow) => IntakeWorkflow;
} = {}) {
  const root = join(directory, `hex-${instances++}`);
  const paths = { databasePath: join(root, "mastra.db"), outboxDirectory: join(root, "outbox") };
  const { layer: scriptedExtractor, asked } = scriptedDateExtractor(script);
  const dateExtractor = liveExtractor ?? scriptedExtractor;
  const mailer = recordingMailer();
  const mainChannel = recordingMainChannel();
  const mailbox = memoryMailbox({ idle });
  const clock = { offset: 0, advance: (ms: number) => (clock.offset += ms) };
  /**
   * Set `failing` to fail every ledger write, as a full volume would; reads still work. `only`
   * narrows it to the one write method so named.
   */
  const ledgerWrites = { failing: false, only: undefined as string | undefined };
  const failingWhen =
    <A extends unknown[], R>(name: string, write: (...args: A) => Effect.Effect<R, LedgerError>) =>
    (...args: A) =>
      Effect.suspend(() =>
        ledgerWrites.failing && (ledgerWrites.only ?? name) === name
          ? Effect.fail(new LedgerError({ message: "Intake ledger: disk full" }))
          : write(...args),
      );
  /** Set `failNext` to fail the next ledger `find`, as a lock held too long would. */
  const ledgerReads = { failNext: false };
  /** The ledger stamps failed runs on the watcher's clock, so retry windows line up with it. */
  const onWatcherClock = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.clockWith((real) =>
      Effect.provideService(effect, Clock.Clock, {
        currentTimeMillisUnsafe: () => real.currentTimeMillisUnsafe() + clock.offset,
        currentTimeMillis: Effect.sync(() => real.currentTimeMillisUnsafe() + clock.offset),
        currentTimeNanosUnsafe: () => real.currentTimeNanosUnsafe(),
        currentTimeNanos: real.currentTimeNanos,
        monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: real.monotonicTimeNanos,
        sleep: (duration) => real.sleep(duration),
      }),
    );
  const ledger = Layer.effect(
    IntakeLedger,
    Effect.map(IntakeLedger, (real) => ({
      ...real,
      find: (messageId: string) =>
        Effect.suspend(() => {
          if (!ledgerReads.failNext) return real.find(messageId);
          ledgerReads.failNext = false;
          return Effect.fail(new LedgerError({ message: "Intake ledger: database is locked" }));
        }),
      record: failingWhen("record", real.record),
      recordForwarding: failingWhen("recordForwarding", real.recordForwarding),
      recordFiling: failingWhen("recordFiling", real.recordFiling),
      recordFailedRun: failingWhen("recordFailedRun", (messageId: string, runId: string) =>
        onWatcherClock(real.recordFailedRun(messageId, runId)),
      ),
      endFailedRuns: failingWhen("endFailedRuns", real.endFailedRuns),
    })),
  ).pipe(Layer.provide(intakeLedgerLayer(paths.databasePath)));
  const runtime = createIntakeRuntime(paths, {
    dateExtractor,
    mailer: mailer.layer,
    mailbox: mailbox.layer,
    mainChannel: mainChannel.layer,
    ledger,
  });
  const log: { level: string; message: string }[] = [];
  /** Lines containing it throw, once each time it is set. */
  const failing = { line: undefined as string | undefined };
  /** A logger whose methods need `this`, as Mastra's do: a detached call fails. */
  const logger = {
    lines: log,
    write(level: string, message: string) {
      if (failing.line !== undefined && message.includes(failing.line)) {
        failing.line = undefined;
        throw new Error("the logger broke");
      }
      this.lines.push({ level, message });
    },
    info(message: string) {
      this.write("info", message);
    },
    warn(message: string) {
      this.write("warn", message);
    },
    error(message: string) {
      this.write("error", message);
    },
  };
  const storage = await createLocalStore(paths.databasePath);
  await storage.init();
  const mastra = new Mastra({
    storage,
    logger: false,
    workflows: {
      // The workflow warns on the watcher's logger, as on the server, where both use Mastra's.
      [INTAKE_WORKFLOW_ID]: createIntakeWorkflow({
        runtime,
        category: "ER",
        forwarding,
        log: logger,
      }),
    },
  });
  cleanups.push(
    () => runtime.dispose(),
    () => storage.close(),
    () => mastra.shutdown(),
  );
  const registered: IntakeWorkflow = mastra.getWorkflow(INTAKE_WORKFLOW_ID);
  let watcher: MailboxWatcher | undefined;
  /** Each run the watcher started, settled (either way) when the run ends. */
  const starts: Promise<unknown>[] = [];
  /** The watcher's repeating timers, by their tick, with their interval: a test fires them. */
  const timers = new Map<() => void, number>();
  return {
    asked,
    mailer,
    mainChannel,
    mailbox,
    clock,
    failing,
    ledgerWrites,
    ledgerReads,
    starts,
    timers,
    workflow: registered,
    /** Every logged line, as `level: message`. */
    log: () => log.map(({ level, message }) => `${level}: ${message}`),
    start() {
      const wrapped = wrap(registered);
      watcher = watchMailbox({
        runtime,
        workflow: {
          listActiveWorkflowRuns: () => wrapped.listActiveWorkflowRuns(),
          createRun: async () => {
            const run = await wrapped.createRun();
            return {
              runId: run.runId,
              start: (args) => {
                const started = run.start(args);
                starts.push(started.catch(() => undefined));
                return started;
              },
            };
          },
        },
        pollMs: 60_000,
        log: logger,
        now: () => Date.now() + clock.offset,
        retryDelayAfterFailure: () => 0,
        every: (ms, tick) => {
          timers.set(tick, ms);
          return () => timers.delete(tick);
        },
      });
      cleanups.push(() => watcher!.stop());
    },
    stop: () => watcher!.stop(),
    /** Resolves once the watcher finished a scan and waits for news again. */
    scanned: () => within(mailbox.waiting(), "the watcher's scan"),
    /** Moves the clock `ms` on and waits for the look the next poll starts. */
    async lookAfter(ms: number) {
      clock.advance(ms);
      mailbox.tick();
      await within(mailbox.waiting(), "the watcher's scan");
    },
    /** Runs `program` on the Intake runtime's ledger. */
    ledger: <A, E>(program: (ledger: IntakeLedger["Service"]) => Effect.Effect<A, E>) =>
      runtime.runPromise(IntakeLedger.use(program)),
    /** The Outbox's files, relative. */
    async outbox() {
      const files = await readdir(paths.outboxDirectory, { recursive: true }).catch(() => []);
      return files.filter((file) => file.endsWith(".pdf")).sort();
    },
    /** The Intake runs in storage, by status. */
    async runs(): Promise<string[]> {
      const { runs } = await mastra.getWorkflow(INTAKE_WORKFLOW_ID).listWorkflowRuns();
      return runs.map(({ snapshot }) =>
        typeof snapshot === "string" ? snapshot : snapshot.status,
      );
    },
  };
}

describe("watchMailbox", () => {
  test("N mails, N runs: each mail processed and moved to hex/processed once", async () => {
    const hex = await freshWatcher();
    hex.mailbox.deliver(emlOf("a@shop.example", "a.pdf"));
    hex.mailbox.deliver(emlOf("b@shop.example", "b.pdf"));
    hex.mailbox.deliver(emlOf("c@shop.example", "c.pdf"));
    hex.start();
    await hex.scanned();
    expect(hex.mailbox.messageIds()).toEqual([]);
    expect(hex.mailbox.messageIds("hex/processed")).toEqual([
      "a@shop.example",
      "b@shop.example",
      "c@shop.example",
    ]);
    expect(hex.mailbox.moves).toHaveLength(3);
    expect(await hex.outbox()).toEqual([
      "2026-10/ER/a.pdf",
      "2026-10/ER/b.pdf",
      "2026-10/ER/c.pdf",
    ]);
    expect(await hex.runs()).toEqual(["success", "success", "success"]);
    expect(hex.log()).toContain(
      "info: hex: Intake b@shop.example: processed; its mail was moved to hex/processed",
    );
    // After the look, it waits for news no longer than the poll interval.
    expect(hex.mailbox.waits).toEqual([60_000]);
  });

  test("copies, re-deliveries, rescans and a reconnect: one run's effects per Intake", async () => {
    const hex = await freshWatcher({ forwarding: both });
    hex.mailbox.deliver(emlOf("dup@shop.example"));
    hex.mailbox.deliver(emlOf("dup@shop.example"));
    hex.start();
    await hex.scanned();
    // Both copies went with the one run.
    expect(hex.mailbox.messageIds("hex/processed")).toEqual([
      "dup@shop.example",
      "dup@shop.example",
    ]);

    // Re-delivered: IDLE says so, the rescan only moves it.
    hex.mailbox.deliver(emlOf("dup@shop.example"));
    await hex.scanned();
    // The connection drops while the watcher waits; two reconnects fail, the third works and
    // rescans. Delivered meanwhile, the mail is picked up then.
    hex.mailbox.disconnect(2);
    hex.mailbox.deliver(emlOf("dup@shop.example"));
    await hex.scanned();

    expect(hex.mailbox.messageIds()).toEqual([]);
    expect(hex.mailbox.messageIds("hex/processed")).toHaveLength(4);
    expect(hex.mailer.sent.map(({ to }) => to)).toEqual([SEVDESK, PAPERLESS]);
    expect(await hex.outbox()).toEqual(["2026-10/ER/Rechnung.pdf"]);
    expect(hex.asked).toHaveLength(1);
    expect(await hex.runs()).toEqual(["success"]);
    const retries = hex.log().filter((line) => line.includes("trying again"));
    expect(retries).toHaveLength(3);
    expect(retries[2]).toContain("connection lost; trying again in 0 s (attempt 3)");
  });

  test("a mail that can't become an Intake goes to hex/failed without a run", async () => {
    const hex = await freshWatcher();
    hex.mailbox.deliver(emlOf(undefined));
    hex.mailbox.deliver(new TextEncoder().encode("not a mail"));
    // `Message-ID: <<>>`: blank once its brackets are off, as anyone can send.
    hex.mailbox.deliver(emlOf("<>"));
    hex.start();
    await hex.scanned();
    expect(hex.mailbox.messageIds()).toEqual([]);
    expect(hex.mailbox.moves.map(({ to }) => to)).toEqual([
      "hex/failed",
      "hex/failed",
      "hex/failed",
    ]);
    expect(hex.asked).toEqual([]);
    expect(await hex.runs()).toEqual([]);
    expect(hex.log()).toContain(
      "warn: hex: mailbox: INBOX UID 1: no usable Message-ID (missing, or blank without its brackets and comments), so the Intake can't be processed exactly once; moving it to hex/failed",
    );
    expect(hex.log()).toContain(
      "warn: hex: mailbox: INBOX UID 3: no usable Message-ID (missing, or blank without its brackets and comments), so the Intake can't be processed exactly once; moving it to hex/failed",
    );
  });

  test("a failed Intake is retried only once its delay passed, the delay doubling", async () => {
    let failures = 2;
    const hex = await freshWatcher({
      script: () => (failures-- > 0 ? new Error("rate limited (429)") : DATED),
    });
    hex.mailbox.deliver(emlOf("retry@shop.example"));
    hex.start();
    await hex.scanned();
    expect(hex.asked).toHaveLength(1);
    expect(hex.mailbox.messageIds()).toEqual(["retry@shop.example"]);
    expect(hex.log().at(-1)).toContain("failed run 1 of 5");

    // A poll 4 minutes later: too early.
    hex.clock.advance(4 * 60_000);
    hex.mailbox.tick();
    await hex.scanned();
    expect(hex.asked).toHaveLength(1);

    // 5 minutes after the failure: retried, and failing again.
    hex.clock.advance(60_000);
    hex.mailbox.tick();
    await hex.scanned();
    expect(hex.asked).toHaveLength(2);
    expect(hex.log().at(-1)).toContain("failed run 2 of 5");

    // 9 minutes after the second failure is too early; 10: retried, processed, moved.
    hex.clock.advance(9 * 60_000);
    hex.mailbox.tick();
    await hex.scanned();
    expect(hex.asked).toHaveLength(2);
    hex.clock.advance(60_000);
    hex.mailbox.tick();
    await hex.scanned();
    expect(hex.asked).toHaveLength(3);
    expect(hex.mailbox.messageIds("hex/processed")).toEqual(["retry@shop.example"]);
  });

  test("without IMAP IDLE, new mail waits for the poll interval", async () => {
    const hex = await freshWatcher({ idle: false });
    hex.start();
    await hex.scanned();
    hex.mailbox.deliver(emlOf("polled@shop.example"));
    // No notification: the watcher still waits in the same wait, the mail untouched.
    await hex.scanned();
    expect(hex.mailbox.messageIds()).toEqual(["polled@shop.example"]);
    hex.mailbox.tick();
    await hex.scanned();
    expect(hex.mailbox.messageIds("hex/processed")).toEqual(["polled@shop.example"]);
    expect(hex.mailbox.waits).toEqual([60_000, 60_000]);
  });

  test("an Intake with a run active in storage gets no second run, the skip logged once", async () => {
    const model = blockingModel();
    const hex = await freshWatcher({ script: model.script });
    const mail = emlOf("active@shop.example");
    // A run started elsewhere (resumed after a restart, say), still reading the Document date.
    const intake: Intake = await Effect.runPromise(readEml(mail, "active.eml"));
    const run = await hex.workflow.createRun();
    const result = run.start({ inputData: intake });
    await within(model.reading, "the run reading the Document date");
    hex.mailbox.deliver(mail);
    hex.start();
    await hex.scanned();
    hex.mailbox.tick();
    await hex.scanned();
    expect(hex.mailbox.messageIds()).toEqual(["active@shop.example"]);
    expect(hex.asked).toHaveLength(1);
    expect(hex.log().filter((line) => line.includes("is active"))).toEqual([
      `warn: hex: Intake active@shop.example: its run ${run.runId} is active; its mail is left to that run until the run ends or hex restarts`,
    ]);

    model.release();
    expect(await within(result, "the active run")).toMatchObject({ status: "success" });
    expect(hex.mailbox.messageIds("hex/processed")).toEqual(["active@shop.example"]);
    expect(await hex.runs()).toEqual(["success"]);
  });

  describe("a mail whose Message-ID the server reads differently from hex", () => {
    const SERVER_VIEW = { serverMessageId: "server-view@shop.example" };

    test("is processed, then moved by its UID", async () => {
      const hex = await freshWatcher();
      hex.mailbox.deliver(emlOf("diverging@shop.example"), SERVER_VIEW);
      hex.start();
      await hex.scanned();
      expect(hex.mailbox.messageIds()).toEqual([]);
      expect(hex.mailbox.messageIds("hex/processed")).toEqual(["server-view@shop.example"]);
      expect(hex.log()).toContain(
        "info: hex: Intake diverging@shop.example: processed; its mail was moved to hex/processed",
      );
    });

    test("waits for its retry, by hex's Message-ID", async () => {
      let failing = true;
      const hex = await freshWatcher({
        script: () => (failing ? new Error("rate limited (429)") : DATED),
      });
      hex.mailbox.deliver(emlOf("diverging-retry@shop.example"), SERVER_VIEW);
      hex.start();
      await hex.scanned();
      failing = false;
      hex.mailbox.tick();
      await hex.scanned();
      expect(hex.asked).toHaveLength(1);
      expect(hex.mailbox.messageIds()).toEqual(["server-view@shop.example"]);
    });

    test("gets no second run beside an active one, nor for a second copy", async () => {
      const model = blockingModel();
      const hex = await freshWatcher({ script: model.script });
      const mail = emlOf("diverging-active@shop.example");
      const run = await hex.workflow.createRun();
      const result = run.start({ inputData: await Effect.runPromise(readEml(mail, "a.eml")) });
      await within(model.reading, "the run reading the Document date");
      hex.mailbox.deliver(mail, SERVER_VIEW);
      hex.mailbox.deliver(mail, SERVER_VIEW);
      hex.start();
      await hex.scanned();
      expect(hex.asked).toHaveLength(1);
      model.release();
      await within(result, "the active run");
      // The run finished: the next looks find the Intake processed and move both copies, one
      // per look (the second copy is passed over in the look that settles the first).
      hex.mailbox.tick();
      await hex.scanned();
      hex.mailbox.tick();
      await hex.scanned();
      expect(hex.mailbox.messageIds()).toEqual([]);
      expect(hex.mailbox.messageIds("hex/processed")).toHaveLength(2);
      expect(hex.asked).toHaveLength(1);
      expect(await hex.runs()).toEqual(["success"]);
    });

    test("a second copy in the look is passed over: no run, nor a move as already processed", async () => {
      const hex = await freshWatcher();
      hex.mailbox.deliver(emlOf("diverging-copies@shop.example"), SERVER_VIEW);
      hex.mailbox.deliver(emlOf("diverging-copies@shop.example"), SERVER_VIEW);
      hex.start();
      await hex.scanned();
      expect(hex.asked).toHaveLength(1);
      // The run moved its own copy by UID; the second waits for the next look.
      expect(hex.mailbox.messageIds()).toEqual(["server-view@shop.example"]);
      expect(hex.log()).not.toContainEqual(expect.stringContaining("already processed"));
      hex.mailbox.tick();
      await hex.scanned();
      expect(hex.mailbox.messageIds("hex/processed")).toHaveLength(2);
      expect(hex.log()).toContain(
        "info: hex: Intake diverging-copies@shop.example: already processed; its mail was moved to hex/processed",
      );
      expect(hex.asked).toHaveLength(1);
    });

    test("a move by UID a stale listing fails is a warning and ends the look; the next look moves the mail, no second run", async () => {
      const model = blockingModel();
      const hex = await freshWatcher({ script: model.script });
      hex.mailbox.deliver(emlOf("diverging-stuck@shop.example"), SERVER_VIEW);
      hex.start();
      await within(model.reading, "the run reading its Document date");
      // The UIDs change meaning during the run: its listing's UID can't be moved.
      hex.mailbox.renumber();
      model.release();
      await hex.scanned();
      expect(hex.log()).toContainEqual(
        expect.stringMatching(
          /^warn: hex: Intake diverging-stuck@shop\.example: processed; moving its mail to hex\/processed failed \(.*UIDVALIDITY.*\)$/,
        ),
      );
      expect(hex.log()).toContainEqual(
        expect.stringMatching(
          /^warn: hex: mailbox: UID 1 \(server-view@shop\.example as the server reads it\): .*UIDVALIDITY.*; trying again in 0 s \(attempt 1\)$/,
        ),
      );
      // Tried again at once, without waiting for news.
      expect(hex.mailbox.messageIds("hex/processed")).toEqual(["server-view@shop.example"]);
      expect(hex.mailbox.waits).toEqual([60_000]);
      expect(hex.asked).toHaveLength(1);
    });

    test("a report that can't be posted is still a warning when the move by UID ends the look", async () => {
      const model = blockingModel();
      const hex = await freshWatcher({ script: model.script });
      hex.mainChannel.failNext();
      hex.mailbox.deliver(emlOf("diverging-unreported@shop.example"), SERVER_VIEW);
      hex.start();
      await within(model.reading, "the run reading its Document date");
      hex.mailbox.renumber();
      model.release();
      await hex.scanned();
      expect(hex.log()).toContainEqual(
        expect.stringMatching(/^warn: hex: mailbox: UID 1 .*UIDVALIDITY.*\(attempt 1\)$/),
      );
      // Warned once, by the run that posted it.
      expect(
        hex
          .log()
          .filter(
            (line) =>
              line ===
              "warn: hex: Intake diverging-unreported@shop.example: its Intake report was not posted: posting to slack failed: channel_not_found",
          ),
      ).toHaveLength(1);
    });

    test("its 5th failed run moves it to hex/failed by UID; no 6th run", async () => {
      const hex = await freshWatcher({ script: () => new Error("rate limited (429)") });
      hex.mailbox.deliver(emlOf("diverging-failing@shop.example"), SERVER_VIEW);
      hex.start();
      await hex.scanned();
      for (let run = 2; run <= 6; run++) {
        // Well past any retry delay, measured from the real time of the last failure.
        hex.clock.offset = run * 60 * 60_000;
        hex.mailbox.tick();
        await hex.scanned();
      }
      expect(hex.asked).toHaveLength(5);
      expect(hex.mailbox.messageIds()).toEqual([]);
      expect(hex.mailbox.messageIds("hex/failed")).toEqual(["server-view@shop.example"]);
      expect(hex.log()).toContain(
        "warn: hex: Intake diverging-failing@shop.example: failed permanently; its mail was moved to hex/failed",
      );
      // The run found no mail by its Message-ID; the watcher moved it by UID after the report.
      expect(hex.mainChannel.posted.at(-1)?.split("\n").at(-1)).toBe(
        "Failed run 5 of 5: failed permanently, its mail was not found by its Message-ID in the watched folder; see the hex log.",
      );
    });
  });

  test("a failed move is a warning; the next look only moves the mail, no second run", async () => {
    const hex = await freshWatcher();
    hex.mailbox.refuse("moving mail to hex/processed");
    hex.mailbox.deliver(emlOf("stuck@shop.example"));
    hex.start();
    await hex.scanned();
    expect(hex.mailbox.messageIds()).toEqual(["stuck@shop.example"]);
    expect(hex.log()).toContainEqual(
      expect.stringMatching(
        /^warn: hex: Intake stuck@shop\.example: processed; moving its mail to hex\/processed failed \(.*\[NOPERM\]/,
      ),
    );
    hex.mailbox.tick();
    await hex.scanned();
    expect(hex.mailbox.messageIds("hex/processed")).toEqual(["stuck@shop.example"]);
    expect(hex.asked).toHaveLength(1);
    expect(await hex.runs()).toEqual(["success"]);
  });

  test("an Intake at its failed-run limit without having failed permanently goes to hex/failed, no run", async () => {
    const hex = await freshWatcher();
    // The process died between counting the 5th failure and ending the count.
    await hex.ledger((ledger) =>
      Effect.forEach(["r1", "r2", "r3", "r4", "r5"], (run) =>
        ledger.recordFailedRun("limit@shop.example", run),
      ),
    );
    hex.mailbox.deliver(emlOf("limit@shop.example"));
    hex.start();
    await hex.scanned();
    expect(hex.mailbox.messageIds("hex/failed")).toEqual(["limit@shop.example"]);
    expect(hex.asked).toEqual([]);
    // The move by UID that follows finds nothing at the UID: no line of its own.
    expect(hex.log().filter((line) => line.includes("limit@shop.example"))).toEqual([
      "warn: hex: Intake limit@shop.example: failed permanently; its mail was moved to hex/failed",
    ]);
  });

  test("an Intake at its failed-run limit whose move to hex/failed is refused warns of it before the move is tried again", async () => {
    const hex = await freshWatcher();
    await hex.ledger((ledger) =>
      Effect.forEach(["r1", "r2", "r3", "r4", "r5"], (run) =>
        ledger.recordFailedRun("limit-refused@shop.example", run),
      ),
    );
    hex.mailbox.refuse("moving mail to hex/failed");
    hex.mailbox.deliver(emlOf("limit-refused@shop.example"));
    hex.start();
    await hex.scanned();
    expect(hex.mailbox.messageIds("hex/failed")).toEqual(["limit-refused@shop.example"]);
    expect(hex.asked).toEqual([]);
    expect(hex.log().filter((line) => line.includes("limit-refused@shop.example"))).toEqual([
      expect.stringMatching(
        /^warn: hex: Intake limit-refused@shop\.example: failed permanently; moving its mail to hex\/failed failed \(.*NOPERM.*\); the mailbox watcher, if it started the run, tries the move once more; failing that, it runs it afresh \(a new series of 5 runs\) at its next look$/s,
      ),
      "warn: hex: Intake limit-refused@shop.example: failed permanently; its mail was moved to hex/failed",
    ]);
  });

  test("an Intake at its failed-run limit whose move to hex/failed went through though its answer was lost warns of the failed move", async () => {
    const hex = await freshWatcher();
    await hex.ledger((ledger) =>
      Effect.forEach(["r1", "r2", "r3", "r4", "r5"], (run) =>
        ledger.recordFailedRun("limit-lost@shop.example", run),
      ),
    );
    hex.mailbox.loseReply("moving mail to hex/failed");
    hex.mailbox.deliver(emlOf("limit-lost@shop.example"));
    hex.start();
    await hex.scanned();
    expect(hex.mailbox.messageIds("hex/failed")).toEqual(["limit-lost@shop.example"]);
    expect(hex.asked).toEqual([]);
    // The settled line alone would not say why the move failed.
    expect(hex.log().filter((line) => line.includes("limit-lost@shop.example"))).toEqual([
      expect.stringMatching(
        /^warn: hex: Intake limit-lost@shop\.example: failed permanently; moving its mail to hex\/failed failed \(.+\); the mailbox watcher, if it started the run, tries the move once more; failing that, it runs it afresh \(a new series of 5 runs\) at its next look$/s,
      ),
      "warn: hex: Intake limit-lost@shop.example: failed permanently; no mail of it was left in the watched folder (the failed move likely went through; see hex/failed)",
    ]);
  });

  test("an Intake at its failed-run limit still goes to hex/failed when the warning of its refused move throws", async () => {
    const hex = await freshWatcher();
    await hex.ledger((ledger) =>
      Effect.forEach(["r1", "r2", "r3", "r4", "r5"], (run) =>
        ledger.recordFailedRun("limit-broken@shop.example", run),
      ),
    );
    hex.mailbox.refuse("moving mail to hex/failed");
    hex.failing.line = "tries the move once more";
    hex.mailbox.deliver(emlOf("limit-broken@shop.example"));
    hex.start();
    await hex.scanned();
    expect(hex.mailbox.messageIds()).toEqual([]);
    expect(hex.mailbox.messageIds("hex/failed")).toEqual(["limit-broken@shop.example"]);
    expect(hex.mailbox.messageIds("hex/processed")).toEqual([]);
    expect(hex.asked).toEqual([]);
    expect(hex.log()).toContainEqual(
      expect.stringMatching(
        /^error: hex: mailbox: the watcher failed unexpectedly: .*the logger broke/s,
      ),
    );
  });

  test("an Intake at its failed-run limit whose move fails for good ends the look with the mailbox error, not the warning's logger defect", async () => {
    const hex = await freshWatcher();
    await hex.ledger((ledger) =>
      Effect.forEach(["r1", "r2", "r3", "r4", "r5"], (run) =>
        ledger.recordFailedRun("limit-gone@shop.example", run),
      ),
    );
    hex.mailbox.refuse("moving mail to hex/failed");
    // The warning of the refused move throws, and the connection drops as it does: both moves
    // that settle the mail (by Message-ID, then by UID) fail with it.
    let line: string | undefined = "tries the move once more";
    Object.defineProperty(hex.failing, "line", {
      get: () => line,
      set: (next: string | undefined) => {
        line = next;
        hex.mailbox.disconnect(2);
      },
    });
    hex.mailbox.deliver(emlOf("limit-gone@shop.example"));
    hex.start();
    await hex.scanned();
    expect(hex.mailbox.operations.slice(2, 5)).toEqual([
      "moving mail to hex/failed",
      "moving mail to hex/failed",
      "moving mail to hex/failed",
    ]);
    expect(hex.log()).toContainEqual(
      expect.stringMatching(
        /^warn: hex: mailbox: UID 1 \(limit-gone@shop\.example as the server reads it\): .*folder INBOX: moving mail to hex\/failed failed: connection lost; trying again in 0 s \(attempt 1\)$/,
      ),
    );
    expect(hex.log().some((line) => line.includes("the logger broke"))).toBe(false);
  });

  /**
   * An always-failing Intake `messageId` driven to its 5th failed run, `atFifth` done to the
   * mailbox just before it.
   */
  async function toFifthFailure(
    messageId: string,
    atFifth: (mailbox: ReturnType<typeof memoryMailbox>) => void,
  ) {
    const hex = await freshWatcher({ script: () => new Error("rate limited (429)") });
    hex.mailbox.deliver(emlOf(messageId));
    hex.start();
    await hex.scanned();
    for (let run = 2; run <= 5; run++) {
      if (run === 5) atFifth(hex.mailbox);
      // Well past any retry delay, measured from the real time of the last failure.
      hex.clock.offset = run * 60 * 60_000;
      hex.mailbox.tick();
      await hex.scanned();
    }
    expect(hex.asked).toHaveLength(5);
    return hex;
  }

  test("a failed move to hex/failed is tried once more", async () => {
    const hex = await toFifthFailure("move-once@shop.example", (mailbox) =>
      mailbox.refuse("moving mail to hex/failed"),
    );
    expect(hex.mailbox.messageIds("hex/failed")).toEqual(["move-once@shop.example"]);
    // The run's line says what comes; the watcher's, what came of it.
    expect(hex.log()).toContainEqual(
      expect.stringMatching(
        /^warn: hex: Intake move-once@shop\.example: the run failed: .*failed run 5 of 5, so the Intake failed permanently: moving its mail to hex\/failed failed \(.*NOPERM.*\); the mailbox watcher, if it started the run, tries the move once more; failing that, it runs it afresh \(a new series of 5 runs\) at its next look$/s,
      ),
    );
    expect(hex.log()).toContain(
      "warn: hex: Intake move-once@shop.example: failed permanently; its mail was moved to hex/failed",
    );
  });

  test("a failed move to hex/failed is tried again by Message-ID: every copy goes, no fresh series", async () => {
    const hex = await freshWatcher({ script: () => new Error("rate limited (429)") });
    hex.mailbox.deliver(emlOf("two-copies@shop.example"));
    hex.mailbox.deliver(emlOf("two-copies@shop.example"));
    hex.start();
    await hex.scanned();
    for (let run = 2; run <= 5; run++) {
      if (run === 5) hex.mailbox.refuse("moving mail to hex/failed");
      hex.clock.offset = run * 60 * 60_000;
      hex.mailbox.tick();
      await hex.scanned();
    }
    // A retry by UID alone would leave the copy the watcher didn't look at, its count ended.
    expect(hex.mailbox.messageIds()).toEqual([]);
    expect(hex.mailbox.messageIds("hex/failed")).toEqual([
      "two-copies@shop.example",
      "two-copies@shop.example",
    ]);
    hex.mailbox.tick();
    await hex.scanned();
    expect(hex.asked).toHaveLength(5);
  });

  test("a move to hex/failed failing every retry says the Intake is run afresh at the next look", async () => {
    // The run's move, then the watcher's by Message-ID and by UID.
    const hex = await toFifthFailure("move-never@shop.example", (mailbox) =>
      mailbox.refuse("moving mail to hex/failed", 3),
    );
    expect(hex.mailbox.messageIds()).toEqual(["move-never@shop.example"]);
    expect(hex.log()).toContainEqual(
      expect.stringMatching(
        /^warn: hex: Intake move-never@shop\.example: failed permanently; moving its mail to hex\/failed failed \(.*NOPERM.*\); the mailbox watcher runs it afresh \(a new series of 5 runs\) at its next look$/,
      ),
    );
    hex.mailbox.tick();
    await hex.scanned();
    expect(hex.asked).toHaveLength(6);
  });

  test("a move to hex/failed that went through though its answer was lost promises no fresh runs", async () => {
    const hex = await toFifthFailure("move-lost@shop.example", (mailbox) =>
      mailbox.loseReply("moving mail to hex/failed"),
    );
    expect(hex.mailbox.messageIds("hex/failed")).toEqual(["move-lost@shop.example"]);
    expect(hex.log().at(-1)).toBe(
      "warn: hex: Intake move-lost@shop.example: failed permanently; no mail of it was left in the watched folder (the failed move likely went through; see hex/failed)",
    );
    hex.mailbox.tick();
    await hex.scanned();
    expect(hex.asked).toHaveLength(5);
  });

  test("a move to hex/failed that found the mail gone already gets no second line", async () => {
    let calls = 0;
    let atFifth = () => {};
    const hex = await freshWatcher({
      script: () => {
        if (++calls === 5) atFifth();
        return new Error("rate limited (429)");
      },
    });
    // A person deletes the mail while the 5th run reads its Document date.
    atFifth = () => hex.mailbox.discard(1);
    hex.mailbox.deliver(emlOf("gone@shop.example"));
    hex.start();
    await hex.scanned();
    for (let run = 2; run <= 5; run++) {
      hex.clock.offset = run * 60 * 60_000;
      hex.mailbox.tick();
      await hex.scanned();
    }
    expect(hex.asked).toHaveLength(5);
    const permanent = hex.log().filter((line) => line.includes("failed permanently"));
    expect(permanent).toEqual([
      expect.stringMatching(
        /^warn: hex: Intake gone@shop\.example: the run failed: .*no mail of it was in the watched folder$/s,
      ),
    ]);
  });

  test("after a permanent failure, a copy the server reads differently goes to hex/failed too", async () => {
    const hex = await freshWatcher({ script: () => new Error("rate limited (429)") });
    // First the copy only hex reads as the Intake, so its UID is the one looked at.
    hex.mailbox.deliver(emlOf("two-views@shop.example"), {
      serverMessageId: "server-view@shop.example",
    });
    hex.mailbox.deliver(emlOf("two-views@shop.example"));
    hex.start();
    await hex.scanned();
    for (let run = 2; run <= 5; run++) {
      hex.clock.offset = run * 60 * 60_000;
      hex.mailbox.tick();
      await hex.scanned();
    }
    expect(hex.mailbox.messageIds()).toEqual([]);
    expect(hex.mailbox.messageIds("hex/failed")).toEqual([
      "two-views@shop.example",
      "server-view@shop.example",
    ]);
    // The run's line told the move by Message-ID; the copy moved by UID gets one of its own.
    expect(hex.log().filter((line) => line.includes("UID 1"))).toEqual([
      "warn: hex: Intake two-views@shop.example: its mail at UID 1, a copy the server reads with another Message-ID, was moved to hex/failed too",
    ]);
    hex.mailbox.tick();
    await hex.scanned();
    expect(hex.asked).toHaveLength(5);
  });

  describe("an Intake at its failed-run limit with a copy the server reads differently", () => {
    /**
     * A watcher whose first look finds `limit-copy@shop.example` at its failed-run limit: first
     * the copy only hex reads as the Intake (UID 1, looked at), then one the server reads alike.
     * `atFollowUp` is done to the mailbox just before the move by UID that follows the move by
     * Message-ID.
     */
    async function atLimitWithCopy(
      atFollowUp?: (mailbox: ReturnType<typeof memoryMailbox>) => void,
    ) {
      const hex = await freshWatcher();
      await hex.ledger((ledger) =>
        Effect.forEach(["r1", "r2", "r3", "r4", "r5"], (run) =>
          ledger.recordFailedRun("limit-copy@shop.example", run),
        ),
      );
      hex.mailbox.deliver(emlOf("limit-copy@shop.example"), {
        serverMessageId: "server-view@shop.example",
      });
      hex.mailbox.deliver(emlOf("limit-copy@shop.example"));
      if (atFollowUp)
        hex.mailbox.before("moving mail to hex/failed", 1, () => atFollowUp(hex.mailbox));
      hex.start();
      await hex.scanned();
      return hex;
    }
    const MAIN =
      "warn: hex: Intake limit-copy@shop.example: failed permanently; its mail was moved to hex/failed";

    test("the copy moved by UID too gets a line of its own", async () => {
      const hex = await atLimitWithCopy();
      expect(hex.mailbox.messageIds()).toEqual([]);
      expect(hex.log().filter((line) => line.includes("limit-copy@shop.example"))).toEqual([
        MAIN,
        "warn: hex: Intake limit-copy@shop.example: its mail at UID 1, a copy the server reads with another Message-ID, was moved to hex/failed too",
      ]);
      expect(hex.asked).toEqual([]);
    });

    test("a refused move by UID is a warning: the copy stays and runs afresh at the next look", async () => {
      const hex = await atLimitWithCopy((mailbox) => mailbox.refuse("moving mail to hex/failed"));
      expect(hex.mailbox.messageIds()).toEqual(["server-view@shop.example"]);
      expect(hex.log().filter((line) => line.includes("limit-copy@shop.example"))).toEqual([
        MAIN,
        expect.stringMatching(
          /^warn: hex: Intake limit-copy@shop\.example: any mail still at UID 1 \(a copy the server reads with another Message-ID\) couldn't be moved to hex\/failed \(.*NOPERM.*\); if one is there, the mailbox watcher runs it afresh \(a new series of 5 runs\) at its next look$/,
        ),
      ]);
      expect(hex.asked).toEqual([]);
      hex.mailbox.tick();
      await hex.scanned();
      expect(hex.asked).toHaveLength(1);
    });

    test("a move by UID the lost connection fails is a warning before the look ends; the next look runs the copy afresh", async () => {
      const hex = await atLimitWithCopy((mailbox) => mailbox.disconnect(1));
      const log = hex.log();
      const ended = log.findIndex((line) =>
        /^warn: hex: mailbox: UID 1 \(server-view@shop\.example as the server reads it\): .*moving mail to hex\/failed failed: connection lost; trying again in 0 s \(attempt 1\)$/.test(
          line,
        ),
      );
      expect(ended).toBeGreaterThanOrEqual(0);
      expect(
        log.slice(0, ended).filter((line) => line.includes("limit-copy@shop.example")),
      ).toEqual([
        MAIN,
        expect.stringMatching(
          /^warn: hex: Intake limit-copy@shop\.example: any mail still at UID 1 \(a copy the server reads with another Message-ID\) couldn't be moved to hex\/failed \(.*connection lost\); if one is there, the mailbox watcher runs it afresh \(a new series of 5 runs\) at its next look$/,
        ),
      ]);
      // The look after the failure ran the copy afresh.
      expect(hex.asked).toHaveLength(1);
      expect(hex.mailbox.messageIds("hex/processed")).toEqual(["server-view@shop.example"]);
    });
  });

  test("a move by UID the lost connection fails after the mail went by Message-ID warns without claiming a copy", async () => {
    const hex = await freshWatcher();
    await hex.ledger((ledger) =>
      Effect.forEach(["r1", "r2", "r3", "r4", "r5"], (run) =>
        ledger.recordFailedRun("solo@shop.example", run),
      ),
    );
    hex.mailbox.deliver(emlOf("solo@shop.example"));
    hex.mailbox.before("moving mail to hex/failed", 1, () => hex.mailbox.disconnect(1));
    hex.start();
    await hex.scanned();
    expect(hex.mailbox.messageIds()).toEqual([]);
    expect(hex.mailbox.messageIds("hex/failed")).toEqual(["solo@shop.example"]);
    expect(hex.log().filter((line) => line.startsWith("warn: hex: Intake solo@"))).toEqual([
      "warn: hex: Intake solo@shop.example: failed permanently; its mail was moved to hex/failed",
      expect.stringMatching(
        /^warn: hex: Intake solo@shop\.example: any mail still at UID 1 \(a copy the server reads with another Message-ID\) couldn't be moved to hex\/failed \(.*connection lost\); if one is there, the mailbox watcher runs it afresh \(a new series of 5 runs\) at its next look$/,
      ),
    ]);
    expect(hex.asked).toEqual([]);
  });

  test("after a permanent failure, a refused move by UID of a copy the server reads differently is the watcher's only line", async () => {
    const hex = await freshWatcher({ script: () => new Error("rate limited (429)") });
    // First the copy only hex reads as the Intake, so its UID is the one looked at.
    hex.mailbox.deliver(emlOf("two-views@shop.example"), {
      serverMessageId: "server-view@shop.example",
    });
    hex.mailbox.deliver(emlOf("two-views@shop.example"));
    hex.start();
    await hex.scanned();
    for (let run = 2; run <= 5; run++) {
      if (run === 5) {
        hex.mailbox.before("moving mail to hex/failed", 1, () =>
          hex.mailbox.refuse("moving mail to hex/failed"),
        );
      }
      hex.clock.offset = run * 60 * 60_000;
      hex.mailbox.tick();
      await hex.scanned();
    }
    expect(hex.mailbox.messageIds()).toEqual(["server-view@shop.example"]);
    expect(hex.mailbox.messageIds("hex/failed")).toEqual(["two-views@shop.example"]);
    // The run's own line told the move by Message-ID; the watcher adds only the follow-up's.
    expect(
      hex
        .log()
        .filter((line) => line.includes("two-views@"))
        .slice(-2),
    ).toEqual([
      "warn: hex: Intake two-views@shop.example: the run failed: filing: rate limited (429); failed run 5 of 5, so the Intake failed permanently: its mail was moved to hex/failed",
      expect.stringMatching(
        /^warn: hex: Intake two-views@shop\.example: any mail still at UID 1 \(a copy the server reads with another Message-ID\) couldn't be moved to hex\/failed \(.*NOPERM.*\); if one is there, the mailbox watcher runs it afresh \(a new series of 5 runs\) at its next look$/,
      ),
    ]);
  });

  test("failed runs the ledger can't count back off 5, 10, 20, 40 min in memory; the 5th stops the Intake until a restart", async () => {
    const hex = await freshWatcher({ script: () => new Error("rate limited (429)") });
    hex.ledgerWrites.failing = true;
    hex.mailbox.deliver(emlOf("uncountable@shop.example"));
    hex.start();
    await hex.scanned();
    expect(hex.asked).toHaveLength(1);
    for (const [failedRuns, delay] of [
      [1, 5],
      [2, 10],
      [3, 20],
      [4, 40],
    ] as const) {
      expect(hex.log()).toContain(
        `error: hex: Intake uncountable@shop.example: its failed run could not be counted (Intake ledger: disk full); failed run ${failedRuns} of 5, held back ${delay} min in memory`,
      );
      // A minute short of the delay: held back; at it: run again.
      await hex.lookAfter((delay - 1) * 60_000);
      expect(hex.asked).toHaveLength(failedRuns);
      await hex.lookAfter(60_000);
      expect(hex.asked).toHaveLength(failedRuns + 1);
    }
    const stopped =
      "error: hex: Intake uncountable@shop.example: its failed run could not be counted (Intake ledger: disk full); failed run 5 of 5, but the ledger can't record failed runs to fail it permanently, so hex runs it no more until it restarts; its mail stays in the watched folder, and a restart retries it";
    expect(hex.log().filter((line) => line === stopped)).toHaveLength(1);
    // Hours of looks later: no 6th run, no second line, the mail still waiting.
    for (let hour = 0; hour < 4; hour++) await hex.lookAfter(60 * 60_000);
    expect(hex.asked).toHaveLength(5);
    expect(hex.log().filter((line) => line.startsWith("error:"))).toHaveLength(5);
    expect(hex.mailbox.messageIds()).toEqual(["uncountable@shop.example"]);
    // A restart (a new watcher) runs it again, counting from the ledger's 0 afresh.
    await hex.stop();
    hex.mailbox.reopen();
    hex.start();
    await hex.scanned();
    expect(hex.asked).toHaveLength(6);
    const first =
      "error: hex: Intake uncountable@shop.example: its failed run could not be counted (Intake ledger: disk full); failed run 1 of 5, held back 5 min in memory";
    expect(hex.log().filter((line) => line === first)).toHaveLength(2);
    await hex.lookAfter(4 * 60_000);
    expect(hex.asked).toHaveLength(6);
    await hex.lookAfter(60_000);
    expect(hex.asked).toHaveLength(7);
  });

  test("the failed runs the ledger counted add to those it couldn't", async () => {
    let fail = true;
    const hex = await freshWatcher({
      script: () => (fail ? new Error("rate limited (429)") : DATED),
    });
    hex.mailbox.deliver(emlOf("half-counted@shop.example"));
    hex.start();
    await hex.scanned();
    // Counted by the ledger: run 1; the next, 5 min later, isn't.
    hex.ledgerWrites.failing = true;
    await hex.lookAfter(5 * 60_000);
    expect(hex.asked).toHaveLength(2);
    expect(hex.log()).toContain(
      "error: hex: Intake half-counted@shop.example: its failed run could not be counted (Intake ledger: disk full); failed run 2 of 5, held back 10 min in memory",
    );
    await hex.lookAfter(9 * 60_000);
    expect(hex.asked).toHaveLength(2);
    // Run 3, at 10 min, succeeds once the ledger writes again: processed.
    hex.ledgerWrites.failing = false;
    fail = false;
    await hex.lookAfter(60_000);
    expect(hex.asked).toHaveLength(3);
    expect(hex.mailbox.messageIds("hex/processed")).toEqual(["half-counted@shop.example"]);
  });

  test("once the ledger writes again, the effective count goes on: the 5th failed run fails it permanently; moved back, a fresh series", async () => {
    const hex = await freshWatcher({ script: () => new Error("rate limited (429)") });
    hex.ledgerWrites.failing = true;
    hex.mailbox.deliver(emlOf("flapping@shop.example"));
    hex.start();
    await hex.scanned();
    // Runs 1 and 2 counted in memory, 3 to 5 by the ledger again; on schedule throughout.
    for (const [failedRuns, delay] of [
      [1, 5],
      [2, 10],
      [3, 20],
      [4, 40],
    ] as const) {
      if (failedRuns === 2) hex.ledgerWrites.failing = false;
      await hex.lookAfter((delay - 1) * 60_000);
      expect(hex.asked).toHaveLength(failedRuns);
      await hex.lookAfter(60_000);
      expect(hex.asked).toHaveLength(failedRuns + 1);
    }
    expect(hex.log()).toContain(
      "warn: hex: Intake flapping@shop.example: failed run 4 of 5, 2 of them counted in memory: any mail of it in the watched folder stays there; the mailbox watcher runs it again no sooner than 40 min from now",
    );
    expect(hex.log()).toContain(
      "warn: hex: Intake flapping@shop.example: failed run 5 of 5, 2 of them counted in memory: the mailbox watcher fails it permanently at its next look",
    );
    await hex.lookAfter(60_000);
    expect(hex.asked).toHaveLength(5);
    expect(hex.mailbox.messageIds("hex/failed")).toEqual(["flapping@shop.example"]);
    // Each report counts as the watcher does: runs 3 to 5 by their effective count, the 5th
    // failing permanently at the next look, as it did.
    expect(hex.mainChannel.posted.map((report) => report.split("\n").at(-1))).toEqual([
      "Recording or ending the failed runs failed (`Intake ledger: disk full`); see the hex log.",
      "Recording or ending the failed runs failed (`Intake ledger: disk full`); see the hex log.",
      "Failed run 3 of 5: hex tries again in 20 min at the earliest, if its mail is still in the watched folder.",
      "Failed run 4 of 5: hex tries again in 40 min at the earliest, if its mail is still in the watched folder.",
      "Failed run 5 of 5: hex fails it permanently at its next look of the mailbox, its mail going to hex/failed then, unless that fails; see the hex log.",
    ]);
    // Moved back: run at once, its failure the first of a fresh series, nothing left in memory.
    hex.mailbox.moveBack("hex/failed");
    await hex.lookAfter(60_000);
    expect(hex.asked).toHaveLength(6);
    expect(hex.log().at(-1)).toContain("failed run 1 of 5");
    expect(hex.log().at(-1)).not.toContain("counted in memory");
  });

  test("a hold-back ends with a full look that doesn't list its mail", async () => {
    const hex = await freshWatcher({ script: () => new Error("rate limited (429)") });
    hex.ledgerWrites.failing = true;
    hex.mailbox.deliver(emlOf("gone@shop.example", "gone.pdf"));
    hex.mailbox.deliver(emlOf("staying@shop.example", "staying.pdf"));
    hex.start();
    await hex.scanned();
    expect(hex.asked).toHaveLength(2);
    // Deleted, then a look without it; delivered again: run at once, counted from 1.
    hex.mailbox.discard(1);
    await hex.lookAfter(60_000);
    expect(hex.asked).toHaveLength(2);
    hex.mailbox.deliver(emlOf("gone@shop.example", "gone.pdf"));
    await hex.scanned();
    expect(hex.asked).toHaveLength(3);
    const firstFailure =
      "error: hex: Intake gone@shop.example: its failed run could not be counted (Intake ledger: disk full); failed run 1 of 5, held back 5 min in memory";
    expect(hex.log().filter((line) => line === firstFailure)).toHaveLength(2);
  });

  test("a 5th failed run the ledger counted but couldn't end isn't stopped: the next look fails it permanently", async () => {
    const hex = await freshWatcher({ script: () => new Error("rate limited (429)") });
    hex.ledgerWrites.only = "endFailedRuns";
    hex.ledgerWrites.failing = true;
    hex.mailbox.deliver(emlOf("unended@shop.example"));
    hex.start();
    await hex.scanned();
    for (const delay of [5, 10, 20, 40]) await hex.lookAfter(delay * 60_000);
    expect(hex.asked).toHaveLength(5);
    expect(hex.log()).toContain(
      "error: hex: Intake unended@shop.example: failing it permanently failed (Intake ledger: disk full); the next look tries again",
    );
    expect(hex.mainChannel.posted.at(-1)?.split("\n").at(-1)).toBe(
      "Recording or ending the failed runs failed (`Intake ledger: disk full`); see the hex log.",
    );
    // A look while ending still fails: a warning, the mail stays; once it works, `hex/failed`.
    await hex.lookAfter(60_000);
    expect(hex.log().at(-1)).toMatch(
      /^warn: hex: mailbox: UID 1 \(unended@shop\.example as the server reads it\): .*disk full.*; going on with the next mail$/,
    );
    expect(hex.mailbox.messageIds()).toEqual(["unended@shop.example"]);
    hex.ledgerWrites.failing = false;
    await hex.lookAfter(60_000);
    expect(hex.asked).toHaveLength(5);
    expect(hex.mailbox.messageIds("hex/failed")).toEqual(["unended@shop.example"]);
  });

  test("at 5 with some counted in memory, a ledger that can't fail it permanently stops it until a restart, said once", async () => {
    const hex = await freshWatcher({ script: () => new Error("rate limited (429)") });
    hex.ledgerWrites.failing = true;
    hex.mailbox.deliver(emlOf("stuck@shop.example"));
    hex.start();
    await hex.scanned();
    // Runs 1 and 2 counted in memory, 3 to 5 by the ledger.
    for (const [failedRuns, delay] of [
      [1, 5],
      [2, 10],
      [3, 20],
      [4, 40],
    ] as const) {
      if (failedRuns === 2) hex.ledgerWrites.failing = false;
      await hex.lookAfter(delay * 60_000);
    }
    expect(hex.asked).toHaveLength(5);
    hex.ledgerWrites.failing = true;
    await hex.lookAfter(60_000);
    expect(hex.log().at(-1)).toBe(
      "error: hex: Intake stuck@shop.example: failing it permanently failed (Intake ledger: disk full); failed run 5 of 5, 2 of them counted in memory, but the ledger can't record failed runs to fail it permanently, so hex runs it no more until it restarts; its mail stays in the watched folder, and a restart retries it",
    );
    const lines = hex.log().length;
    for (let hour = 0; hour < 2; hour++) await hex.lookAfter(60 * 60_000);
    expect(hex.log()).toHaveLength(lines);
    expect(hex.asked).toHaveLength(5);
    expect(hex.mailbox.messageIds()).toEqual(["stuck@shop.example"]);
    expect(hex.mailbox.messageIds("hex/failed")).toEqual([]);
  });

  test("a mail the server reads with another Message-ID than hex is held back by hex's", async () => {
    const hex = await freshWatcher({ script: () => new Error("rate limited (429)") });
    hex.ledgerWrites.failing = true;
    hex.mailbox.deliver(emlOf("hexview@shop.example"), { serverMessageId: "srvview@shop.example" });
    hex.start();
    await hex.scanned();
    expect(hex.asked).toHaveLength(1);
    await hex.lookAfter(60_000);
    await hex.lookAfter(3 * 60_000);
    expect(hex.asked).toHaveLength(1);
    await hex.lookAfter(60_000);
    expect(hex.asked).toHaveLength(2);
  });

  test("an empty folder ends every hold-back", async () => {
    const hex = await freshWatcher({ script: () => new Error("rate limited (429)") });
    hex.ledgerWrites.failing = true;
    hex.mailbox.deliver(emlOf("alone@shop.example"));
    hex.start();
    await hex.scanned();
    hex.mailbox.discard(1);
    await hex.lookAfter(60_000);
    hex.mailbox.deliver(emlOf("alone@shop.example"));
    await hex.scanned();
    expect(hex.asked).toHaveLength(2);
    const firstFailure =
      "error: hex: Intake alone@shop.example: its failed run could not be counted (Intake ledger: disk full); failed run 1 of 5, held back 5 min in memory";
    expect(hex.log().filter((line) => line === firstFailure)).toHaveLength(2);
  });

  test("one mail failing doesn't hold up the others; it is named", async () => {
    const hex = await freshWatcher();
    hex.mailbox.refuse("fetching a mail");
    hex.mailbox.deliver(emlOf("first@shop.example", "first.pdf"));
    hex.mailbox.deliver(emlOf("second@shop.example", "second.pdf"));
    hex.start();
    await hex.scanned();
    expect(hex.mailbox.messageIds()).toEqual(["first@shop.example"]);
    expect(hex.mailbox.messageIds("hex/processed")).toEqual(["second@shop.example"]);
    expect(hex.log()).toContainEqual(
      expect.stringMatching(
        /^warn: hex: mailbox: UID 1 \(first@shop\.example as the server reads it\): .*fetching a mail failed.*; going on with the next mail$/,
      ),
    );
  });

  test("UIDs that changed meaning after the listing end the look; the next, at once, processes the mail", async () => {
    const hex = await freshWatcher();
    hex.mailbox.renumberAfterNextListing();
    hex.mailbox.deliver(emlOf("renumbered@shop.example"));
    hex.start();
    await hex.scanned();
    expect(hex.log()).toContainEqual(
      expect.stringMatching(
        /^warn: hex: mailbox: UID 1 \(renumbered@shop\.example as the server reads it\): .*UIDVALIDITY.*; trying again in 0 s \(attempt 1\)$/,
      ),
    );
    expect(hex.log().some((line) => line.includes("going on with the next mail"))).toBe(false);
    // No poll interval waited for: the look after the failure processed it.
    expect(hex.mailbox.messageIds("hex/processed")).toEqual(["renumbered@shop.example"]);
    expect(hex.mailbox.waits).toEqual([60_000]);
    expect(await hex.runs()).toEqual(["success"]);
  });

  test("a lost connection at one mail ends the look, naming it; the next look processes it", async () => {
    const model = blockingModel();
    const hex = await freshWatcher({ script: model.script });
    hex.mailbox.deliver(emlOf("a@shop.example", "a.pdf"));
    hex.mailbox.deliver(emlOf("b@shop.example", "b.pdf"));
    hex.start();
    await within(model.reading, "A's run reading its Document date");
    // The connection drops during A's run: A's move and B's fetch fail, then it is back.
    hex.mailbox.disconnect(2);
    model.release();
    await hex.scanned();
    const lines = hex.log();
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^warn: hex: mailbox: UID 2 \(b@shop\.example as the server reads it\): .*connection lost; trying again in 0 s \(attempt 1\)$/,
      ),
    );
    expect(lines.some((line) => line.includes("UID 2") && line.includes("going on"))).toBe(false);
    expect(hex.mailbox.messageIds("hex/processed")).toEqual(["a@shop.example", "b@shop.example"]);
    expect(hex.asked.map(({ fileName }) => fileName)).toEqual(["a.pdf", "b.pdf"]);
  });

  test("a run whose start rejects counts as a failed run", async () => {
    const hex = await freshWatcher({
      workflow: startingWith(() => Promise.reject(new Error("storage write failed"))),
    });
    hex.mailbox.deliver(emlOf("rejected@shop.example"));
    hex.start();
    await hex.scanned();
    expect(await hex.ledger((ledger) => ledger.failedRuns("rejected@shop.example"))).toMatchObject({
      count: 1,
    });
    expect(hex.log()).toContainEqual(expect.stringContaining("storage write failed"));
    expect(hex.log().at(-1)).toMatch(
      /^warn: hex: Intake rejected@shop\.example: failed run 1 of 5/,
    );
  });

  test("a run whose start rejects a 5th time, its move to hex/failed refused, warns of it before the move is tried again", async () => {
    const hex = await freshWatcher({
      workflow: startingWith(() => Promise.reject(new Error("storage write failed"))),
    });
    hex.mailbox.deliver(emlOf("rejected-refused@shop.example"));
    hex.start();
    await hex.scanned();
    for (let run = 2; run <= 5; run++) {
      if (run === 5) hex.mailbox.refuse("moving mail to hex/failed");
      // Well past any retry delay, measured from the real time of the last failure.
      hex.clock.offset = run * 60 * 60_000;
      hex.mailbox.tick();
      await hex.scanned();
    }
    expect(hex.mailbox.messageIds("hex/failed")).toEqual(["rejected-refused@shop.example"]);
    expect(
      hex.log().filter((line) => line.includes("rejected-refused@shop.example: failed run 5 of 5")),
    ).toEqual([
      expect.stringMatching(
        /^warn: hex: Intake rejected-refused@shop\.example: failed run 5 of 5, so the Intake failed permanently: moving its mail to hex\/failed failed \(.*NOPERM.*\); the mailbox watcher, if it started the run, tries the move once more; failing that, it runs it afresh \(a new series of 5 runs\) at its next look$/s,
      ),
      "warn: hex: Intake rejected-refused@shop.example: failed run 5 of 5, so the Intake failed permanently: its mail was moved to hex/failed",
    ]);
  });

  test("a run whose start rejects a 5th time still has its refused move tried again when its warning throws", async () => {
    const hex = await freshWatcher({
      workflow: startingWith(() => Promise.reject(new Error("storage write failed"))),
    });
    hex.mailbox.deliver(emlOf("rejected-broken@shop.example"));
    hex.start();
    await hex.scanned();
    for (let run = 2; run <= 5; run++) {
      if (run === 5) {
        hex.mailbox.refuse("moving mail to hex/failed");
        hex.failing.line = "tries the move once more";
      }
      hex.clock.offset = run * 60 * 60_000;
      hex.mailbox.tick();
      await hex.scanned();
    }
    expect(hex.mailbox.messageIds()).toEqual([]);
    expect(hex.mailbox.messageIds("hex/failed")).toEqual(["rejected-broken@shop.example"]);
    expect(hex.log()).toContainEqual(
      expect.stringMatching(
        /^error: hex: mailbox: the watcher failed unexpectedly: .*the logger broke/s,
      ),
    );
  });

  test("a run whose start rejects a 5th time moves its mail to hex/failed, said once", async () => {
    const hex = await freshWatcher({
      workflow: startingWith(() => Promise.reject(new Error("storage write failed"))),
    });
    hex.mailbox.deliver(emlOf("rejected-moved@shop.example"));
    hex.start();
    await hex.scanned();
    for (let run = 2; run <= 5; run++) {
      hex.clock.offset = run * 60 * 60_000;
      hex.mailbox.tick();
      await hex.scanned();
    }
    expect(hex.mailbox.messageIds("hex/failed")).toEqual(["rejected-moved@shop.example"]);
    expect(
      hex.log().filter((line) => line.includes("rejected-moved@shop.example: failed run 5 of 5")),
    ).toEqual([
      "warn: hex: Intake rejected-moved@shop.example: failed run 5 of 5, so the Intake failed permanently: its mail was moved to hex/failed",
    ]);
  });

  test("a run a defect in a step ended is told once, with that defect, and counted", async () => {
    // A promise that rejects, not an Error answer: a defect, which no step handles.
    const hex = await freshWatcher({
      script: async () => {
        throw new TypeError("the extractor broke");
      },
    });
    hex.mailbox.deliver(emlOf("defect@shop.example"));
    hex.start();
    await hex.scanned();
    expect(hex.log().filter((line) => line.includes("the run failed:"))).toEqual([
      expect.stringMatching(
        /^warn: hex: Intake defect@shop\.example: the run failed: .*the extractor broke/s,
      ),
    ]);
    expect(await hex.ledger((ledger) => ledger.failedRuns("defect@shop.example"))).toMatchObject({
      count: 1,
    });
  });

  test("a model call that never answers fails its run, counted; the next mail is processed", async () => {
    let calls = 0;
    // The first call holds until it is aborted, as a provider that never answers would; later
    // calls answer.
    const model = mockModel({
      before: async (options) => {
        if (++calls > 1) return;
        const { abortSignal } = options as { abortSignal: AbortSignal };
        const aborted = Promise.withResolvers<never>();
        abortSignal.addEventListener("abort", () => aborted.reject(abortSignal.reason));
        await aborted.promise;
      },
    });
    const hex = await freshWatcher({
      dateExtractor: dateExtractorLayer(model, { retryDelayMs: 0, timeoutMs: 500 }),
    });
    hex.mailbox.deliver(emlOf("hung@shop.example", "hung.pdf"));
    hex.mailbox.deliver(emlOf("next@shop.example", "next.pdf"));
    hex.start();
    await hex.scanned();
    expect(await hex.ledger((ledger) => ledger.failedRuns("hung@shop.example"))).toMatchObject({
      count: 1,
    });
    expect(hex.log()).toContain(
      'warn: hex: Intake hung@shop.example: the run failed: filing: reading the Document date of "hung.pdf" with mock-provider/mock-model-id timed out after 500 ms; failed run 1 of 5: any mail of it in the watched folder stays there; the mailbox watcher runs it again no sooner than 5 min from now',
    );
    expect(hex.mailbox.messageIds()).toEqual(["hung@shop.example"]);
    expect(hex.mailbox.messageIds("hex/processed")).toEqual(["next@shop.example"]);
    expect((await hex.runs()).sort()).toEqual(["failed", "success"]);
  });

  test("a run whose start rejects after it processed the Intake is not counted", async () => {
    const hex = await freshWatcher({
      // Every step ran; storing the run's end failed.
      workflow: startingWith(async (run, args) => {
        await run.start(args);
        throw new Error("storing the run's end failed");
      }),
    });
    hex.mailbox.deliver(emlOf("late@shop.example"));
    // The run's own move fails: the watcher moves the mail of the Intake it finds processed.
    hex.mailbox.refuse("moving mail to hex/processed");
    hex.start();
    await hex.scanned();
    expect(await hex.ledger((ledger) => ledger.failedRuns("late@shop.example"))).toBeUndefined();
    expect(hex.mailbox.messageIds("hex/processed")).toEqual(["late@shop.example"]);
    expect(hex.log()).toContainEqual(
      expect.stringContaining("hex: Intake late@shop.example: processed nonetheless"),
    );
  });

  test("a run whose start rejects, its ledger unreadable then, is held back in memory", async () => {
    let started = 0;
    const hex = await freshWatcher({
      workflow: startingWith(() => {
        started++;
        // The ledger can't tell whether it was processed nonetheless.
        hex.ledgerReads.failNext = true;
        return Promise.reject(new Error("storage write failed"));
      }),
    });
    hex.mailbox.deliver(emlOf("unreadable@shop.example"));
    hex.start();
    await hex.scanned();
    expect(started).toBe(1);
    expect(hex.log().at(-1)).toBe(
      "error: hex: Intake unreadable@shop.example: its failed run could not be counted (Intake ledger: database is locked); failed run 1 of 5, held back 5 min in memory",
    );
    expect(hex.log().some((line) => line.includes("going on with the next mail"))).toBe(false);
    expect(
      await hex.ledger((ledger) => ledger.failedRuns("unreadable@shop.example")),
    ).toBeUndefined();
    // The ledger reads again: held back 5 min all the same, then run again.
    await hex.lookAfter(4 * 60_000);
    expect(started).toBe(1);
    await hex.lookAfter(60_000);
    expect(started).toBe(2);
    expect(hex.log().at(-1)).toBe(
      "error: hex: Intake unreadable@shop.example: its failed run could not be counted (Intake ledger: database is locked); failed run 2 of 5, held back 10 min in memory",
    );
    expect(hex.mailbox.messageIds()).toEqual(["unreadable@shop.example"]);
  });

  test("a run whose start rejects after it processed the Intake, its ledger unreadable then, is settled once it reads", async () => {
    const hex = await freshWatcher({
      // Every step ran; storing the run's end failed, and the ledger can't tell then.
      workflow: startingWith(async (run, args) => {
        await run.start(args);
        hex.ledgerReads.failNext = true;
        throw new Error("storing the run's end failed");
      }),
    });
    hex.mailbox.deliver(emlOf("late@shop.example"));
    // The run's own move fails: the mail stays for the look that finds the Intake processed.
    hex.mailbox.refuse("moving mail to hex/processed");
    hex.start();
    await hex.scanned();
    expect(hex.log().at(-1)).toMatch(/^error: hex: Intake late@shop\.example: .*held back 5 min/);
    expect(hex.mailbox.messageIds()).toEqual(["late@shop.example"]);
    await hex.lookAfter(5 * 60_000);
    expect(hex.asked).toHaveLength(1);
    expect(hex.mailbox.messageIds("hex/processed")).toEqual(["late@shop.example"]);
    expect(hex.log()).toContainEqual(
      expect.stringContaining("hex: Intake late@shop.example: already processed"),
    );
  });

  test("a run of its own going on is a warning every 10 min, naming it; none once it ended", async () => {
    const model = blockingModel();
    const hex = await freshWatcher({ script: model.script });
    hex.mailbox.deliver(emlOf("slow@shop.example"));
    hex.start();
    await within(model.reading, "the run reading its Document date");
    const [timer, ...others] = [...hex.timers];
    expect(others).toEqual([]);
    const [tick, everyMs] = timer!;
    expect(everyMs).toBe(LONG_RUN_MS);
    hex.clock.advance(10 * 60_000);
    tick();
    // A logger that throws at the 20 min warning: the timer goes on to the next.
    hex.failing.line = "has been running";
    hex.clock.advance(10 * 60_000);
    tick();
    hex.clock.advance(10 * 60_000);
    tick();
    const warning = (minutes: number) =>
      expect.stringMatching(
        new RegExp(
          `^warn: hex: Intake slow@shop\\.example: its run \\S+ has been running for ${minutes} min; the mailbox watcher takes no other mail until it ends$`,
        ),
      );
    expect(hex.log().filter((line) => line.includes("has been running"))).toEqual([
      warning(10),
      warning(30),
    ]);
    model.release();
    await hex.scanned();
    expect(hex.timers.size).toBe(0);
    expect(hex.mailbox.messageIds("hex/processed")).toEqual(["slow@shop.example"]);
  });

  test("a mail the server reads as a processed Intake but hex reads as another one is run", async () => {
    const hex = await freshWatcher();
    hex.mailbox.deliver(emlOf("first@shop.example", "first.pdf"));
    hex.start();
    await hex.scanned();
    // The server reads this mail's Message-ID as the processed Intake's.
    hex.mailbox.deliver(emlOf("other@shop.example", "other.pdf"), {
      serverMessageId: "first@shop.example",
    });
    await hex.scanned();
    expect(hex.asked.map(({ fileName }) => fileName)).toEqual(["first.pdf", "other.pdf"]);
    expect(hex.log()).toContain(
      "info: hex: Intake other@shop.example: processed; its mail was moved to hex/processed",
    );
  });

  test("active runs: one whose input can't be read is a warning; one stored as JSON guards its Intake", async () => {
    const hex = await freshWatcher({
      workflow: (registered) => ({
        createRun: () => registered.createRun(),
        listActiveWorkflowRuns: async () => ({
          runs: [
            { runId: "run-unreadable", snapshot: { context: {} } },
            {
              runId: "run-json",
              snapshot: JSON.stringify({
                context: { input: { messageId: "<json@shop.example>" } },
              }),
            },
          ],
        }),
      }),
    });
    hex.mailbox.deliver(emlOf("json@shop.example"));
    hex.start();
    await hex.scanned();
    hex.mailbox.tick();
    await hex.scanned();
    expect(hex.asked).toEqual([]);
    expect(hex.mailbox.messageIds()).toEqual(["json@shop.example"]);
    const lines = hex.log();
    expect(lines.filter((line) => line.includes("run-unreadable"))).toEqual([
      "warn: hex: mailbox: the active Intake run run-unreadable shows no Message-ID; its Intake isn't guarded against a second run",
    ]);
    expect(lines).toContainEqual(expect.stringContaining("its run run-json is active"));
  });

  test("something unexpected is logged as an error and the watcher keeps watching", async () => {
    const hex = await freshWatcher();
    hex.failing.line = "a@shop.example: processed";
    hex.mailbox.deliver(emlOf("a@shop.example", "a.pdf"));
    hex.start();
    await hex.scanned();
    expect(hex.log()).toContainEqual(
      "error: hex: mailbox: UID 1 (a@shop.example as the server reads it): something unexpected failed",
    );
    expect(hex.log()).toContainEqual(
      expect.stringMatching(
        /^error: hex: mailbox: the watcher failed unexpectedly: .*the logger broke/s,
      ),
    );
    hex.mailbox.deliver(emlOf("b@shop.example", "b.pdf"));
    await hex.scanned();
    expect(hex.mailbox.messageIds("hex/processed")).toEqual(["a@shop.example", "b@shop.example"]);
  });

  test("once stopped, no run starts and the mailbox is closed", async () => {
    const model = blockingModel();
    const hex = await freshWatcher({ script: model.script });
    hex.mailbox.deliver(emlOf("first@shop.example", "first.pdf"));
    hex.mailbox.deliver(emlOf("second@shop.example", "second.pdf"));
    hex.start();
    await within(model.reading, "the first run reading its Document date");
    await within(hex.stop(), "the watcher to stop");
    expect(hex.mailbox.closed).toBe(true);
    const before = hex.mailbox.operations.length;

    // The run in progress goes on and ends; its mail can't move any more, and nothing else is
    // done with the mailbox.
    model.release();
    await within(Promise.all(hex.starts), "the first run to end");
    await flush();
    expect(hex.mailbox.operations.slice(before)).toEqual(["moving mail to hex/processed"]);
    expect(hex.asked.map(({ fileName }) => fileName)).toEqual(["first.pdf"]);
    expect(await hex.runs()).toEqual(["success"]);
    expect(hex.mailbox.messageIds()).toEqual(["first@shop.example", "second@shop.example"]);
  });

  test("a report that can't be posted is a warning; the Intake is processed or retried all the same", async () => {
    let failures = 1;
    const hex = await freshWatcher({
      script: () => (failures-- > 0 ? new Error("rate limited (429)") : DATED),
    });
    hex.mainChannel.failNext(2);
    hex.mailbox.deliver(emlOf("unreported@shop.example"));
    hex.start();
    await hex.scanned();
    const warning =
      "warn: hex: Intake unreported@shop.example: its Intake report was not posted: posting to slack failed: channel_not_found";
    expect(hex.log().filter((line) => line === warning)).toHaveLength(1);
    expect(hex.log().some((line) => line.includes("failed run 1 of 5"))).toBe(true);
    expect(hex.mailbox.messageIds()).toEqual(["unreported@shop.example"]);

    await hex.lookAfter(5 * 60_000);
    expect(hex.log().filter((line) => line === warning)).toHaveLength(2);
    expect(hex.log()).toContain(
      "info: hex: Intake unreported@shop.example: processed; its mail was moved to hex/processed",
    );
    expect(hex.mailbox.messageIds("hex/processed")).toEqual(["unreported@shop.example"]);
    expect(hex.mainChannel.posted).toEqual([]);
  });
});
