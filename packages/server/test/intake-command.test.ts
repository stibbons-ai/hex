// Walkthrough: Daniel runs `bun run intake <file.eml>` and finds the Documents in the Outbox, each
// filed by its Document date as the model read it (a fake OpenAI on loopback) or, marked, by the
// received date.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IntakeLedger, intakeLedgerLayer, readEml } from "@hex/adapters";
import { Effect } from "effect";
import { RECEIVED, buildEml, bytes, invoiceMail, pdf } from "./eml";
import { fakeOpenAI, inputFiles } from "./fake-openai";
import type { FakeOpenAI } from "./fake-openai";
import { fakeSmtp } from "./fake-smtp";
import type { ReceivedMail } from "./fake-smtp";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
let directory: string;

/** A PDF whose text shows its Document date, and one that shows none. */
const DATED_PDF = new TextEncoder().encode("%PDF-1.4\nRechnung 4711\nRechnungsdatum: 15.09.2026\n");
const UNDATED_PDF = new TextEncoder().encode("%PDF-1.4\nLieferschein 815\n");

/** The data URL a PDF goes to OpenAI as. */
const dataUrl = (content: Uint8Array) =>
  `data:application/pdf;base64,${Buffer.from(content).toString("base64")}`;

/** Reads the Document the way a model would here: the date printed in the dated PDF. */
const model = fakeOpenAI((request) =>
  inputFiles(request).includes(dataUrl(DATED_PDF))
    ? '{"year":2026,"month":9,"day":15}'
    : '{"year":null,"month":null,"day":null}',
);

/**
 * The model every run here names: an `openai/` one, so it reaches the fake OpenAI (the default
 * model is Anthropic's).
 */
const MODEL = "openai/gpt-5.4-mini";
/** A config file naming only {@link MODEL}: what a run without its own config uses. */
let modelConfig: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-intake-command-"));
  modelConfig = join(directory, "model.json");
  await writeFile(
    modelConfig,
    JSON.stringify({ chat: { model: "openai/gpt-5", channels: {} }, intake: { model: MODEL } }),
  );
});

afterAll(async () => {
  await model.server.stop(true);
  await rm(directory, { recursive: true, force: true });
});

const API_KEY = "sk-hex-walkthrough-0123456789";

/**
 * `bun run intake <args>` from the repository root; HEX_* come only from `env`, the config file
 * is {@link modelConfig} unless `env` names one, and the model is the fake OpenAI `openai`. The
 * other providers' keys and Mastra's provider refresh are blanked, so a developer's real keys
 * never reach a test; a test that needs one sets it in `env`.
 */
async function intake(args: string[], env: Record<string, string>, openai: FakeOpenAI = model) {
  const child = Bun.spawn(["bun", "run", "--silent", "intake", ...args], {
    cwd: repository,
    env: {
      ...process.env,
      HEX_CONFIG: modelConfig,
      HEX_DATA_DIR: "",
      HEX_OUTBOX_DIR: "",
      HEX_SMTP_HOST: "",
      HEX_SMTP_PORT: "",
      HEX_SMTP_SECURITY: "",
      HEX_SMTP_USER: "",
      HEX_SMTP_PASSWORD: "",
      OPENAI_BASE_URL: openai.baseUrl,
      OPENAI_API_KEY: API_KEY,
      ANTHROPIC_API_KEY: "",
      GOOGLE_GENERATIVE_AI_API_KEY: "",
      GEMINI_API_KEY: "",
      MASTRA_AUTO_REFRESH_PROVIDERS: "",
      MASTRA_DEV: "",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

async function writeMail(name: string, mail: Parameters<typeof buildEml>[0]) {
  const path = join(directory, name);
  await writeFile(path, buildEml(mail));
  return path;
}

/** The ledger entry for `messageId` in the database under `dataDirectory`, read by the ledger. */
function ledgerEntry(dataDirectory: string, messageId: string) {
  return Effect.runPromise(
    IntakeLedger.use((ledger) => ledger.find(messageId)).pipe(
      Effect.provide(intakeLedgerLayer(join(dataDirectory, "mastra.db"))),
    ),
  );
}

/** Everything `mastra.db` (and its WAL files) under `dataDirectory` holds, read as text. */
async function persistedText(dataDirectory: string): Promise<string> {
  const names = (await readdir(dataDirectory)).filter((name) => name.startsWith("mastra.db"));
  const contents = await Promise.all(names.map((name) => readFile(join(dataDirectory, name))));
  return contents.map((content) => content.toString("latin1")).join("\n");
}

describe("bun run intake", () => {
  test("files each Document by its Document date or, marked, by the received date; then reports the Intake as already processed", async () => {
    const dataDirectory = join(directory, "data");
    const outbox = join(directory, "outbox");
    const config = join(directory, "hex.json");
    await writeFile(
      config,
      JSON.stringify({
        chat: { model: "openai/gpt-5", channels: {} },
        intake: { category: "ER", model: MODEL },
      }),
    );
    const eml = await writeMail("invoice.eml", {
      messageId: "walkthrough@shop.example",
      received: RECEIVED,
      html: '<img src="cid:logo@shop">',
      parts: [
        pdf("Rechnung 4711.pdf", DATED_PDF),
        pdf("Lieferschein.pdf", UNDATED_PDF),
        {
          contentType: "image/png",
          disposition: "inline",
          contentId: "logo@shop",
          content: bytes(20_000),
        },
      ],
    });
    const env = { HEX_DATA_DIR: dataDirectory, HEX_OUTBOX_DIR: outbox, HEX_CONFIG: config };
    const asked = model.requests.length;

    const first = await intake([eml], env);
    expect(first).toMatchObject({ code: 0, stderr: "" });
    expect(first.stdout).toBe(
      [
        `hex intake: walkthrough@shop.example: filed 2 Documents into ${outbox}`,
        "  2026-09/ER/Rechnung 4711.pdf",
        "  2026-11/ER/Lieferschein.pdf (no usable Document date; filed by received date)",
        "",
      ].join("\n"),
    );
    // Each Document went to the configured model natively, as a PDF file part with its bytes.
    const requests = model.requests.slice(asked);
    expect(requests.map(({ model: id }) => id)).toEqual(["gpt-5.4-mini", "gpt-5.4-mini"]);
    expect(requests.map(inputFiles)).toEqual([[dataUrl(DATED_PDF)], [dataUrl(UNDATED_PDF)]]);

    expect(await readFile(join(outbox, "2026-09/ER/Rechnung 4711.pdf"))).toEqual(
      Buffer.from(DATED_PDF),
    );
    expect(await readFile(join(outbox, "2026-11/ER/Lieferschein.pdf"))).toEqual(
      Buffer.from(UNDATED_PDF),
    );
    expect(await ledgerEntry(dataDirectory, "walkthrough@shop.example")).toMatchObject({
      documentCount: 2,
      filings: [
        { index: 0, path: "2026-09/ER/Rechnung 4711.pdf", fellBack: false },
        { index: 1, path: "2026-11/ER/Lieferschein.pdf", fellBack: true },
      ],
    });

    const second = await intake([eml], env);
    expect(second).toMatchObject({ code: 0, stderr: "" });
    expect(second.stdout).toBe(
      "hex intake: walkthrough@shop.example was already processed; nothing filed\n",
    );
    expect(model.requests).toHaveLength(asked + 2);
    expect(await readdir(join(outbox, "2026-09/ER"))).toEqual(["Rechnung 4711.pdf"]);
    expect(await readdir(join(outbox, "2026-11/ER"))).toEqual(["Lieferschein.pdf"]);
  });

  test("an image Document reaches the model natively as an image; one that isn't an image never does", async () => {
    // A PNG signature and IHDR chunk start, padded past the image size threshold.
    const png = new Uint8Array(12_000);
    png.set([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    const dataDirectory = join(directory, "image");
    const eml = await writeMail("image.eml", {
      messageId: "image@shop.example",
      received: RECEIVED,
      parts: [
        {
          contentType: "image/png",
          disposition: "attachment",
          fileName: "Beleg.png",
          content: png,
        },
        // Declared a JPEG, but without a JPEG's signature: Mastra would send a placeholder.
        {
          contentType: "image/jpeg",
          disposition: "attachment",
          fileName: "Kaputt.jpg",
          content: bytes(12_000, "j"),
        },
      ],
    });
    const asked = model.requests.length;
    const run = await intake([eml], { HEX_DATA_DIR: dataDirectory });
    expect(run).toMatchObject({ code: 0, stderr: "" });
    expect(run.stdout).toContain(
      "  2026-11/ER/Kaputt.jpg (no usable Document date; filed by received date)",
    );
    expect(model.requests.slice(asked).map(inputFiles)).toEqual([
      [`data:image/png;base64,${Buffer.from(png).toString("base64")}`],
    ]);
    expect(JSON.stringify(model.requests[asked]?.input)).toContain('"type":"input_image"');
  });

  test("the Outbox defaults to <data dir>/outbox; an Intake without Documents says so", async () => {
    const dataDirectory = join(directory, "default-outbox");
    const eml = await writeMail("no-documents.eml", {
      messageId: "empty@shop.example",
      received: RECEIVED,
    });
    const run = await intake([eml], { HEX_DATA_DIR: dataDirectory });
    expect(run).toMatchObject({
      code: 0,
      stdout: "hex intake: empty@shop.example has no Documents; nothing filed\n",
    });
    const pdfMail = await writeMail("one.eml", {
      messageId: "one@shop.example",
      received: RECEIVED,
      parts: [pdf("a.pdf", DATED_PDF)],
    });
    expect((await intake([pdfMail], { HEX_DATA_DIR: dataDirectory })).code).toBe(0);
    expect(await readdir(join(dataDirectory, "outbox/2026-09/ER"))).toEqual(["a.pdf"]);
  });

  // Each case builds its arguments and expected message once the temp directory exists.
  test.each([
    ["no argument", async () => ({ args: [], message: "usage: bun run intake <path.eml>" })],
    [
      "a missing file",
      async () => {
        const path = join(directory, "nope.eml");
        return { args: [path], message: `cannot read ${path}` };
      },
    ],
    [
      "a mail without Message-ID",
      async () => {
        const path = await writeMail("no-id.eml", { received: RECEIVED });
        return { args: [path], message: `${path}: no Message-ID` };
      },
    ],
  ])("%s fails with exit code 1 and a clear message", async (_case, setup) => {
    const { args, message } = await setup();
    const run = await intake(args, { HEX_DATA_DIR: join(directory, "failing") });
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toStartWith(`hex intake: ${message}`);
  });

  test.each([
    ["a Category other than ER", { category: "AR" }, '["intake"]["category"]'],
    [
      "a model that is no provider/model id",
      { model: "gpt-5.1-codex-mini" },
      '["intake"]["model"]',
    ],
  ])("%s fails before anything is filed", async (_case, intakeConfig, at) => {
    const config = join(directory, "bad-intake.json");
    await writeFile(
      config,
      JSON.stringify({ chat: { model: "openai/gpt-5", channels: {} }, intake: intakeConfig }),
    );
    const dataDirectory = join(directory, "bad-intake");
    const eml = await writeMail("bad-intake.eml", {
      messageId: "category@shop.example",
      received: RECEIVED,
      parts: [pdf("a.pdf")],
    });
    const run = await intake([eml], { HEX_DATA_DIR: dataDirectory, HEX_CONFIG: config });
    expect(run.code).toBe(1);
    expect(run.stderr).toStartWith(`hex intake: hex config ${config}: invalid config`);
    expect(run.stderr).toContain(`at ${at}`);
    expect(await readdir(dataDirectory).catch(() => [])).toEqual([]);
  });

  test("a failed model call exits 1 naming the Document and the model; nothing filed or recorded", async () => {
    const rejecting = fakeOpenAI(() => ({
      status: 401,
      message: `Incorrect API key provided: ${API_KEY}.`,
    }));
    try {
      const config = join(directory, "configured-model.json");
      await writeFile(
        config,
        JSON.stringify({
          chat: { model: "openai/gpt-5", channels: {} },
          intake: { model: "openai/gpt-5-mini" },
        }),
      );
      const dataDirectory = join(directory, "model-fails");
      const outbox = join(directory, "model-fails-outbox");
      const eml = await writeMail("model-fails.eml", {
        messageId: "unread@shop.example",
        received: RECEIVED,
        parts: [pdf("a.pdf", DATED_PDF)],
      });
      const run = await intake(
        [eml],
        { HEX_DATA_DIR: dataDirectory, HEX_OUTBOX_DIR: outbox, HEX_CONFIG: config },
        rejecting,
      );
      expect(run).toMatchObject({ code: 1, stdout: "" });
      expect(run.stderr).toContain(
        'hex intake: the Intake workflow did not finish: filing: reading the Document date of "a.pdf" with openai/gpt-5-mini failed (HTTP 401): Incorrect API key provided: OPENAI_API_KEY.',
      );
      expect(run.stderr).not.toContain(API_KEY);
      // Exactly one model call: a refused key is never retried.
      expect(rejecting.requests.map(({ model: id }) => id)).toEqual(["gpt-5-mini"]);
      expect(await readdir(outbox).catch(() => [])).toEqual([]);
      expect(await ledgerEntry(dataDirectory, "unread@shop.example")).toBeUndefined();
      // Mastra persists the failed run: its error, but never the key or the provider's request
      // (an error cause would carry both).
      const persisted = await persistedText(dataDirectory);
      expect(persisted.includes("Incorrect API key provided: OPENAI_API_KEY")).toBe(true);
      expect(persisted.includes(API_KEY)).toBe(false);
      expect(persisted.includes("requestBodyValues")).toBe(false);
    } finally {
      await rejecting.server.stop(true);
    }
  });

  test("without a config file the default model, anthropic/claude-haiku-5-5, reads the Documents", async () => {
    const dataDirectory = join(directory, "no-config");
    const outbox = join(directory, "no-config-outbox");
    const eml = await writeMail("no-config.eml", {
      messageId: "no-config@shop.example",
      received: RECEIVED,
      parts: [pdf("a.pdf", DATED_PDF)],
    });
    const asked = model.requests.length;
    // No Anthropic key (the helper blanks it) and a base URL nobody listens on: the call fails
    // before anything leaves the machine, naming the model it was for.
    const run = await intake([eml], {
      HEX_CONFIG: "",
      HEX_DATA_DIR: dataDirectory,
      HEX_OUTBOX_DIR: outbox,
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9/v1",
    });
    expect(run).toMatchObject({ code: 1, stdout: "" });
    expect(run.stderr).toContain(
      'hex intake: the Intake workflow did not finish: filing: reading the Document date of "a.pdf" with anthropic/claude-haiku-5-5 failed',
    );
    expect(model.requests.length).toBe(asked);
    expect(await readdir(outbox).catch(() => [])).toEqual([]);
    expect(await ledgerEntry(dataDirectory, "no-config@shop.example")).toBeUndefined();
  });

  test("a Filing that fails mid-run exits 1 naming the Outbox failure, and records nothing", async () => {
    const dataDirectory = join(directory, "outbox-is-a-file");
    const outbox = join(directory, "not-a-folder");
    await writeFile(outbox, "a regular file where the Outbox should be");
    const eml = await writeMail("blocked.eml", {
      messageId: "blocked@shop.example",
      received: RECEIVED,
      parts: [pdf("a.pdf")],
    });
    const run = await intake([eml], { HEX_DATA_DIR: dataDirectory, HEX_OUTBOX_DIR: outbox });
    expect(run).toMatchObject({ code: 1, stdout: "" });
    expect(run.stderr).toStartWith(
      'hex intake: the Intake workflow did not finish: filing: filing "a.pdf" into 2026-11/ER failed',
    );
    expect(await ledgerEntry(dataDirectory, "blocked@shop.example")).toBeUndefined();
  });

  describe("Forwarding by SMTP (a fake SMTP server on loopback)", () => {
    const SEVDESK = "autobox@sevdesk.example";
    const PAPERLESS = "bill@paperless.example";
    const SMTP_USER = "hex@example.com";
    const SMTP_PASSWORD = "smtp-walkthrough-secret-0123456789";
    const smtp = fakeSmtp();

    afterAll(() => smtp.server.stop(true));

    /** A config forwarding to SevDesk and paperless-ngx; a third target is off. */
    async function forwardingConfig(name: string) {
      const path = join(directory, name);
      await writeFile(
        path,
        JSON.stringify({
          chat: { model: "openai/gpt-5", channels: {} },
          intake: { model: MODEL },
          forwarding: {
            from: "hex@example.com",
            targets: {
              sevdesk: { to: SEVDESK, enabled: true },
              paperless: { to: PAPERLESS, enabled: true },
              archive: { to: "archive@example.com", enabled: false },
            },
          },
        }),
      );
      return path;
    }

    const smtpEnv = () => ({
      HEX_SMTP_HOST: "127.0.0.1",
      HEX_SMTP_PORT: String(smtp.port),
      HEX_SMTP_SECURITY: "plain",
      HEX_SMTP_USER: SMTP_USER,
      HEX_SMTP_PASSWORD: SMTP_PASSWORD,
    });

    const invoice = (messageId: string) =>
      invoiceMail(messageId, RECEIVED, [
        pdf("Rechnung 4711.pdf", DATED_PDF),
        pdf("Lieferschein.pdf", UNDATED_PDF),
      ]);

    /** A received mail as hex's own reader reads it: recipients, subject and attachments. */
    async function read({ to, raw }: ReceivedMail) {
      const mail = await Effect.runPromise(readEml(new TextEncoder().encode(raw), "smtp"));
      return {
        to,
        subject: mail.subject,
        attachments: mail.attachments.map(({ fileName, mimeType, content }) => ({
          fileName,
          mimeType,
          content: Buffer.from(content, "base64"),
        })),
      };
    }
    const documents = [
      {
        fileName: "Rechnung 4711.pdf",
        mimeType: "application/pdf",
        content: Buffer.from(DATED_PDF),
      },
      {
        fileName: "Lieferschein.pdf",
        mimeType: "application/pdf",
        content: Buffer.from(UNDATED_PDF),
      },
    ];

    test("each enabled target gets one mail with exactly the Documents; a re-run sends nothing", async () => {
      const dataDirectory = join(directory, "forwarding");
      const outbox = join(directory, "forwarding-outbox");
      const config = await forwardingConfig("forwarding.json");
      const eml = await writeMail("forward.eml", invoice("forward@shop.example"));
      const env = {
        HEX_DATA_DIR: dataDirectory,
        HEX_OUTBOX_DIR: outbox,
        HEX_CONFIG: config,
        ...smtpEnv(),
      };
      const sent = smtp.mails.length;

      const first = await intake([eml], env);
      expect(first).toMatchObject({ code: 0, stderr: "" });
      expect(first.stdout).toBe(
        [
          `hex intake: forward@shop.example: filed 2 Documents into ${outbox}`,
          "  2026-09/ER/Rechnung 4711.pdf",
          "  2026-11/ER/Lieferschein.pdf (no usable Document date; filed by received date)",
          "  forwarded to sevdesk",
          "  forwarded to paperless",
          "",
        ].join("\n"),
      );
      const mails = smtp.mails.slice(sent);
      expect(mails.map(({ from, to }) => ({ from, to }))).toEqual([
        { from: "hex@example.com", to: [SEVDESK] },
        { from: "hex@example.com", to: [PAPERLESS] },
      ]);
      expect(await Promise.all(mails.map(read))).toEqual([
        { to: [SEVDESK], subject: "Rechnung", attachments: documents },
        { to: [PAPERLESS], subject: "Rechnung", attachments: documents },
      ]);
      // hex logged in with the configured credentials, which it never printed.
      expect(smtp.logins.at(-1)).toEqual({ user: SMTP_USER, password: SMTP_PASSWORD });
      expect(first.stdout + first.stderr).not.toContain(SMTP_PASSWORD);
      expect(await readFile(join(outbox, "2026-09/ER/Rechnung 4711.pdf"))).toEqual(
        Buffer.from(DATED_PDF),
      );
      expect(await readFile(join(outbox, "2026-11/ER/Lieferschein.pdf"))).toEqual(
        Buffer.from(UNDATED_PDF),
      );
      const entry = await ledgerEntry(dataDirectory, "forward@shop.example");
      expect(entry?.forwardings.map(({ target }) => target)).toEqual(["paperless", "sevdesk"]);

      const second = await intake([eml], env);
      expect(second).toMatchObject({ code: 0, stderr: "" });
      expect(second.stdout).toBe(
        [
          "hex intake: forward@shop.example was already processed; nothing filed",
          "  already forwarded to paperless earlier",
          "  already forwarded to sevdesk earlier",
          "",
        ].join("\n"),
      );
      expect(smtp.mails).toHaveLength(sent + 2);
      expect(await persistedText(dataDirectory)).not.toContain(SMTP_PASSWORD);
    });

    test("a target the server refuses fails the run naming it; the re-run sends only to it", async () => {
      const dataDirectory = join(directory, "forwarding-refused");
      const outbox = join(directory, "forwarding-refused-outbox");
      const config = await forwardingConfig("forwarding-refused.json");
      const eml = await writeMail("refused.eml", invoice("refused@shop.example"));
      const env = {
        HEX_DATA_DIR: dataDirectory,
        HEX_OUTBOX_DIR: outbox,
        HEX_CONFIG: config,
        ...smtpEnv(),
      };
      const sent = smtp.mails.length;

      smtp.rejecting.add(PAPERLESS);
      const failed = await intake([eml], env).finally(() => smtp.rejecting.delete(PAPERLESS));
      expect(failed.code).toBe(1);
      const refusal = `sending to ${PAPERLESS} via 127.0.0.1:${smtp.port} failed (EENVELOPE at RCPT TO)`;
      // What was done although paperless failed: the Filings and SevDesk's Forwarding.
      expect(failed.stdout).toBe(
        [
          `hex intake: refused@shop.example: filed 2 Documents into ${outbox}`,
          "  2026-09/ER/Rechnung 4711.pdf",
          "  2026-11/ER/Lieferschein.pdf (no usable Document date; filed by received date)",
          "  forwarded to sevdesk",
          "",
        ].join("\n"),
      );
      expect(failed.stderr).toStartWith(
        `hex intake: the Intake workflow did not finish: forwarding to paperless: ${refusal}`,
      );
      expect(failed.stderr).toContain("550 5.1.1");
      // The paperless failure is told once.
      expect((failed.stdout + failed.stderr).split("forwarding to paperless")).toHaveLength(2);
      expect(failed.stdout + failed.stderr).not.toContain(SMTP_PASSWORD);
      expect(smtp.mails.slice(sent).map(({ to }) => to)).toEqual([[SEVDESK]]);
      expect(await ledgerEntry(dataDirectory, "refused@shop.example")).toBeUndefined();

      const retried = await intake([eml], env);
      expect(retried).toMatchObject({ code: 0, stderr: "" });
      expect(retried.stdout).toEndWith(
        "  already forwarded to sevdesk earlier\n  forwarded to paperless\n",
      );
      // SevDesk never saw the Intake twice; the Documents were filed once.
      expect(smtp.mails.slice(sent).map(({ to }) => to)).toEqual([[SEVDESK], [PAPERLESS]]);
      expect((await readdir(join(outbox, "2026-09/ER"))).sort()).toEqual(["Rechnung 4711.pdf"]);
      expect(await persistedText(dataDirectory)).not.toContain(SMTP_PASSWORD);
    });

    test("a send the ledger can't record exits 1 saying it was sent; the re-run sends it again", async () => {
      const dataDirectory = join(directory, "forwarding-unrecorded");
      const outbox = join(directory, "forwarding-unrecorded-outbox");
      const config = await forwardingConfig("forwarding-unrecorded.json");
      const eml = await writeMail("unrecorded.eml", invoice("unrecorded@shop.example"));
      const env = {
        HEX_DATA_DIR: dataDirectory,
        HEX_OUTBOX_DIR: outbox,
        HEX_CONFIG: config,
        ...smtpEnv(),
      };
      const sent = smtp.mails.length;
      // The real ledger's tables, then a trigger that refuses every Forwarding record, as a
      // ledger that can't write would: the send goes through, its record doesn't.
      await ledgerEntry(dataDirectory, "unrecorded@shop.example");
      const database = new Database(join(dataDirectory, "mastra.db"));
      try {
        database.run(
          "CREATE TRIGGER refuse_forwardings BEFORE INSERT ON hex_intake_forwardings BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END",
        );
      } finally {
        database.close();
      }

      const failed = await intake([eml], env);
      expect(failed.code).toBe(1);
      for (const target of ["sevdesk", "paperless"]) {
        expect(failed.stderr).toContain(`forwarding to ${target}: sent, but recording it failed (`);
        // Not recorded, so not shown as a target that has the Documents.
        expect(failed.stdout).not.toContain(`forwarded to ${target}`);
      }
      expect(failed.stderr).toContain("running this Intake again sends it again");
      expect(failed.stdout).toStartWith(`hex intake: unrecorded@shop.example: filed 2 Documents`);
      expect(smtp.mails.slice(sent).map(({ to }) => to)).toEqual([[SEVDESK], [PAPERLESS]]);

      const fixed = new Database(join(dataDirectory, "mastra.db"));
      try {
        fixed.run("DROP TRIGGER refuse_forwardings");
      } finally {
        fixed.close();
      }
      const retried = await intake([eml], env);
      expect(retried).toMatchObject({ code: 0, stderr: "" });
      // As the error said: both targets get the Intake a second time.
      expect(smtp.mails.slice(sent).map(({ to }) => to)).toEqual([
        [SEVDESK],
        [PAPERLESS],
        [SEVDESK],
        [PAPERLESS],
      ]);
    });

    test("a target enabled without SMTP credentials fails before anything is filed, naming the variable", async () => {
      const dataDirectory = join(directory, "forwarding-no-password");
      const config = await forwardingConfig("forwarding-no-password.json");
      const eml = await writeMail("no-password.eml", invoice("no-password@shop.example"));
      const run = await intake([eml], {
        HEX_DATA_DIR: dataDirectory,
        HEX_CONFIG: config,
        ...smtpEnv(),
        HEX_SMTP_PASSWORD: "",
      });
      expect(run).toMatchObject({ code: 1, stdout: "" });
      expect(run.stderr).toStartWith(
        `hex intake: hex config ${config}: forwarding: environment variable HEX_SMTP_PASSWORD is not set`,
      );
      expect(await readdir(dataDirectory).catch(() => [])).toEqual([]);
    });
  });
});
