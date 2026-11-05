import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntakeLedger, intakeLedgerLayer, readEml } from "@hex/adapters";
import type { Intake } from "@hex/adapters";
import { MIN_IMAGE_DOCUMENT_BYTES } from "@hex/domain";
import { Effect } from "effect";
import { runIntake } from "../src/intake-workflow";
import { buildEml, bytes, pdf } from "./eml";
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

/** A fresh data directory and Outbox, and the real Intake workflow on them. */
function freshHex() {
  const root = join(directory, `hex-${instances++}`);
  const paths = { databasePath: join(root, "mastra.db"), outboxDirectory: join(root, "outbox") };
  return {
    ...paths,
    /** Runs the workflow once on `mail`, as the dev command does, and returns its result. */
    async process(mail: Mail) {
      const intake = await Effect.runPromise(readEml(buildEml(mail), "test.eml"));
      return runIntake(intake, { paths, category: "ER" });
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
      { index: 0, path: "2026-11/ER/Rechnung 2026-10.pdf" },
      { index: 1, path: "2026-11/ER/Beleg.jpg" },
      { index: 2, path: "2026-11/ER/Rechnung 2026-10 (1).pdf" },
    ];
    expect(result).toEqual({
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
        // Apple Mail: a scan sent inline with a Content-ID the body doesn't reference.
        {
          contentType: "application/pdf",
          disposition: "inline",
          fileName: "Scan.pdf",
          contentId: "scan-part@apple.example",
          content: bytes(9),
        },
      ],
    });
    expect(result).toEqual({
      messageId: "mixed@shop.example",
      status: "processed",
      filings: [{ index: 6, path: "2026-11/ER/Scan.pdf" }],
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
    expect(result).toEqual({
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
    const first = await hex.process(mail);
    const entry = await hex.ledger("twice@shop.example");
    const second = await hex.process(mail);
    expect(second).toEqual({
      messageId: "twice@shop.example",
      status: "already-processed",
      filings: [{ index: 0, path: "2026-11/ER/Rechnung.pdf" }],
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
        {
          contentType: "application/pdf",
          disposition: "attachment",
          encodedFileName: "..%2F..%2Fencoded.pdf",
          content: bytes(5),
        },
      ],
    });
    const paths = [
      "2026-11/ER/x.pdf",
      "2026-11/ER/b.pdf",
      "2026-11/ER/document-3.pdf",
      "2026-11/ER/x (1).pdf",
      "2026-11/ER/win.pdf",
      "2026-11/ER/document-6.pdf",
      "2026-11/ER/encoded.pdf",
    ];
    expect(result).toEqual({
      messageId: "hostile@shop.example",
      status: "processed",
      filings: paths.map((path, index) => ({ index, path })),
    });
    expect(Object.keys(await hex.outbox()).sort()).toEqual([...paths].sort());
    // Nothing next to the Outbox either: only the database (and its WAL files) and the Outbox.
    const siblings = await readdir(join(hex.outboxDirectory, ".."));
    expect(siblings.filter((name) => !name.startsWith("mastra.db"))).toEqual(["outbox"]);
  });

  describe("an Intake sent as workflow input (workflows.start) is held to the reader's rules", () => {
    const base = {
      messageId: "<api@shop.example>",
      receivedAt: "2026-11-02T07:15:00.000Z",
      cidReferences: [],
      attachments: [] as Intake["attachments"],
    };

    test("an impossible receivedAt is rejected before anything is filed", async () => {
      const hex = freshHex();
      const intake = { ...base, receivedAt: "2026-02-30T10:00:00.000Z", attachments: [apiPdf] };
      await expect(runIntake(intake, { paths: hex, category: "ER" })).rejects.toThrow(
        "a real UTC instant",
      );
      expect(await hex.outbox()).toEqual({});
    });

    test("an image's size is its content's, whatever size the caller claims", async () => {
      const hex = freshHex();
      const tinyImage = {
        mimeType: "image/png",
        fileName: "pixel.png",
        content: Buffer.from("x".repeat(50)).toString("base64"),
        size: 20_000,
      };
      const result = await runIntake({ ...base, attachments: [tinyImage] } as unknown as Intake, {
        paths: hex,
        category: "ER",
      });
      expect(result.filings).toEqual([]);
      expect(await hex.outbox()).toEqual({});
    });

    test("content that is not canonical base64 is rejected, so padding can't fake a size", async () => {
      const hex = freshHex();
      const padded = {
        mimeType: "image/png",
        fileName: "pixel.png",
        content: `AAAA${" ".repeat(30_000)}`,
      };
      await expect(
        runIntake({ ...base, attachments: [padded] }, { paths: hex, category: "ER" }),
      ).rejects.toThrow("content");
      expect(await hex.outbox()).toEqual({});
    });

    test("a Message-ID that is blank once unbracketed is rejected as input", async () => {
      const hex = freshHex();
      await expect(
        runIntake(
          { ...base, messageId: "<>", attachments: [apiPdf] },
          { paths: hex, category: "ER" },
        ),
      ).rejects.toThrow("a Message-ID that is not blank");
      expect(await hex.outbox()).toEqual({});
    });

    test("the result names the normalised Message-ID, on both runs", async () => {
      const hex = freshHex();
      const intake = { ...base, attachments: [apiPdf] };
      const first = await runIntake(intake, { paths: hex, category: "ER" });
      const second = await runIntake(intake, { paths: hex, category: "ER" });
      expect([first.messageId, second.messageId]).toEqual(["api@shop.example", "api@shop.example"]);
      expect(second.status).toBe("already-processed");
    });
  });
});

const apiPdf = {
  mimeType: "application/pdf",
  fileName: "api.pdf",
  content: Buffer.from("%PDF").toString("base64"),
};
