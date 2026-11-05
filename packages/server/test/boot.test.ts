// Walkthrough: hex is killed while an Intake run waits for the model; started again, it resumes
// the run where it stopped, finishes it and moves the mail, without forwarding twice. Real
// processes (boot-entry.ts), on an in-memory Mailbox: a real one would need an IMAP server; the
// live IMAP Mailbox is proven by the manual smoke instead.
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

/** The first model call hangs (hex gets killed meanwhile); later ones read 1 October 2026. */
const hanging = Promise.withResolvers<string>();
const firstCall = Promise.withResolvers<void>();
const model = fakeOpenAI((request) => {
  if (model.requests.indexOf(request) > 0) return '{"year":2026,"month":10,"day":1}';
  firstCall.resolve();
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

/** hex on the data in `directory` with `eml` in its mailbox; its stdout, read as it comes. */
function startHex(eml: string) {
  const child = Bun.spawn(["bun", entry, join(directory, "data"), eml], {
    env: {
      ...process.env,
      MASTRA_TELEMETRY_DISABLED: "1",
      DO_NOT_TRACK: "1",
      // A killed run's ownership lease lapses after 1 s instead of 15 s, so the next start
      // restarts it at once instead of a re-check later.
      MASTRA_AGENT_THREAD_LEASE_TTL_MS: "1000",
      OPENAI_BASE_URL: model.baseUrl,
      OPENAI_API_KEY: "sk-hex-boot-test",
      HEX_SMTP_PORT: String(smtp.port),
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  let output = "";
  const waiters: { pattern: RegExp; resolve: () => void }[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      output += decoder.decode(chunk, { stream: true });
      for (const waiter of waiters.filter(({ pattern }) => pattern.test(output))) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  })();
  return {
    child,
    output: () => output,
    /** Resolves once stdout shows `pattern`. */
    printed(pattern: RegExp) {
      if (pattern.test(output)) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      waiters.push({ pattern, resolve });
      return within(promise, `stdout to show ${pattern}`, 30_000);
    },
  };
}

test("a run cut off by a kill resumes at the next start, moves its mail, forwards once", async () => {
  const eml = join(directory, "resume.eml");
  await writeFile(
    eml,
    buildEml({
      messageId: "resume@shop.example",
      received: RECEIVED,
      parts: [pdf("Rechnung.pdf", pdfBytes(600))],
    }),
  );

  const first = startHex(eml);
  try {
    // Forwarded, then killed while the model reads the Document date.
    await within(firstCall.promise, "the first run's model call", 30_000);
    expect(smtp.mails).toHaveLength(1);
  } finally {
    first.child.kill("SIGKILL");
  }
  await first.child.exited;
  expect(first.output()).not.toContain("moved");

  const second = startHex(eml);
  try {
    await second.printed(/moved 1 resume@shop\.example to hex\/processed/);
    await second.printed(/^booted$/m);
    // The watcher looked alongside the sweep, while the run stayed active (Mastra restarts it once
    // the killed process's lease lapsed): it left the Intake to the run, which started at the
    // step that was cut off. No second run, no second Forwarding.
    expect(model.requests).toHaveLength(2);
    expect(smtp.mails).toHaveLength(1);
    expect(await readdir(join(directory, "data", "outbox", "2026-10", "ER"))).toEqual([
      "Rechnung.pdf",
    ]);
  } finally {
    second.child.kill("SIGTERM");
  }
  expect(await second.child.exited).toBe(0);
  // One run in all, the first one, finished by the second hex: none started anew.
  const database = new Database(join(directory, "data", "mastra.db"), { readonly: true });
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
}, 60_000);
