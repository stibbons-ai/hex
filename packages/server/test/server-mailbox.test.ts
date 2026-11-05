// The server's boot: the mailbox watcher starts alongside Mastra's sweep of the active runs, so a
// sweep that hangs (a resumed run that never ends) holds up no mail, and one that fails is logged.
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mastra } from "@mastra/core/mastra";
import { startServer } from "../src";
import {
  INTAKE_WORKFLOW_ID,
  createIntakeRuntime,
  createIntakeWorkflow,
} from "../src/intake-workflow";
import { buildEml, pdfMail } from "./eml";
import { memoryMailbox } from "./memory-mailbox";
import { scriptedDateExtractor } from "./scripted-extractor";
import { within } from "./timeouts";

let directory: string;
let instances = 0;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-server-mailbox-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

/**
 * Starts the server watching a mailbox with one mail in it, its boot sweep replaced by `sweep`,
 * runs `check` on it, and stops it.
 */
async function bootWith(
  sweep: (this: Mastra) => Promise<void>,
  check: (booting: {
    server: Awaited<ReturnType<typeof startServer>>;
    mailbox: ReturnType<typeof memoryMailbox>;
  }) => Promise<void>,
) {
  const spy = spyOn(Mastra.prototype, "restartAllActiveWorkflowRuns").mockImplementationOnce(sweep);
  const root = join(directory, `hex-${instances++}`);
  const paths = { databasePath: join(root, "mastra.db"), outboxDirectory: join(root, "outbox") };
  const mailbox = memoryMailbox();
  mailbox.deliver(buildEml(pdfMail("swept@shop.example")));
  const runtime = createIntakeRuntime(paths, {
    dateExtractor: scriptedDateExtractor(() => ({ year: 2026, month: 10, day: 1 })).layer,
    mailbox: mailbox.layer,
  });
  const server = await startServer({
    databasePath: paths.databasePath,
    observabilityPath: join(root, "observability.duckdb"),
    port: 0,
    logger: false,
    workflows: {
      [INTAKE_WORKFLOW_ID]: createIntakeWorkflow({ runtime, category: "ER" }),
    },
    mailbox: { runtime, pollMs: 60_000 },
  });
  try {
    expect(spy).toHaveBeenCalledTimes(1);
    await check({ server, mailbox });
  } finally {
    spy.mockRestore();
    await server.stop();
    await runtime.dispose();
  }
}

test("a boot sweep that never settles holds up no mail: the watcher processes it meanwhile", async () => {
  let booted = false;
  await bootWith(
    () => new Promise<void>(() => {}),
    async ({ server, mailbox }) => {
      void server.booted.then(() => {
        booted = true;
      });
      await within(mailbox.waiting(), "the watcher's first look");
      expect(mailbox.messageIds("hex/processed")).toEqual(["swept@shop.example"]);
      expect(booted).toBe(false);
    },
  );
});

test("a boot sweep that fails is logged as an error; the watcher processes the mail", async () => {
  const logged: unknown[][] = [];
  await bootWith(
    // Mastra's logger is silenced; the failing sweep listens on it as it fails.
    function () {
      spyOn(this.getLogger(), "error").mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
      return Promise.reject(new Error("reading the workflow runs failed"));
    },
    async ({ server, mailbox }) => {
      await within(server.booted, "the boot");
      expect(logged).toContainEqual([
        "hex: restarting the active workflow runs failed; their Intakes wait",
        new Error("reading the workflow runs failed"),
      ]);
      await within(mailbox.waiting(), "the watcher's first look");
      expect(mailbox.messageIds("hex/processed")).toEqual(["swept@shop.example"]);
    },
  );
});
