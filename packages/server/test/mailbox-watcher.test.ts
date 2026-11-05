import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateExtractionError, DateExtractor, createLocalStore, readEml } from "@hex/adapters";
import type { DocumentFile, Intake } from "@hex/adapters";
import { Mastra } from "@mastra/core/mastra";
import { Effect, Layer } from "effect";
import { closeInOrder } from "../src/close";
import {
  INTAKE_WORKFLOW_ID,
  createIntakeRuntime,
  createIntakeWorkflow,
} from "../src/intake-workflow";
import type { IntakeForwarding } from "../src/intake-workflow";
import { watchMailbox } from "../src/mailbox-watcher";
import type { IntakeWorkflow, MailboxWatcher } from "../src/mailbox-watcher";
import { RECEIVED, buildEml, pdf } from "./eml";
import { memoryMailbox } from "./memory-mailbox";
import { recordingMailer } from "./recording-mailer";
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

/** A mail with one PDF Document, as raw `.eml` bytes. */
const mailOf = (messageId: string | undefined, fileName = "Rechnung.pdf") =>
  buildEml({ ...(messageId ? { messageId } : {}), received: RECEIVED, parts: [pdf(fileName)] });

/**
 * The answer of the scripted DateExtractor for a Document: a date, an Error (a failed model call)
 * or a promise of either (a model call that takes until the test says so).
 */
type Script = (document: DocumentFile) => unknown;

/**
 * A fresh data directory with the real Intake workflow registered on a Mastra persisting runs
 * there, a recording Mailer forwarding to `forwarding`, an in-memory Mailbox (`idle: false`: the
 * server has no IMAP IDLE), and a watcher on them, not started yet. The watcher's clock is the
 * real one moved forward by `clock.advance`; it tries again at once after a failure.
 */
async function freshWatcher({
  script = () => ({ year: 2026, month: 10, day: 1 }),
  forwarding,
  idle = true,
}: { script?: Script; forwarding?: IntakeForwarding; idle?: boolean } = {}) {
  const root = join(directory, `hex-${instances++}`);
  const paths = { databasePath: join(root, "mastra.db"), outboxDirectory: join(root, "outbox") };
  const asked: DocumentFile[] = [];
  const dateExtractor = Layer.succeed(DateExtractor, {
    extract: (document) =>
      Effect.promise(async () => {
        asked.push(document);
        return script(document);
      }).pipe(
        Effect.flatMap((answer) =>
          answer instanceof Error
            ? Effect.fail(new DateExtractionError({ message: answer.message }))
            : Effect.succeed({ answer, usage: undefined }),
        ),
      ),
  });
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
  const workflow: IntakeWorkflow = mastra.getWorkflow(INTAKE_WORKFLOW_ID);
  const clock = { offset: 0, advance: (ms: number) => (clock.offset += ms) };
  const log: string[] = [];
  let watcher: MailboxWatcher | undefined;
  return {
    asked,
    mailer,
    mailbox,
    clock,
    log,
    workflow,
    start() {
      watcher = watchMailbox({
        runtime,
        workflow,
        pollMs: 60_000,
        log: { info: (message) => log.push(message), warn: (message) => log.push(message) },
        now: () => Date.now() + clock.offset,
        retryDelayAfterFailure: () => 0,
      });
      cleanups.push(() => watcher!.stop());
    },
    stop: () => watcher!.stop(),
    /** Resolves once the watcher finished a scan and waits for news again. */
    scanned: () => within(mailbox.waiting(), "the watcher's scan"),
    /** The Outbox's files, relative. */
    async outbox() {
      const files = await readdir(paths.outboxDirectory, { recursive: true }).catch(() => []);
      return files.filter((file) => file.endsWith(".pdf")).sort();
    },
    /** How many Intake runs storage has, any status. */
    async runs() {
      return (await mastra.getWorkflow(INTAKE_WORKFLOW_ID).listWorkflowRuns()).total;
    },
  };
}

describe("watchMailbox", () => {
  test("N mails, N runs: each mail processed and moved to hex/processed once", async () => {
    const hex = await freshWatcher();
    hex.mailbox.deliver(mailOf("a@shop.example", "a.pdf"));
    hex.mailbox.deliver(mailOf("b@shop.example", "b.pdf"));
    hex.mailbox.deliver(mailOf("c@shop.example", "c.pdf"));
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
    expect(await hex.runs()).toBe(3);
    expect(hex.log).toContain(
      "hex: Intake b@shop.example: processed; its mail was moved to hex/processed",
    );
  });

  test("copies, re-deliveries, rescans and a reconnect: one run's effects per Intake", async () => {
    const hex = await freshWatcher({ forwarding: both });
    hex.mailbox.deliver(mailOf("dup@shop.example"));
    hex.mailbox.deliver(mailOf("dup@shop.example"));
    hex.start();
    await hex.scanned();
    // Both copies went with the one run.
    expect(hex.mailbox.messageIds("hex/processed")).toEqual([
      "dup@shop.example",
      "dup@shop.example",
    ]);

    // Re-delivered: IDLE says so, the rescan only moves it.
    hex.mailbox.deliver(mailOf("dup@shop.example"));
    await hex.scanned();
    // The connection drops while the watcher waits; two reconnects fail, the third works and
    // rescans. Delivered meanwhile, the mail is picked up then.
    hex.mailbox.disconnect(2);
    hex.mailbox.deliver(mailOf("dup@shop.example"));
    await hex.scanned();

    expect(hex.mailbox.messageIds()).toEqual([]);
    expect(hex.mailbox.messageIds("hex/processed")).toHaveLength(4);
    expect(hex.mailer.sent.map(({ to }) => to)).toEqual([SEVDESK, PAPERLESS]);
    expect(await hex.outbox()).toEqual(["2026-10/ER/Rechnung.pdf"]);
    expect(hex.asked).toHaveLength(1);
    expect(await hex.runs()).toBe(1);
    const retries = hex.log.filter((line) => line.includes("trying again"));
    expect(retries).toHaveLength(3);
    expect(retries[2]).toContain("connection lost; trying again in 0 s (attempt 3)");
  });

  test("a mail that can't become an Intake goes to hex/failed without a run", async () => {
    const hex = await freshWatcher();
    hex.mailbox.deliver(mailOf(undefined));
    hex.mailbox.deliver(new TextEncoder().encode("not a mail"));
    hex.start();
    await hex.scanned();
    expect(hex.mailbox.messageIds()).toEqual([]);
    expect(hex.mailbox.moves.map(({ to }) => to)).toEqual(["hex/failed", "hex/failed"]);
    expect(hex.asked).toEqual([]);
    expect(await hex.runs()).toBe(0);
    expect(hex.log).toContain(
      "hex: mailbox: INBOX UID 1: no Message-ID, so the Intake can't be processed exactly once; moving it to hex/failed",
    );
  });

  test("a failed Intake is retried only once its delay passed", async () => {
    let failing = true;
    const hex = await freshWatcher({
      script: () => (failing ? new Error("rate limited (429)") : { year: 2026, month: 10, day: 1 }),
    });
    hex.mailbox.deliver(mailOf("retry@shop.example"));
    hex.start();
    await hex.scanned();
    expect(hex.asked).toHaveLength(1);
    expect(hex.mailbox.messageIds()).toEqual(["retry@shop.example"]);
    expect(hex.log.at(-1)).toContain("failed run 1 of 5");
    failing = false;

    // A poll 4 minutes later: too early.
    hex.clock.advance(4 * 60_000);
    hex.mailbox.tick();
    await hex.scanned();
    expect(hex.asked).toHaveLength(1);

    // 5 minutes after the failure: retried, processed, moved.
    hex.clock.advance(60_000);
    hex.mailbox.tick();
    await hex.scanned();
    expect(hex.asked).toHaveLength(2);
    expect(hex.mailbox.messageIds("hex/processed")).toEqual(["retry@shop.example"]);
  });

  test("without IMAP IDLE, new mail waits for the poll interval", async () => {
    const hex = await freshWatcher({ idle: false });
    hex.start();
    await hex.scanned();
    hex.mailbox.deliver(mailOf("polled@shop.example"));
    // No notification: the watcher still waits in the same wait, the mail untouched.
    await hex.scanned();
    expect(hex.mailbox.messageIds()).toEqual(["polled@shop.example"]);
    hex.mailbox.tick();
    await hex.scanned();
    expect(hex.mailbox.messageIds("hex/processed")).toEqual(["polled@shop.example"]);
  });

  test("an Intake with a run active in storage gets no second run", async () => {
    const release = Promise.withResolvers<void>();
    const reading = Promise.withResolvers<void>();
    const hex = await freshWatcher({
      script: async () => {
        reading.resolve();
        await release.promise;
        return { year: 2026, month: 10, day: 1 };
      },
    });
    const mail = mailOf("active@shop.example");
    // A run started elsewhere (resumed after a restart, say), still reading the Document date.
    const intake: Intake = await Effect.runPromise(readEml(mail, "active.eml"));
    const run = await hex.workflow.createRun();
    const result = run.start({ inputData: intake });
    await within(reading.promise, "the run reading the Document date");
    hex.mailbox.deliver(mail);
    hex.start();
    await hex.scanned();
    expect(hex.mailbox.messageIds()).toEqual(["active@shop.example"]);
    expect(hex.asked).toHaveLength(1);

    release.resolve();
    expect(await within(result, "the active run")).toMatchObject({ status: "success" });
    expect(hex.mailbox.messageIds("hex/processed")).toEqual(["active@shop.example"]);
    expect(await hex.runs()).toBe(1);
  });

  test("once stopped, no run starts and the mailbox is closed", async () => {
    const release = Promise.withResolvers<void>();
    const reading = Promise.withResolvers<void>();
    const hex = await freshWatcher({
      script: async () => {
        reading.resolve();
        await release.promise;
        return { year: 2026, month: 10, day: 1 };
      },
    });
    hex.mailbox.deliver(mailOf("first@shop.example", "first.pdf"));
    hex.mailbox.deliver(mailOf("second@shop.example", "second.pdf"));
    hex.start();
    await within(reading.promise, "the first run reading its Document date");
    await within(hex.stop(), "the watcher to stop");
    expect(hex.mailbox.closed).toBe(true);

    // The run in progress goes on; its mail can't move any more, and nothing else starts.
    const moving = hex.mailbox.nextOperation();
    release.resolve();
    expect(await within(moving, "the run's move step")).toBe("moving mail to hex/processed");
    expect(hex.asked.map(({ fileName }) => fileName)).toEqual(["first.pdf"]);
    expect(await hex.runs()).toBe(1);
    expect(hex.mailbox.messageIds()).toEqual(["first@shop.example", "second@shop.example"]);
  });
});
