// Walkthrough: Daniel runs `bun run intake <file.eml>` and finds the Documents in the Outbox, each
// filed by its Document date as the model read it (a fake OpenAI on loopback) or, marked, by the
// received date.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IntakeLedger, intakeLedgerLayer } from "@hex/adapters";
import { Effect } from "effect";
import { RECEIVED, buildEml, bytes, pdf } from "./eml";
import { fakeOpenAI, inputFiles } from "./fake-openai";
import type { FakeOpenAI } from "./fake-openai";

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

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-intake-command-"));
});

afterAll(async () => {
  await model.server.stop(true);
  await rm(directory, { recursive: true, force: true });
});

const API_KEY = "sk-hex-walkthrough-0123456789";

/**
 * `bun run intake <args>` from the repository root; HEX_* come only from `env`, and the model is
 * the fake OpenAI `openai`.
 */
async function intake(args: string[], env: Record<string, string>, openai: FakeOpenAI = model) {
  const child = Bun.spawn(["bun", "run", "--silent", "intake", ...args], {
    cwd: repository,
    env: {
      ...process.env,
      HEX_CONFIG: "",
      HEX_DATA_DIR: "",
      HEX_OUTBOX_DIR: "",
      OPENAI_BASE_URL: openai.baseUrl,
      OPENAI_API_KEY: API_KEY,
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
        intake: { category: "ER" },
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
    // Each Document went to the default model natively, as a PDF file part with its bytes.
    const requests = model.requests.slice(asked);
    expect(requests.map(({ model: id }) => id)).toEqual([
      "gpt-5.1-codex-mini",
      "gpt-5.1-codex-mini",
    ]);
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
        'hex intake: the Intake workflow did not finish: reading the Document date of "a.pdf" with openai/gpt-5-mini failed (HTTP 401): Incorrect API key provided: OPENAI_API_KEY.',
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
      'hex intake: the Intake workflow did not finish: filing "a.pdf" into 2026-11/ER failed',
    );
    expect(await ledgerEntry(dataDirectory, "blocked@shop.example")).toBeUndefined();
  });
});
