// What the server's log shows of a failed Intake run: for a run the mailbox watcher follows, hex's
// own line, not the error and stack Mastra logs for the step error that ends the run on purpose.
// Any other run of it, and any other step error, still logs both.
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEml } from "@hex/adapters";
import { ErrorCategory, ErrorDomain, MastraBaseError, MastraError } from "@mastra/core/error";
import { ConsoleLogger, LogLevel, isAdaptableLogger } from "@mastra/core/logger";
import type { IMastraLogger } from "@mastra/core/logger";
import { Effect } from "effect";
import { startServer } from "../src";
import type { RunningServer, ServerOptions } from "../src";
import { FollowedRuns } from "../src/followed-runs";
import {
  FailedRunError,
  INTAKE_WORKFLOW_ID,
  createIntakeRuntime,
  createIntakeWorkflow,
} from "../src/intake-workflow";
import { mailFateOf } from "../src/mail-fate";
import { buildEml, pdfMail } from "./eml";
import { memoryMailbox } from "./memory-mailbox";
import { recordingMailer } from "./recording-mailer";
import { scriptedDateExtractor } from "./scripted-extractor";
import { oneStep, serverOptions } from "./server-helpers";
import { within } from "./timeouts";

let directory: string;
let instances = 0;
/** Every line the console printed, as `level: text`. */
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

/**
 * Starts a server with `options`, logging on a console logger at warn level as in production, or
 * with no logger given (Mastra's default) when `options.logger` is `"default"`, and records the
 * exceptions Mastra tracks.
 */
async function withServer(
  {
    logger = new ConsoleLogger({ level: LogLevel.WARN }),
    ...options
  }: Partial<Omit<ServerOptions, "logger">> & { logger?: IMastraLogger | "default" },
  check: (server: RunningServer, tracked: unknown[]) => Promise<void>,
) {
  printed = [];
  const tracked: unknown[] = [];
  const spies = [
    capture("error"),
    capture("warn"),
    // Mastra's components log through children of the logger, each a ConsoleLogger of its own.
    spyOn(ConsoleLogger.prototype, "trackException").mockImplementation((exception) => {
      tracked.push(exception);
    }),
  ];
  const resolved = serverOptions(directory, `hex-${instances++}`, options);
  if (logger === "default") delete resolved.logger;
  else resolved.logger = logger;
  const server = await startServer(resolved);
  try {
    await check(server, tracked);
  } finally {
    await server.stop();
    for (const spy of spies) spy.mockRestore();
  }
}

/** The errors the step exceptions among `tracked` were tracked for. */
const trackedCauses = (tracked: unknown[]) =>
  tracked.flatMap((exception) => (exception instanceof MastraBaseError ? [exception.cause] : []));

/**
 * An Intake workflow whose Forwarding to sevdesk is refused, on a mailbox holding the mail of
 * Message-ID `messageId`. `followedWhileRunning` holds how many runs the runtime's
 * {@link FollowedRuns} held each time a run reached its date extraction. `dispose()` the runtime
 * when done.
 */
function refusedForwarding(messageId: string) {
  const root = join(directory, `intake-${instances++}`);
  const paths = { databasePath: join(root, "mastra.db"), outboxDirectory: join(root, "outbox") };
  const mailbox = memoryMailbox();
  const eml = buildEml(pdfMail(messageId));
  mailbox.deliver(eml);
  const mailer = recordingMailer();
  mailer.failNext("autobox@sevdesk.example");
  const followedWhileRunning: number[] = [];
  const runtime = createIntakeRuntime(paths, {
    dateExtractor: scriptedDateExtractor(async () => {
      followedWhileRunning.push(await runtime.runPromise(followedCount));
      return { year: 2026, month: 10, day: 1 };
    }).layer,
    mailer: mailer.layer,
    mailbox: mailbox.layer,
  });
  const forwarding = {
    from: "hex@example.com",
    targets: [{ name: "sevdesk", to: "autobox@sevdesk.example" }],
  };
  return {
    mailbox,
    eml,
    runtime,
    followedWhileRunning,
    /** Registers the workflow, without the mailbox watcher. */
    options: {
      databasePath: paths.databasePath,
      workflows: {
        [INTAKE_WORKFLOW_ID]: createIntakeWorkflow({ runtime, category: "ER", forwarding }),
      },
    },
  };
}

/** How many runs the Intake runtime's {@link FollowedRuns} holds. */
const followedCount = FollowedRuns.useSync((runs) => runs.size);

test("a failed Intake run the watcher follows logs hex's line and no step error or stack from Mastra", async () => {
  const { mailbox, runtime, followedWhileRunning, options } =
    refusedForwarding("refused@shop.example");
  try {
    await withServer(
      { ...options, mailbox: { runtime, pollMs: 60_000 } },
      async (server, tracked) => {
        // Mastra attaches trace correlation and observability export through hex's logger.
        expect(isAdaptableLogger(server.mastra.getLogger())).toBe(true);
        await within(mailbox.waiting(), "the watcher's first look");
        // Kept for the next run to try again.
        expect(mailbox.messageIds()).toEqual(["refused@shop.example"]);
        // Followed while it ran, and no longer once it ended.
        expect(followedWhileRunning).toEqual([1]);
        expect(await runtime.runPromise(followedCount)).toBe(0);
        expect(printed).toContainEqual(
          expect.stringMatching(
            /^warn: hex: Intake refused@shop\.example: the run failed: forwarding to sevdesk.*failed run 1 of 5/,
          ),
        );
        expect(printed.filter((line) => line.includes("Error executing step"))).toEqual([]);
        expect(printed.filter((line) => line.startsWith("error: "))).toEqual([]);
        expect(trackedCauses(tracked).filter((cause) => cause instanceof FailedRunError)).toEqual(
          [],
        );
      },
    );
  } finally {
    await runtime.dispose();
  }
});

test("a failed Intake run the watcher follows logs no step error on Mastra's default logger either", async () => {
  const { mailbox, runtime, options } = refusedForwarding("default-logger@shop.example");
  try {
    await withServer(
      { ...options, mailbox: { runtime, pollMs: 60_000 }, logger: "default" },
      async () => {
        await within(mailbox.waiting(), "the watcher's first look");
        expect(printed).toContainEqual(
          expect.stringMatching(
            /^warn: hex: Intake default-logger@shop\.example: the run failed: forwarding to sevdesk/,
          ),
        );
        expect(printed.filter((line) => line.includes("Error executing step"))).toEqual([]);
      },
    );
  } finally {
    await runtime.dispose();
  }
});

test("a failed Intake run no watcher follows keeps Mastra's step error and stack", async () => {
  const { eml, runtime, options } = refusedForwarding("unfollowed@shop.example");
  try {
    await withServer(options, async (server) => {
      const intake = await Effect.runPromise(readEml(eml, "unfollowed.eml"));
      const run = await server.mastra.getWorkflow(INTAKE_WORKFLOW_ID).createRun();
      const result = await run.start({ inputData: intake });
      expect(result.status).toBe("failed");
      // The run's error carries what became of its mail, as a followed run's does.
      expect(mailFateOf("error" in result ? result.error : undefined)).toEqual({
        status: "kept-for-retry",
      });
      expect(printed.filter((line) => line.includes("Error executing step"))).toEqual([
        expect.stringMatching(
          /^error: \[WORKFLOW\] Error executing step workflow\.intake\.step\.move-mail: Error: forwarding to sevdesk.*failed run 1 of 5.*\n\s+at /s,
        ),
      ]);
    });
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
  await withServer({ workflows: { [workflowId]: broken } }, async (server, tracked) => {
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
    // Tracked as an exception too, for observability.
    expect(trackedCauses(tracked)).toEqual([
      expect.objectContaining({ message: "the step broke" }),
    ]);
  });
});

test("after a failed run's step error is tracked, only the exact line Mastra logs for it is dropped", async () => {
  await withServer({}, async (server) => {
    const logger = server.mastra.getLogger();
    const cause = new FailedRunError("forwarding to sevdesk: refused", undefined, undefined);
    const stepError = new MastraError(
      {
        id: "WORKFLOW_STEP_INVOKE_FAILED",
        domain: ErrorDomain.MASTRA_WORKFLOW,
        category: ErrorCategory.USER,
        details: { workflowId: INTAKE_WORKFLOW_ID, runId: "run-1", stepId: "move-mail" },
      },
      cause,
    );
    // Mastra logs its step error line right after tracking the error: any other line still prints.
    logger.trackException(stepError);
    logger.error("the storage broke");
    logger.trackException(stepError);
    logger.error(`Error executing step move-mail: ${cause.stack}`);
    expect(printed.filter((line) => line.startsWith("error: "))).toEqual([
      expect.stringContaining("the storage broke"),
    ]);
  });
});
