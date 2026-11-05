import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntakeLedger, createLocalStore, readEml } from "@hex/adapters";
import type { Intake } from "@hex/adapters";
import { Mastra } from "@mastra/core/mastra";
import { Effect } from "effect";
import { closeInOrder } from "../src/close";
import {
  INTAKE_WORKFLOW_ID,
  createIntakeRuntime,
  createIntakeWorkflow,
} from "../src/intake-workflow";
import type { IntakeForwarding } from "../src/intake-workflow";
import { LONG_RUN_MS, watchMailbox } from "../src/mailbox-watcher";
import type { IntakeWorkflow, MailboxWatcher } from "../src/mailbox-watcher";
import { buildEml, pdfMail } from "./eml";
import { memoryMailbox } from "./memory-mailbox";
import { recordingMailer } from "./recording-mailer";
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

/**
 * A fresh data directory with the real Intake workflow registered on a Mastra persisting runs
 * there, a recording Mailer forwarding to `forwarding`, an in-memory Mailbox (`idle: false`: the
 * server has no IMAP IDLE), and a watcher on them, not started yet. `workflow` wraps the
 * registered workflow (a run whose start rejects, say). The watcher's clock is the real one moved
 * forward by `clock.advance` (or set by `clock.offset`); it tries again at once after a failure.
 * Setting `failing.line` makes the next log line containing it throw, as a broken logger would.
 */
async function freshWatcher({
  script = () => DATED,
  forwarding,
  idle = true,
  workflow: wrap = (registered) => registered,
}: {
  script?: Script;
  forwarding?: IntakeForwarding;
  idle?: boolean;
  workflow?: (registered: IntakeWorkflow) => IntakeWorkflow;
} = {}) {
  const root = join(directory, `hex-${instances++}`);
  const paths = { databasePath: join(root, "mastra.db"), outboxDirectory: join(root, "outbox") };
  const { layer: dateExtractor, asked } = scriptedDateExtractor(script);
  const mailer = recordingMailer();
  const mailbox = memoryMailbox({ idle });
  const runtime = createIntakeRuntime(paths, {
    dateExtractor,
    mailer: mailer.layer,
    mailbox: mailbox.layer,
  });
  const storage = await createLocalStore(paths.databasePath);
  await storage.init();
  const mastra = new Mastra({
    storage,
    logger: false,
    workflows: {
      [INTAKE_WORKFLOW_ID]: createIntakeWorkflow({ runtime, category: "ER", forwarding }),
    },
  });
  cleanups.push(
    () => runtime.dispose(),
    () => storage.close(),
    () => mastra.shutdown(),
  );
  const registered: IntakeWorkflow = mastra.getWorkflow(INTAKE_WORKFLOW_ID);
  const clock = { offset: 0, advance: (ms: number) => (clock.offset += ms) };
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
  let watcher: MailboxWatcher | undefined;
  /** Each run the watcher started, settled (either way) when the run ends. */
  const starts: Promise<unknown>[] = [];
  /** The watcher's repeating timers, by their tick, with their interval: a test fires them. */
  const timers = new Map<() => void, number>();
  return {
    asked,
    mailer,
    mailbox,
    clock,
    failing,
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
    hex.start();
    await hex.scanned();
    expect(hex.mailbox.messageIds()).toEqual([]);
    expect(hex.mailbox.moves.map(({ to }) => to)).toEqual(["hex/failed", "hex/failed"]);
    expect(hex.asked).toEqual([]);
    expect(await hex.runs()).toEqual([]);
    expect(hex.log()).toContain(
      "warn: hex: mailbox: INBOX UID 1: no Message-ID, so the Intake can't be processed exactly once; moving it to hex/failed",
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

    // The failures are recorded at real time, the watcher's clock runs ahead by its offset:
    // 9 minutes after the second failure is too early; 10: retried, processed, moved.
    hex.clock.offset = 9 * 60_000;
    hex.mailbox.tick();
    await hex.scanned();
    expect(hex.asked).toHaveLength(2);
    hex.clock.offset = 10 * 60_000;
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
    expect(hex.log()).toContain(
      "warn: hex: Intake limit@shop.example: failed permanently; its mail was moved to hex/failed",
    );
  });

  /** An always-failing Intake `messageId` driven to its 5th failed run, `refused` moves failing. */
  async function toFifthFailure(messageId: string, refused: number) {
    const hex = await freshWatcher({ script: () => new Error("rate limited (429)") });
    hex.mailbox.deliver(emlOf(messageId));
    hex.start();
    await hex.scanned();
    for (let run = 2; run <= 5; run++) {
      if (run === 5) hex.mailbox.refuse("moving mail to hex/failed", refused);
      // Well past any retry delay, measured from the real time of the last failure.
      hex.clock.offset = run * 60 * 60_000;
      hex.mailbox.tick();
      await hex.scanned();
    }
    expect(hex.asked).toHaveLength(5);
    return hex;
  }

  test("a failed move to hex/failed is tried once more by UID", async () => {
    const hex = await toFifthFailure("move-once@shop.example", 1);
    expect(hex.mailbox.messageIds("hex/failed")).toEqual(["move-once@shop.example"]);
    expect(hex.log()).toContain(
      "warn: hex: Intake move-once@shop.example: failed permanently; its mail was moved to hex/failed",
    );
  });

  test("a move to hex/failed failing twice says the Intake is run afresh at the next look", async () => {
    const hex = await toFifthFailure("move-never@shop.example", 2);
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
      workflow: (registered) => ({
        listActiveWorkflowRuns: () => registered.listActiveWorkflowRuns(),
        createRun: async () => {
          const run = await registered.createRun();
          return {
            runId: run.runId,
            start: () => Promise.reject(new Error("storage write failed")),
          };
        },
      }),
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

  test("a run whose start rejects after it processed the Intake is not counted", async () => {
    const hex = await freshWatcher({
      workflow: (registered) => ({
        listActiveWorkflowRuns: () => registered.listActiveWorkflowRuns(),
        createRun: async () => {
          const run = await registered.createRun();
          return {
            runId: run.runId,
            // Every step ran; storing the run's end failed.
            start: async (args) => {
              await run.start(args);
              throw new Error("storing the run's end failed");
            },
          };
        },
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
      warning(20),
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
});
