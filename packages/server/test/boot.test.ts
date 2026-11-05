// Walkthrough: hex is killed while an Intake run waits for the model; started again, it resumes
// the run where it stopped, finishes it and moves the mail, without forwarding twice, while the
// mailbox watcher, started alongside, leaves that Intake to the run. Real processes
// (boot-entry.ts), on an in-memory Mailbox: a real one would need an IMAP server; the live IMAP
// Mailbox is proven by the manual smoke instead.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RECEIVED, buildEml, pdf, pdfBytes } from "./eml";
import { fakeOpenAI } from "./fake-openai";
import { fakeSmtp } from "./fake-smtp";
import { within } from "./timeouts";

const entry = fileURLToPath(new URL("./boot-entry.ts", import.meta.url));
let directory: string;

/** The first model call after `hangNext` is set hangs (hex gets killed meanwhile). */
const hanging = Promise.withResolvers<string>();
let hangNext = false;
let hung = Promise.withResolvers<void>();
const model = fakeOpenAI(() => {
  if (!hangNext) return '{"year":2026,"month":10,"day":1}';
  hangNext = false;
  hung.resolve();
  return hanging.promise;
});
const smtp = fakeSmtp();

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-boot-"));
});

afterAll(async () => {
  hanging.resolve('{"year":null,"month":null,"day":null}');
  await model.server.stop(true);
  smtp.server.stop(true);
  await rm(directory, { recursive: true, force: true });
});

/**
 * hex on the data in `data` with `eml` in its mailbox, a killed run's ownership lease lapsing
 * after `leaseMs`; its stdout and stderr (Mastra's warnings), read as they come.
 */
function startHex(data: string, eml: string, leaseMs: number) {
  const child = Bun.spawn(["bun", entry, data, eml], {
    env: {
      ...process.env,
      MASTRA_TELEMETRY_DISABLED: "1",
      DO_NOT_TRACK: "1",
      // Mastra derives the workflow runs' ownership lease from it (15 s by default).
      MASTRA_AGENT_THREAD_LEASE_TTL_MS: String(leaseMs),
      OPENAI_BASE_URL: model.baseUrl,
      OPENAI_API_KEY: "sk-hex-boot-test",
      HEX_SMTP_PORT: String(smtp.port),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  const waiters: { pattern: RegExp; resolve: () => void }[] = [];
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true });
      for (const waiter of waiters.filter(({ pattern }) => pattern.test(output))) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };
  void read(child.stdout);
  void read(child.stderr);
  return {
    child,
    output: () => output,
    /** Resolves once the output shows `pattern`. */
    printed(pattern: RegExp) {
      if (pattern.test(output)) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      waiters.push({ pattern, resolve });
      return within(promise, `the output to show ${pattern}`, 30_000);
    },
  };
}

test.each([
  ["restarted by the boot sweep or once the lease lapsed", 1000, "after-restart", false],
  // The second hex starts well within 4 s of the kill: the sweep skips the run, still owned by
  // the killed process, and Mastra restarts it once the lease lapsed.
  ["skipped for the killed process's live lease, restarted later", 4000, "after-lease", true],
] as const)(
  "a run cut off by a kill (%s) resumes at the next start, moves its mail, forwards once; the watcher leaves it alone",
  async (_path, leaseMs, name, leaseSkip) => {
    const data = join(directory, name);
    const messageId = `${name}@shop.example`;
    const eml = join(directory, `${name}.eml`);
    await writeFile(
      eml,
      buildEml({ messageId, received: RECEIVED, parts: [pdf("Rechnung.pdf", pdfBytes(600))] }),
    );
    const requestsBefore = model.requests.length;
    const mailsBefore = smtp.mails.length;
    hung = Promise.withResolvers<void>();
    hangNext = true;

    const first = startHex(data, eml, leaseMs);
    try {
      // Forwarded, then killed while the model reads the Document date.
      await within(hung.promise, "the first run's model call", 30_000);
      expect(smtp.mails).toHaveLength(mailsBefore + 1);
    } finally {
      first.child.kill("SIGKILL");
    }
    await first.child.exited;
    expect(first.output()).not.toContain("moved");

    const second = startHex(data, eml, leaseMs);
    try {
      const moved = new RegExp(`moved 1 ${messageId.replace(".", "\\.")} to hex/processed`);
      await second.printed(moved);
      await second.printed(/^booted$/m);
      // The watcher looked while the run was active, and left the Intake to it.
      const output = second.output();
      const active = output.search(new RegExp(`Intake ${messageId}: its run \\S+ is active`));
      expect(active).toBeGreaterThanOrEqual(0);
      expect(active).toBeLessThan(output.search(moved));
      // The resumed run started at the step that was cut off: one more model call, no second
      // Forwarding, and no run of the watcher's own.
      expect(model.requests).toHaveLength(requestsBefore + 2);
      expect(smtp.mails).toHaveLength(mailsBefore + 1);
      if (leaseSkip) {
        // Mastra's debug line for the sweep's skip.
        expect(output).toContain("Skipped restarting workflow run owned by a live process");
      }
      expect(await readdir(join(data, "outbox", "2026-10", "ER"))).toEqual(["Rechnung.pdf"]);
    } finally {
      second.child.kill("SIGTERM");
    }
    expect(await second.child.exited).toBe(0);
    // One run in all, the first one, finished by the second hex: none started anew.
    const database = new Database(join(data, "mastra.db"), { readonly: true });
    try {
      const runs = database
        .query(
          "SELECT json_extract(snapshot, '$.status') AS status FROM mastra_workflow_snapshot WHERE workflow_name = 'intake'",
        )
        .all();
      expect(runs).toEqual([{ status: "success" }]);
    } finally {
      database.close();
    }
  },
  60_000,
);
