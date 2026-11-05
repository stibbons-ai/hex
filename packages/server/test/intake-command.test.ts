// Walkthrough: Daniel runs `bun run intake <file.eml>` and finds the Documents in the Outbox.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IntakeLedger, intakeLedgerLayer } from "@hex/adapters";
import { Effect } from "effect";
import { buildEml, bytes } from "./eml";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-intake-command-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** `bun run intake <args>` from the repository root; HEX_* come only from `env`. */
async function intake(args: string[], env: Record<string, string>) {
  const child = Bun.spawn(["bun", "run", "--silent", "intake", ...args], {
    cwd: repository,
    env: { ...process.env, HEX_CONFIG: "", HEX_DATA_DIR: "", HEX_OUTBOX_DIR: "", ...env },
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

describe("bun run intake", () => {
  test("files the Documents into the Outbox, then reports the Intake as already processed", async () => {
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
      received: "Mon, 02 Nov 2026 08:15:00 +0100",
      html: '<img src="cid:logo@shop">',
      parts: [
        {
          contentType: "application/pdf",
          disposition: "attachment",
          fileName: "Rechnung 4711.pdf",
          content: bytes(800, "r"),
        },
        {
          contentType: "image/png",
          disposition: "inline",
          contentId: "logo@shop",
          content: bytes(20_000),
        },
      ],
    });
    const env = { HEX_DATA_DIR: dataDirectory, HEX_OUTBOX_DIR: outbox, HEX_CONFIG: config };

    const first = await intake([eml], env);
    expect(first).toMatchObject({ code: 0, stderr: "" });
    expect(first.stdout).toBe(
      `hex intake: walkthrough@shop.example: filed 1 Document into ${outbox}\n  2026-11/ER/Rechnung 4711.pdf\n`,
    );
    expect(await readdir(join(outbox, "2026-11/ER"))).toEqual(["Rechnung 4711.pdf"]);
    expect(await readFile(join(outbox, "2026-11/ER/Rechnung 4711.pdf"), "utf8")).toBe(
      "r".repeat(800),
    );
    const entry = await Effect.runPromise(
      IntakeLedger.use((ledger) => ledger.find("walkthrough@shop.example")).pipe(
        Effect.provide(intakeLedgerLayer(join(dataDirectory, "mastra.db"))),
      ),
    );
    expect(entry).toMatchObject({
      documentCount: 1,
      filings: [{ path: "2026-11/ER/Rechnung 4711.pdf" }],
    });

    const second = await intake([eml], env);
    expect(second).toMatchObject({ code: 0, stderr: "" });
    expect(second.stdout).toBe(
      "hex intake: walkthrough@shop.example was already processed; nothing filed\n",
    );
    expect(await readdir(join(outbox, "2026-11/ER"))).toEqual(["Rechnung 4711.pdf"]);
  });

  test("the Outbox defaults to <data dir>/outbox; an Intake without Documents says so", async () => {
    const dataDirectory = join(directory, "default-outbox");
    const eml = await writeMail("no-documents.eml", {
      messageId: "empty@shop.example",
      received: "Mon, 02 Nov 2026 08:15:00 +0100",
    });
    const run = await intake([eml], { HEX_DATA_DIR: dataDirectory });
    expect(run).toMatchObject({
      code: 0,
      stdout: "hex intake: empty@shop.example has no Documents; nothing filed\n",
    });
    const pdfMail = await writeMail("one.eml", {
      messageId: "one@shop.example",
      received: "Mon, 02 Nov 2026 08:15:00 +0100",
      parts: [
        {
          contentType: "application/pdf",
          disposition: "attachment",
          fileName: "a.pdf",
          content: bytes(5),
        },
      ],
    });
    expect((await intake([pdfMail], { HEX_DATA_DIR: dataDirectory })).code).toBe(0);
    expect(await readdir(join(dataDirectory, "outbox/2026-11/ER"))).toEqual(["a.pdf"]);
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
        const path = await writeMail("no-id.eml", { received: "Mon, 02 Nov 2026 08:15:00 +0100" });
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

  test("a Category other than ER fails before anything is filed", async () => {
    const config = join(directory, "bad-category.json");
    await writeFile(
      config,
      JSON.stringify({ chat: { model: "openai/gpt-5", channels: {} }, intake: { category: "AR" } }),
    );
    const dataDirectory = join(directory, "bad-category");
    const eml = await writeMail("bad-category.eml", {
      messageId: "category@shop.example",
      received: "Mon, 02 Nov 2026 08:15:00 +0100",
      parts: [
        {
          contentType: "application/pdf",
          disposition: "attachment",
          fileName: "a.pdf",
          content: bytes(5),
        },
      ],
    });
    const run = await intake([eml], { HEX_DATA_DIR: dataDirectory, HEX_CONFIG: config });
    expect(run.code).toBe(1);
    expect(run.stderr).toStartWith(`hex intake: hex config ${config}: invalid config`);
    expect(await readdir(dataDirectory).catch(() => [])).toEqual([]);
  });
});
