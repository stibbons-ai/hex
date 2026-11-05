import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DateExtractionError,
  DateExtractor,
  IntakeLedger,
  intakeLedgerLayer,
  readEml,
} from "@hex/adapters";
import type { DocumentFile, Intake, OutgoingMail } from "@hex/adapters";
import { MIN_IMAGE_DOCUMENT_BYTES } from "@hex/domain";
import { Effect, Layer } from "effect";
import { loadForwardingConfig } from "../src/config";
import { IntakeRunError, runIntake } from "../src/intake-workflow";
import type { IntakeForwarding } from "../src/intake-workflow";
import { buildEml, bytes, jpegBytes, pdf, pdfBytes } from "./eml";
import type { Mail } from "./eml";
import { recordingMailer } from "./recording-mailer";

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

/** The model's answer when a Document shows no date. */
const NO_DATE = { year: null, month: null, day: null };

/**
 * What the scripted DateExtractor answers for a Document, standing in for the model's answer;
 * an Error fails the call as a failed model call would.
 */
type Script = (document: DocumentFile) => unknown;

/**
 * A fresh data directory and Outbox, and the real Intake workflow on them with a scripted
 * DateExtractor that answers by `script` and records every Document it was asked about, and a
 * recording Mailer forwarding as `forwarding` says (off when absent).
 */
function freshHex(script: Script = () => NO_DATE, forwarding?: IntakeForwarding) {
  const root = join(directory, `hex-${instances++}`);
  const paths = { databasePath: join(root, "mastra.db"), outboxDirectory: join(root, "outbox") };
  const asked: DocumentFile[] = [];
  const dateExtractor = Layer.succeed(DateExtractor, {
    extract: (document) =>
      Effect.suspend(() => {
        asked.push(document);
        const answer = script(document);
        return answer instanceof Error
          ? Effect.fail(new DateExtractionError({ message: answer.message }))
          : Effect.succeed(answer);
      }),
  });
  const mailer = recordingMailer();
  /** Runs the workflow once on `intake`, as the dev command does, and returns its result. */
  const run = (intake: Intake) =>
    runIntake(intake, { paths, category: "ER", dateExtractor, mailer: mailer.layer, forwarding });
  return {
    ...paths,
    asked,
    mailer,
    run,
    /** Runs the workflow once on `mail` read as an `.eml`. */
    async process(mail: Mail) {
      return run(await Effect.runPromise(readEml(buildEml(mail), "test.eml")));
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
    /** The branches recorded for a Message-ID so far, read through the ledger itself. */
    branches(messageId: string) {
      return Effect.runPromise(
        IntakeLedger.use((ledger) => ledger.branches(messageId)).pipe(
          Effect.provide(intakeLedgerLayer(paths.databasePath)),
        ),
      );
    },
  };
}

describe("Intake workflow", () => {
  test("happy path: files each Document by its Document date, records the Intake", async () => {
    const dates: Record<string, unknown> = {
      a: { year: 2026, month: 9, day: 15 },
      s: { year: 2026, month: 10, day: 3 },
      b: { year: 2026, month: 9, day: 30 },
    };
    // Answers by the Document's filler, which is a run of one letter after its header.
    const hex = freshHex(({ content }) => dates[String.fromCharCode(content.at(-1)!)]);
    const first = pdfBytes(500, "a");
    const scan = jpegBytes(MIN_IMAGE_DOCUMENT_BYTES, "s");
    const second = pdfBytes(500, "b");
    const result = await hex.process({
      messageId: "happy@shop.example",
      received,
      parts: [
        pdf("Rechnung 2026-10.pdf", first),
        {
          contentType: "image/jpeg",
          disposition: "attachment",
          fileName: "Beleg.jpg",
          content: scan,
        },
        pdf("Rechnung 2026-10.pdf", second),
      ],
    });
    const filings = [
      { index: 0, path: "2026-09/ER/Rechnung 2026-10.pdf", fellBack: false },
      { index: 1, path: "2026-10/ER/Beleg.jpg", fellBack: false },
      { index: 2, path: "2026-09/ER/Rechnung 2026-10 (1).pdf", fellBack: false },
    ];
    expect(result).toEqual({
      messageId: "happy@shop.example",
      status: "processed",
      filings,
      forwardings: [],
    });
    const text = (content: Uint8Array) => new TextDecoder().decode(content);
    expect(await hex.outbox()).toEqual({
      "2026-09/ER/Rechnung 2026-10.pdf": text(first),
      "2026-10/ER/Beleg.jpg": text(scan),
      "2026-09/ER/Rechnung 2026-10 (1).pdf": text(second),
    });
    expect(await hex.ledger("happy@shop.example")).toMatchObject({ documentCount: 3, filings });
    // Each Document went to the extractor whole, with the media type the model gets.
    expect(hex.asked).toEqual([
      { content: first, mediaType: "application/pdf", fileName: "Rechnung 2026-10.pdf" },
      { content: scan, mediaType: "image/jpeg", fileName: "Beleg.jpg" },
      { content: second, mediaType: "application/pdf", fileName: "Rechnung 2026-10.pdf" },
    ]);
  });

  test.each([
    ["no date found (all null)", NO_DATE],
    ["some fields null", { year: 2026, month: 9, day: null }],
    ["no answer (Mastra couldn't parse it)", undefined],
    ["not an object", "15.09.2026"],
    ["string fields", { year: "2026", month: "9", day: "15" }],
    ["a fractional day", { year: 2026, month: 9, day: 15.5 }],
    ["30 February", { year: 2026, month: 2, day: 30 }],
    ["month 13", { year: 2026, month: 13, day: 1 }],
    ["a two-digit year", { year: 26, month: 9, day: 15 }],
  ])("an answer with %s files by the received date, flagged", async (_case, answer) => {
    const hex = freshHex(() => answer);
    const result = await hex.process({
      messageId: "fallback@shop.example",
      received,
      parts: [pdf("Rechnung.pdf")],
    });
    const filings = [{ index: 0, path: "2026-11/ER/Rechnung.pdf", fellBack: true }];
    expect(result).toEqual({
      messageId: "fallback@shop.example",
      status: "processed",
      filings,
      forwardings: [],
    });
    expect(Object.keys(await hex.outbox())).toEqual(["2026-11/ER/Rechnung.pdf"]);
    expect(await hex.ledger("fallback@shop.example")).toMatchObject({ filings });
  });

  test("a mixed Intake: one Document by its date, one by the received date", async () => {
    const hex = freshHex(({ fileName }) =>
      fileName === "dated.pdf" ? { year: 2025, month: 12, day: 31 } : NO_DATE,
    );
    const result = await hex.process({
      messageId: "mixed-dates@shop.example",
      received,
      parts: [pdf("dated.pdf"), pdf("undated.pdf")],
    });
    const filings = [
      { index: 0, path: "2025-12/ER/dated.pdf", fellBack: false },
      { index: 1, path: "2026-11/ER/undated.pdf", fellBack: true },
    ];
    expect(result.filings).toEqual(filings);
    expect(Object.keys(await hex.outbox()).sort()).toEqual([
      "2025-12/ER/dated.pdf",
      "2026-11/ER/undated.pdf",
    ]);
    expect(await hex.ledger("mixed-dates@shop.example")).toMatchObject({ filings });
  });

  test("an application/octet-stream named *.pdf goes to the extractor as application/pdf", async () => {
    const hex = freshHex();
    await hex.process({
      messageId: "octet@shop.example",
      received,
      parts: [
        {
          contentType: "application/octet-stream",
          disposition: "attachment",
          fileName: "Scan.PDF",
          content: pdfBytes(500),
        },
      ],
    });
    expect(hex.asked.map(({ mediaType }) => mediaType)).toEqual(["application/pdf"]);
  });

  test("an entry recorded before Document dates were read comes back unchanged, without the flag", async () => {
    const hex = freshHex();
    // Opening the ledger creates its table; then an old-format row goes in, as #6 wrote it.
    expect(await hex.ledger("old@shop.example")).toBeUndefined();
    const database = new Database(hex.databasePath);
    try {
      database
        .query(
          "INSERT INTO hex_intake_ledger (message_id, processed_at, document_count, filings) VALUES (?, ?, ?, ?)",
        )
        .run(
          "old@shop.example",
          "2026-10-01T08:00:00.000Z",
          1,
          '[{"index":0,"path":"2026-10/ER/a.pdf"}]',
        );
    } finally {
      database.close();
    }
    const result = await hex.process({
      messageId: "old@shop.example",
      received,
      parts: [pdf("a.pdf")],
    });
    expect(result).toEqual({
      messageId: "old@shop.example",
      status: "already-processed",
      filings: [{ index: 0, path: "2026-10/ER/a.pdf" }],
      forwardings: [],
    });
    expect(result.filings[0]).not.toHaveProperty("fellBack");
    expect(hex.asked).toEqual([]);
  });

  test.each([
    [
      "a HEIC image (OpenAI and Anthropic reject the type)",
      "image/heic",
      "IMG_0001.HEIC",
      new TextEncoder().encode(`\u0000\u0000\u0000\u0018ftypheic${"h".repeat(20_000)}`),
    ],
    ["a PDF without %PDF", "application/pdf", "Rechnung.pdf", bytes(500, "n")],
    [
      "a JPEG without its signature",
      "image/jpeg",
      "Beleg.jpg",
      bytes(MIN_IMAGE_DOCUMENT_BYTES, "j"),
    ],
  ])(
    "%s never reaches the model and files by the received date",
    async (_case, contentType, fileName, content) => {
      const hex = freshHex(() => ({ year: 2026, month: 1, day: 1 }));
      const result = await hex.process({
        messageId: "unsent@shop.example",
        received,
        parts: [{ contentType, disposition: "attachment", fileName, content }],
      });
      expect(result.filings).toEqual([
        { index: 0, path: `2026-11/ER/${fileName}`, fellBack: true },
      ]);
      expect(hex.asked).toEqual([]);
    },
  );

  test("a failed model call fails the run: nothing filed or recorded; a re-run retries", async () => {
    let failing = true;
    const hex = freshHex(({ fileName }) =>
      failing && fileName === "second.pdf"
        ? new Error(`reading the Document date of "second.pdf" with openai/x failed: 429`)
        : { year: 2026, month: 10, day: 1 },
    );
    const mail = {
      messageId: "flaky@shop.example",
      received,
      parts: [pdf("first.pdf"), pdf("second.pdf")],
    };
    await expect(hex.process(mail)).rejects.toThrow(
      'the Intake workflow did not finish: reading the Document date of "second.pdf" with openai/x failed: 429',
    );
    expect(await hex.outbox()).toEqual({});
    expect(await hex.ledger("flaky@shop.example")).toBeUndefined();

    failing = false;
    const result = await hex.process(mail);
    expect(result).toMatchObject({ status: "processed" });
    expect(Object.keys(await hex.outbox()).sort()).toEqual([
      "2026-10/ER/first.pdf",
      "2026-10/ER/second.pdf",
    ]);
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
      filings: [{ index: 6, path: "2026-11/ER/Scan.pdf", fellBack: true }],
      forwardings: [],
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
      forwardings: [],
    });
    expect(await hex.outbox()).toEqual({});
    expect(await hex.ledger("<nothing@shop.example>")).toMatchObject({
      documentCount: 0,
      filings: [],
    });
  });

  test("an already processed Message-ID is skipped: nothing filed or asked again", async () => {
    const hex = freshHex();
    const mail = { messageId: "twice@shop.example", received, parts: [pdf("Rechnung.pdf")] };
    const first = await hex.process(mail);
    const entry = await hex.ledger("twice@shop.example");
    const second = await hex.process(mail);
    expect(second).toEqual({
      messageId: "twice@shop.example",
      status: "already-processed",
      filings: [{ index: 0, path: "2026-11/ER/Rechnung.pdf", fellBack: true }],
      forwardings: [],
    });
    expect(hex.asked).toHaveLength(1);
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
      filings: paths.map((path, index) => ({ index, path, fellBack: true })),
      forwardings: [],
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
      await expect(hex.run(intake)).rejects.toThrow("a real UTC instant");
      expect(await hex.outbox()).toEqual({});
    });

    test("a receivedAt whose Berlin year is 10000 is rejected; nothing filed or recorded", async () => {
      const hex = freshHex();
      const intake = { ...base, receivedAt: "9999-12-31T23:30:00.000Z", attachments: [apiPdf] };
      await expect(hex.run(intake)).rejects.toThrow("whose year in Europe/Berlin is 1000 to 9999");
      expect(await hex.outbox()).toEqual({});
      expect(await hex.ledger("api@shop.example")).toBeUndefined();
    });

    test("an image's size is its content's, whatever size the caller claims", async () => {
      const hex = freshHex();
      const tinyImage = {
        mimeType: "image/png",
        fileName: "pixel.png",
        content: Buffer.from("x".repeat(50)).toString("base64"),
        size: 20_000,
      };
      const result = await hex.run({ ...base, attachments: [tinyImage] } as unknown as Intake);
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
      await expect(hex.run({ ...base, attachments: [padded] })).rejects.toThrow(
        "Expected a base64 encoded string",
      );
      expect(await hex.outbox()).toEqual({});
    });

    test("a Message-ID that is blank once unbracketed is rejected as input", async () => {
      const hex = freshHex();
      await expect(hex.run({ ...base, messageId: "<>", attachments: [apiPdf] })).rejects.toThrow(
        "a Message-ID that is not blank",
      );
      expect(await hex.outbox()).toEqual({});
    });

    test("the result names the normalised Message-ID, on both runs", async () => {
      const hex = freshHex();
      const intake = { ...base, attachments: [apiPdf] };
      const first = await hex.run(intake);
      const second = await hex.run(intake);
      expect([first.messageId, second.messageId]).toEqual(["api@shop.example", "api@shop.example"]);
      expect(second.status).toBe("already-processed");
    });
  });

  describe("Forwarding", () => {
    const SEVDESK = "autobox@sevdesk.example";
    const PAPERLESS = "bill@paperless.example";
    const FROM = "hex@example.com";
    const both: IntakeForwarding = {
      from: FROM,
      targets: [
        { name: "sevdesk", to: SEVDESK },
        { name: "paperless", to: PAPERLESS },
      ],
    };
    const INVOICE = pdfBytes(600, "i");
    const CREDIT_NOTE = pdfBytes(700, "c");
    const dated = () => ({ year: 2026, month: 10, day: 1 });

    /** Two PDF Documents, an inline `cid:` logo and a tiny image, which are not. */
    const invoiceMail = (messageId: string): Mail => ({
      messageId,
      received,
      html: '<img src="cid:logo@shop">',
      parts: [
        pdf("Rechnung 4711.pdf", INVOICE),
        {
          contentType: "image/png",
          disposition: "inline",
          contentId: "logo@shop",
          content: bytes(MIN_IMAGE_DOCUMENT_BYTES),
        },
        {
          contentType: "image/gif",
          disposition: "attachment",
          fileName: "pixel.gif",
          content: bytes(43),
        },
        pdf("Gutschrift.pdf", CREDIT_NOTE),
      ],
    });
    const outbox = {
      "2026-10/ER/Rechnung 4711.pdf": new TextDecoder().decode(INVOICE),
      "2026-10/ER/Gutschrift.pdf": new TextDecoder().decode(CREDIT_NOTE),
    };
    const filings = [
      { index: 0, path: "2026-10/ER/Rechnung 4711.pdf", fellBack: false },
      { index: 3, path: "2026-10/ER/Gutschrift.pdf", fellBack: false },
    ];

    /** What a target received: one mail's envelope, subject and attachments, content as text. */
    const delivered = ({ from, to, subject, attachments }: OutgoingMail) => ({
      from,
      to,
      subject,
      attachments: attachments.map(({ fileName, contentType, content }) => ({
        fileName,
        contentType,
        content: new TextDecoder().decode(content),
      })),
    });
    const documents = [
      {
        fileName: "Rechnung 4711.pdf",
        contentType: "application/pdf",
        content: outbox["2026-10/ER/Rechnung 4711.pdf"],
      },
      {
        fileName: "Gutschrift.pdf",
        contentType: "application/pdf",
        content: outbox["2026-10/ER/Gutschrift.pdf"],
      },
    ];
    const mailTo = (to: string) => ({
      from: FROM,
      to,
      subject: "Rechnung",
      attachments: documents,
    });

    test("happy path: each target gets one mail with exactly the Documents; both recorded", async () => {
      const hex = freshHex(dated, both);
      const result = await hex.process(invoiceMail("forward@shop.example"));
      expect(result).toEqual({
        messageId: "forward@shop.example",
        status: "processed",
        filings,
        forwardings: [
          { target: "sevdesk", status: "forwarded" },
          { target: "paperless", status: "forwarded" },
        ],
      });
      expect(hex.mailer.sent.map(delivered)).toEqual([mailTo(SEVDESK), mailTo(PAPERLESS)]);
      expect(hex.mailer.sent[0]?.text).toContain("forward@shop.example from billing@shop.example");
      expect(await hex.outbox()).toEqual(outbox);
      const entry = await hex.ledger("forward@shop.example");
      expect(entry).toMatchObject({ documentCount: 2, filings });
      expect(entry?.forwardings.map(({ target }) => target).sort()).toEqual([
        "paperless",
        "sevdesk",
      ]);
    });

    test("a failed target fails the run naming it; the retry sends only to it, files nothing again", async () => {
      const hex = freshHex(dated, both);
      hex.mailer.failNext(PAPERLESS);
      const mail = invoiceMail("partial@shop.example");
      const failed = await hex.process(mail).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(IntakeRunError);
      expect((failed as IntakeRunError).message).toBe(
        `the Intake workflow did not finish: forwarding to paperless: sending to ${PAPERLESS} failed (EENVELOPE at RCPT TO): 451 try again later`,
      );
      expect((failed as IntakeRunError).forwardings).toEqual([
        { target: "sevdesk", status: "forwarded" },
        {
          target: "paperless",
          status: "failed",
          reason: `sending to ${PAPERLESS} failed (EENVELOPE at RCPT TO): 451 try again later`,
        },
      ]);
      // SevDesk got its mail and the Documents were filed, each recorded; the Intake is not.
      expect(hex.mailer.sent.map(({ to }) => to)).toEqual([SEVDESK]);
      expect(await hex.outbox()).toEqual(outbox);
      expect(await hex.ledger("partial@shop.example")).toBeUndefined();
      const branches = await hex.branches("partial@shop.example");
      expect(branches.forwardings.map(({ target }) => target)).toEqual(["sevdesk"]);
      expect(branches.filings).toEqual(filings);
      expect(hex.asked).toHaveLength(2);

      const retried = await hex.process(mail);
      expect(retried).toEqual({
        messageId: "partial@shop.example",
        status: "processed",
        filings,
        forwardings: [
          { target: "sevdesk", status: "forwarded-earlier" },
          { target: "paperless", status: "forwarded" },
        ],
      });
      // SevDesk never sees the Intake twice; nothing filed or read again.
      expect(hex.mailer.sent.map(delivered)).toEqual([mailTo(SEVDESK), mailTo(PAPERLESS)]);
      expect(await hex.outbox()).toEqual(outbox);
      expect(hex.asked).toHaveLength(2);
      expect(await hex.ledger("partial@shop.example")).toMatchObject({ documentCount: 2, filings });
    });

    test("a failed Filing fails the run after forwarding; the retry files without forwarding again", async () => {
      const hex = freshHex(dated, both);
      // A regular file where the Outbox should be: every Filing fails.
      await mkdir(join(hex.outboxDirectory, ".."), { recursive: true });
      await writeFile(hex.outboxDirectory, "not a folder");
      const mail = invoiceMail("unfiled@shop.example");
      await expect(hex.process(mail)).rejects.toThrow(
        'the Intake workflow did not finish: filing "Rechnung 4711.pdf" into 2026-10/ER failed',
      );
      expect(hex.mailer.sent.map(({ to }) => to)).toEqual([SEVDESK, PAPERLESS]);
      expect(await hex.ledger("unfiled@shop.example")).toBeUndefined();
      expect((await hex.branches("unfiled@shop.example")).filings).toEqual([]);

      await rm(hex.outboxDirectory);
      const retried = await hex.process(mail);
      expect(retried).toMatchObject({
        status: "processed",
        filings,
        forwardings: [
          { target: "sevdesk", status: "forwarded-earlier" },
          { target: "paperless", status: "forwarded-earlier" },
        ],
      });
      expect(hex.mailer.sent).toHaveLength(2);
      expect(await hex.outbox()).toEqual(outbox);
    });

    test("a failed model call and a failed target both fail the run, each named; nothing filed", async () => {
      let failing = true;
      const hex = freshHex(
        () => (failing ? new Error("reading the Document date failed: 429") : dated()),
        both,
      );
      hex.mailer.failNext(SEVDESK);
      const mail = invoiceMail("both-fail@shop.example");
      await expect(hex.process(mail)).rejects.toThrow(
        `the Intake workflow did not finish: forwarding to sevdesk: sending to ${SEVDESK} failed (EENVELOPE at RCPT TO): 451 try again later; reading the Document date failed: 429`,
      );
      expect(hex.mailer.sent.map(({ to }) => to)).toEqual([PAPERLESS]);
      expect(await hex.outbox()).toEqual({});

      failing = false;
      expect(await hex.process(mail)).toMatchObject({
        status: "processed",
        filings,
        forwardings: [
          { target: "sevdesk", status: "forwarded" },
          { target: "paperless", status: "forwarded-earlier" },
        ],
      });
      expect(hex.mailer.sent.map(({ to }) => to)).toEqual([PAPERLESS, SEVDESK]);
    });

    test("a disabled target sends nothing and records nothing", async () => {
      const config = join(directory, `forwarding-${instances}.json`);
      await writeFile(
        config,
        JSON.stringify({
          chat: { model: "openai/gpt-5", channels: {} },
          forwarding: {
            from: FROM,
            targets: {
              sevdesk: { to: SEVDESK, enabled: true },
              paperless: { to: PAPERLESS, enabled: false },
            },
          },
        }),
      );
      const forwarding = await loadForwardingConfig(config, {
        HEX_SMTP_HOST: "smtp.example.com",
        HEX_SMTP_USER: "hex",
        HEX_SMTP_PASSWORD: "not-used-here",
      });
      const hex = freshHex(dated, forwarding);
      const result = await hex.process(invoiceMail("disabled@shop.example"));
      expect(result.forwardings).toEqual([{ target: "sevdesk", status: "forwarded" }]);
      expect(hex.mailer.sent.map(({ to }) => to)).toEqual([SEVDESK]);
      expect(
        (await hex.ledger("disabled@shop.example"))?.forwardings.map(({ target }) => target),
      ).toEqual(["sevdesk"]);
    });

    test("without Forwarding configured nothing is sent", async () => {
      const hex = freshHex(dated);
      const result = await hex.process(invoiceMail("off@shop.example"));
      expect(result).toMatchObject({ status: "processed", filings, forwardings: [] });
      expect(hex.mailer.sent).toEqual([]);
    });

    test("an Intake without Documents forwards nothing", async () => {
      const hex = freshHex(dated, both);
      const result = await hex.process({
        messageId: "no-documents@shop.example",
        received,
        html: '<img src="cid:logo@shop">',
        parts: [
          {
            contentType: "image/png",
            disposition: "inline",
            contentId: "logo@shop",
            content: bytes(MIN_IMAGE_DOCUMENT_BYTES),
          },
        ],
      });
      expect(result).toEqual({
        messageId: "no-documents@shop.example",
        status: "processed",
        filings: [],
        forwardings: [],
      });
      expect(hex.mailer.sent).toEqual([]);
      expect(await hex.ledger("no-documents@shop.example")).toMatchObject({ forwardings: [] });
    });

    test("an already processed Intake is not forwarded again; the result names the earlier Forwardings", async () => {
      const hex = freshHex(dated, both);
      const mail = invoiceMail("forwarded-once@shop.example");
      await hex.process(mail);
      const again = await hex.process(mail);
      expect(again).toEqual({
        messageId: "forwarded-once@shop.example",
        status: "already-processed",
        filings,
        forwardings: [
          { target: "paperless", status: "forwarded-earlier" },
          { target: "sevdesk", status: "forwarded-earlier" },
        ],
      });
      expect(hex.mailer.sent).toHaveLength(2);
    });

    test("a mail without a subject gets the fallback; a subject's line breaks never reach the header", async () => {
      const hex = freshHex(dated, { from: FROM, targets: [{ name: "sevdesk", to: SEVDESK }] });
      const intake = {
        messageId: "<subjects@shop.example>",
        receivedAt: "2026-11-02T07:15:00.000Z",
        cidReferences: [],
        attachments: [apiPdf],
      };
      await hex.run(intake);
      await hex.run({
        ...intake,
        messageId: "<subjects-2@shop.example>",
        subject: "Rechnung\r\nBcc: x@evil.example",
      });
      expect(hex.mailer.sent.map(({ subject }) => subject)).toEqual([
        "Documents forwarded by hex",
        "Rechnung Bcc: x@evil.example",
      ]);
    });
  });
});

const apiPdf = {
  mimeType: "application/pdf",
  fileName: "api.pdf",
  content: Buffer.from("%PDF").toString("base64"),
};
