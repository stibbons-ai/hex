// The server's boot: the mailbox watcher starts after Mastra's sweep of the active runs, also
// when that sweep fails.
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

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-server-mailbox-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("a boot sweep that fails still starts the watcher", async () => {
  const logged: unknown[][] = [];
  // Mastra's logger is silenced; the failing sweep listens on it as it fails.
  const sweep = spyOn(Mastra.prototype, "restartAllActiveWorkflowRuns").mockImplementationOnce(
    function (this: Mastra) {
      spyOn(this.getLogger(), "error").mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
      return Promise.reject(new Error("reading the workflow runs failed"));
    },
  );
  const paths = {
    databasePath: join(directory, "mastra.db"),
    outboxDirectory: join(directory, "outbox"),
  };
  const mailbox = memoryMailbox();
  mailbox.deliver(buildEml(pdfMail("swept@shop.example")));
  const runtime = createIntakeRuntime(paths, {
    dateExtractor: scriptedDateExtractor(() => ({ year: 2026, month: 10, day: 1 })).layer,
    mailbox: mailbox.layer,
  });
  const server = await startServer({
    databasePath: paths.databasePath,
    observabilityPath: join(directory, "observability.duckdb"),
    port: 0,
    logger: false,
    workflows: {
      [INTAKE_WORKFLOW_ID]: createIntakeWorkflow({ runtime, category: "ER" }),
    },
    mailbox: { runtime, pollMs: 60_000 },
  });
  try {
    await within(server.booted, "the boot");
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(logged).toContainEqual([
      "hex: restarting the active workflow runs failed; their Intakes wait",
      new Error("reading the workflow runs failed"),
    ]);
    await within(mailbox.waiting(), "the watcher's first look");
    expect(mailbox.messageIds("hex/processed")).toEqual(["swept@shop.example"]);
  } finally {
    sweep.mockRestore();
    await server.stop();
    await runtime.dispose();
  }
});
