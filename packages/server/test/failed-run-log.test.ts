// What the server's log shows of a failed Intake run: hex's own line, not the error and stack
// Mastra logs for the step error that ends the run on purpose. Any other step error still logs
// both.
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsoleLogger, LogLevel } from "@mastra/core/logger";
import { startServer } from "../src";
import type { RunningServer } from "../src";
import {
  INTAKE_WORKFLOW_ID,
  createIntakeRuntime,
  createIntakeWorkflow,
} from "../src/intake-workflow";
import { buildEml, pdfMail } from "./eml";
import { memoryMailbox } from "./memory-mailbox";
import { recordingMailer } from "./recording-mailer";
import { scriptedDateExtractor } from "./scripted-extractor";
import { oneStep, serverOptions } from "./server-helpers";
import { within } from "./timeouts";

let directory: string;
let instances = 0;
/** Every line the server's console logger printed, as `level: text`. */
let printed: string[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-failed-run-log-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** Records what the console prints at `level` instead of printing it. */
function capture(level: "error" | "warn") {
  return spyOn(console, level).mockImplementation((...args: unknown[]) => {
    printed.push(`${level}: ${args.map(String).join(" ")}`);
  });
}

/** Starts a server with `options` logging on a console logger at warn level, as in production. */
async function withServer(
  options: Partial<Parameters<typeof startServer>[0]>,
  check: (server: RunningServer) => Promise<void>,
) {
  printed = [];
  const spies = [capture("error"), capture("warn")];
  const server = await startServer(
    serverOptions(directory, `hex-${instances++}`, {
      logger: new ConsoleLogger({ level: LogLevel.WARN }),
      ...options,
    }),
  );
  try {
    await check(server);
  } finally {
    await server.stop();
    for (const spy of spies) spy.mockRestore();
  }
}

test("a failed Intake run logs hex's line and no step error or stack from Mastra", async () => {
  const root = join(directory, `intake-${instances++}`);
  const paths = { databasePath: join(root, "mastra.db"), outboxDirectory: join(root, "outbox") };
  const mailbox = memoryMailbox();
  mailbox.deliver(buildEml(pdfMail("refused@shop.example")));
  const mailer = recordingMailer();
  mailer.failNext("autobox@sevdesk.example");
  const runtime = createIntakeRuntime(paths, {
    dateExtractor: scriptedDateExtractor(() => ({ year: 2026, month: 10, day: 1 })).layer,
    mailer: mailer.layer,
    mailbox: mailbox.layer,
  });
  const forwarding = {
    from: "hex@example.com",
    targets: [{ name: "sevdesk", to: "autobox@sevdesk.example" }],
  };
  try {
    await withServer(
      {
        databasePath: paths.databasePath,
        workflows: {
          [INTAKE_WORKFLOW_ID]: createIntakeWorkflow({ runtime, category: "ER", forwarding }),
        },
        mailbox: { runtime, pollMs: 60_000 },
      },
      async () => {
        await within(mailbox.waiting(), "the watcher's first look");
        // Kept for the next run to try again.
        expect(mailbox.messageIds()).toEqual(["refused@shop.example"]);
        expect(printed).toContainEqual(
          expect.stringMatching(
            /^warn: hex: Intake refused@shop\.example: the run failed: forwarding to sevdesk.*failed run 1 of 5/,
          ),
        );
        expect(printed.filter((line) => line.includes("Error executing step"))).toEqual([]);
        expect(printed.filter((line) => line.startsWith("error: "))).toEqual([]);
      },
    );
  } finally {
    await runtime.dispose();
  }
});

// A step that throws a plain Error, a defect; the Intake workflow's own ids make no difference.
test.each([
  ["another workflow's step", "broken", "explode"],
  ["the Intake workflow's move step, but not a failed run", INTAKE_WORKFLOW_ID, "move-mail"],
])("a defect in %s still logs its error and stack", async (_, workflowId, stepId) => {
  const broken = oneStep(
    workflowId,
    async () => {
      throw new Error("the step broke");
    },
    stepId,
  );
  await withServer({ workflows: { [workflowId]: broken } }, async (server) => {
    const run = await server.mastra.getWorkflow(workflowId).createRun();
    const result = await run.start({ inputData: { message: "hi" } });
    expect(result.status).toBe("failed");
    const lines = printed.filter((line) => line.includes("Error executing step"));
    expect(lines).toEqual([
      expect.stringMatching(
        new RegExp(
          `^error: \\[WORKFLOW\\] Error executing step workflow\\.${workflowId}\\.step\\.${stepId}: Error: the step broke\\n\\s+at `,
        ),
      ),
    ]);
  });
});
