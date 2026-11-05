import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, readdir, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntakeLedger, createLocalStore, intakeLedgerLayer, readEml } from "@hex/adapters";
import { MIN_IMAGE_DOCUMENT_BYTES } from "@hex/domain";
import { Mastra } from "@mastra/core/mastra";
import { Effect } from "effect";
import {
  INTAKE_WORKFLOW_ID,
  createIntakeRuntime,
  createIntakeWorkflow,
} from "../src/intake-workflow";
import { buildEml, bytes } from "./eml";
import type { Mail } from "./eml";

let directory: string;
let instances = 0;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-intake-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** 00:30 on 1 November in Berlin: filed under November although it is still October in UTC. */
const received = "Sat, 31 Oct 2026 23:30:00 +0000";
const pdf = (fileName: string, content = bytes(500, "p")) => ({
  contentType: "application/pdf",
  disposition: "attachment",
  fileName,
  content,
});

/** A fresh data directory and Outbox, and the real Intake workflow on them. */
function freshHex() {
  const root = join(directory, `hex-${instances++}`);
  const paths = { databasePath: join(root, "mastra.db"), outboxDirectory: join(root, "outbox") };
  return {
    ...paths,
    /** Runs the workflow once on `mail`, as the dev command would, and returns the run result. */
    async process(mail: Mail) {
      const intake = await Effect.runPromise(readEml(buildEml(mail), "test.eml"));
      const storage = await createLocalStore(paths.databasePath);
      const runtime = createIntakeRuntime(paths);
      const workflow = createIntakeWorkflow({ runtime, category: "ER" });
      const mastra = new Mastra({
        storage,
        logger: false,
        workflows: { [INTAKE_WORKFLOW_ID]: workflow },
      });
      try {
        await storage.init();
        const run = await mastra.getWorkflow(INTAKE_WORKFLOW_ID).createRun();
        return await run.start({ inputData: intake });
      } finally {
        await mastra.shutdown();
        await storage.close();
        await runtime.dispose();
      }
    },
    /** Every file in the Outbox, relative, with its content. */
    async outbox(): Promise<Record<string, string>> {
      const root = paths.outboxDirectory;
      const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
      const files: Record<string, string> = {};
      for (const entry of entries.filter((candidate) => candidate.isFile())) {
        const path = join(entry.parentPath, entry.name);
        files[path.slice(root.length + 1)] = await readFile(path, "utf8");
      }
      return files;
    },
    /** The ledger entry for a Message-ID, read through the ledger itself. */
    ledger(messageId: string) {
      return Effect.runPromise(
        IntakeLedger.use((ledger) => ledger.find(messageId)).pipe(
          Effect.provide(intakeLedgerLayer(paths.databasePath)),
        ),
      );
    },
  };
}

function succeeded<R extends { status: string }>(result: R) {
  if (result.status !== "success")
    throw new Error(`run ${result.status}: ${JSON.stringify(result)}`);
  return (result as R & { result: unknown }).result;
}

describe("Intake workflow", () => {
  test("happy path: files each Document under the received month, records the Intake", async () => {
    const hex = freshHex();
    const scan = bytes(MIN_IMAGE_DOCUMENT_BYTES, "s");
    const result = await hex.process({
      messageId: "happy@shop.example",
      received,
      parts: [
        pdf("Rechnung 2026-10.pdf", bytes(500, "a")),
        {
          contentType: "image/jpeg",
          disposition: "attachment",
          fileName: "Beleg.jpg",
          content: scan,
        },
        pdf("Rechnung 2026-10.pdf", bytes(500, "b")),
      ],
    });
    const filings = [
      { path: "2026-11/ER/Rechnung 2026-10.pdf" },
      { path: "2026-11/ER/Beleg.jpg" },
      { path: "2026-11/ER/Rechnung 2026-10 (1).pdf" },
    ];
    expect(succeeded(result)).toEqual({
      messageId: "happy@shop.example",
      status: "processed",
      filings,
    });
    expect(await hex.outbox()).toEqual({
      "2026-11/ER/Rechnung 2026-10.pdf": "a".repeat(500),
      "2026-11/ER/Beleg.jpg": "s".repeat(MIN_IMAGE_DOCUMENT_BYTES),
      "2026-11/ER/Rechnung 2026-10 (1).pdf": "b".repeat(500),
    });
    expect(await hex.ledger("happy@shop.example")).toMatchObject({ documentCount: 3, filings });
  });

  test("non-Document attachments are ignored: inline logos, tiny images, other types", async () => {
    const hex = freshHex();
    const big = bytes(MIN_IMAGE_DOCUMENT_BYTES);
    const result = await hex.process({
      messageId: "mixed@shop.example",
      received,
      html: '<img src="cid:logo@shop"><img src="cid:banner@shop">',
      parts: [
        { contentType: "image/png", disposition: "inline", contentId: "logo@shop", content: big },
        // Attachment disposition, but the body shows it: decoration.
        {
          contentType: "image/png",
          disposition: "attachment",
          fileName: "banner.png",
          contentId: "banner@shop",
          content: big,
        },
        {
          contentType: "image/gif",
          disposition: "attachment",
          fileName: "pixel.gif",
          content: bytes(43),
        },
        {
          contentType: "text/calendar",
          disposition: "attachment",
          fileName: "termin.ics",
          content: big,
        },
        {
          contentType: "text/plain",
          disposition: "attachment",
          fileName: "notes.txt",
          content: big,
        },
        {
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          disposition: "attachment",
          fileName: "brief.docx",
          content: big,
        },
        // Apple Mail: a scan sent inline, not referenced by the body.
        {
          contentType: "application/pdf",
          disposition: "inline",
          fileName: "Scan.pdf",
          content: bytes(9),
        },
      ],
    });
    expect(succeeded(result)).toEqual({
      messageId: "mixed@shop.example",
      status: "processed",
      filings: [{ path: "2026-11/ER/Scan.pdf" }],
    });
    expect(Object.keys(await hex.outbox())).toEqual(["2026-11/ER/Scan.pdf"]);
  });

  test("an Intake without Documents is recorded as processed with no Filings", async () => {
    const hex = freshHex();
    const result = await hex.process({
      messageId: "nothing@shop.example",
      received,
      parts: [
        {
          contentType: "text/calendar",
          disposition: "attachment",
          fileName: "x.ics",
          content: bytes(10),
        },
      ],
    });
    expect(succeeded(result)).toEqual({
      messageId: "nothing@shop.example",
      status: "processed",
      filings: [],
    });
    expect(await hex.outbox()).toEqual({});
    expect(await hex.ledger("<nothing@shop.example>")).toMatchObject({
      documentCount: 0,
      filings: [],
    });
  });

  test("an already processed Message-ID is skipped: nothing filed again", async () => {
    const hex = freshHex();
    const mail = { messageId: "twice@shop.example", received, parts: [pdf("Rechnung.pdf")] };
    const first = succeeded(await hex.process(mail));
    const entry = await hex.ledger("twice@shop.example");
    const second = succeeded(await hex.process(mail));
    expect(second).toEqual({
      messageId: "twice@shop.example",
      status: "already-processed",
      filings: [{ path: "2026-11/ER/Rechnung.pdf" }],
    });
    expect(first).toMatchObject({ status: "processed" });
    expect(Object.keys(await hex.outbox())).toEqual(["2026-11/ER/Rechnung.pdf"]);
    // The ledger entry is the first run's, untouched.
    expect(await hex.ledger("twice@shop.example")).toEqual(entry);
  });

  test("hostile file names never leave <Outbox>/YYYY-MM/ER/", async () => {
    const hex = freshHex();
    const result = await hex.process({
      messageId: "hostile@shop.example",
      received,
      parts: [
        pdf("../../x.pdf"),
        pdf("a/b.pdf"),
        pdf(""),
        pdf("x.pdf.partial"),
        pdf("..\\..\\win.pdf"),
        pdf("."),
      ],
    });
    expect(succeeded(result)).toMatchObject({
      filings: [
        { path: "2026-11/ER/x.pdf" },
        { path: "2026-11/ER/b.pdf" },
        { path: "2026-11/ER/document-3.pdf" },
        { path: "2026-11/ER/x (1).pdf" },
        { path: "2026-11/ER/win.pdf" },
        { path: "2026-11/ER/document-6.pdf" },
      ],
    });
    const files = Object.keys(await hex.outbox());
    expect(files).toHaveLength(6);
    for (const path of files) expect(path).toMatch(/^2026-11\/ER\/[^/]+$/);
    expect(files.some((path) => path.endsWith(".partial"))).toBe(false);
    // Nothing next to the Outbox either: only the database (and its WAL files) and the Outbox.
    const siblings = await readdir(join(hex.outboxDirectory, ".."));
    expect(siblings.filter((name) => !name.startsWith("mastra.db"))).toEqual(["outbox"]);
  });
});
