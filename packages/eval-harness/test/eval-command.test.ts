// Walkthrough: Daniel runs `bun run eval` by hand and reads the summary and both reports; the model
// is a fake OpenAI on loopback that answers 2 November 2026 for every Document.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Schema } from "effect";
import { fakeOpenAI } from "../../server/test/fake-openai.ts";
import type { FakeOpenAI } from "../../server/test/fake-openai.ts";
import { Report } from "../src/index.ts";
import { syntheticFolder } from "../src/synthetic/generate.ts";
import { repoRoot } from "./paths.ts";

const NOVEMBER_2 = '{"year":2026,"month":11,"day":2}';
const model = fakeOpenAI(() => NOVEMBER_2);
let directory: string;
let fixtures: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-eval-command-"));
  fixtures = join(directory, "fixtures");
  await cp(syntheticFolder, fixtures, { recursive: true });
});

afterAll(async () => {
  await model.server.stop(true);
  await rm(directory, { recursive: true, force: true });
});

let runs = 0;

/**
 * `bun run eval` from `cwd` (default the repository root), outside CI unless `env` says so;
 * HEX_* only from `env`.
 */
async function evalCommand(
  env: Record<string, string>,
  { openai = model, cwd = repoRoot }: { openai?: FakeOpenAI; cwd?: string } = {},
) {
  const { CI: _, INIT_CWD: __, ...inherited } = process.env;
  const results = join(directory, `results-${++runs}`);
  const child = Bun.spawn(["bun", "run", "--silent", "eval"], {
    cwd,
    env: {
      ...inherited,
      HEX_CONFIG: "",
      HEX_EVAL_FIXTURES: "",
      HEX_EVAL_RESULTS: results,
      OPENAI_BASE_URL: openai.baseUrl,
      OPENAI_API_KEY: "sk-hex-eval-walkthrough-0123456789",
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
  return { stdout, stderr, code, results };
}

/** The single run folder under `results` and its decoded `report.json`. */
async function onlyReport(results: string) {
  const [run] = await readdir(results);
  expect(await readdir(results)).toHaveLength(1);
  const folder = join(results, run!);
  const report = Schema.decodeUnknownSync(Report)(
    JSON.parse(await readFile(join(folder, "report.json"), "utf8")),
  );
  return { folder, report };
}

/** Every file of `folder` with its bytes, base64. */
async function snapshot(folder: string) {
  const files = (await readdir(folder)).sort();
  return Promise.all(
    files.map(async (file) => [file, (await readFile(join(folder, file))).toString("base64")]),
  );
}

describe("bun run eval", () => {
  test("evaluates the fixture folder, prints the figures and writes both reports", async () => {
    const before = await snapshot(fixtures);
    const requests = model.requests.length;
    const { stdout, stderr, code, results } = await evalCommand({ HEX_EVAL_FIXTURES: fixtures });
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const { folder, report } = await onlyReport(results);
    expect(stdout).toBe(
      [
        `hex eval: openai/gpt-5.1-codex-mini on ${fixtures}`,
        "  Document detection: precision 14/14 (100.0 %), recall 14/14 (100.0 %)",
        "  Document date: exact 2/14 (14.3 %), month 2/14 (14.3 %); not sent 0, failed 0",
        `  Reports: ${join(folder, "report.md")}`,
        `           ${join(folder, "report.json")}`,
        "",
      ].join("\n"),
    );
    expect(model.requests.length - requests).toBe(14);
    expect(model.requests.at(-1)!.model).toBe("gpt-5.1-codex-mini");
    expect(report).toMatchObject({ fixtures, model: "openai/gpt-5.1-codex-mini" });
    expect(await readFile(join(folder, "report.md"), "utf8")).toContain(
      "| Rechnung-RE-2026-1042.pdf | 2026-11-02 | 2026-11-02 | yes | yes |",
    );
    expect(await snapshot(fixtures)).toEqual(before);
  });

  test("uses the committed synthetic set without HEX_EVAL_FIXTURES", async () => {
    const { code, results } = await evalCommand({});
    expect(code).toBe(0);
    expect((await onlyReport(results)).report.fixtures).toBe(syntheticFolder);
  });

  test("refuses to run under CI: no model call, nothing written", async () => {
    const requests = model.requests.length;
    const { stdout, stderr, code, results } = await evalCommand({
      CI: "true",
      HEX_EVAL_FIXTURES: fixtures,
    });
    expect({ code, stdout }).toEqual({ code: 1, stdout: "" });
    expect(stderr).toBe("hex eval: CI is set; evals run only by hand, with real API keys\n");
    expect(model.requests.length).toBe(requests);
    expect(await readdir(results).catch(() => "missing")).toBe("missing");
  });

  test("resolves relative HEX_EVAL_FIXTURES and HEX_EVAL_RESULTS against the caller's directory", async () => {
    const caller = join(repoRoot, "docs");
    const results = join(directory, "results-relative");
    const { code, stdout } = await evalCommand(
      {
        HEX_EVAL_FIXTURES: relative(caller, fixtures),
        HEX_EVAL_RESULTS: relative(caller, results),
      },
      { cwd: caller },
    );
    expect(code).toBe(0);
    const { folder, report } = await onlyReport(results);
    expect(report.fixtures).toBe(fixtures);
    expect(stdout).toContain(`on ${fixtures}\n`);
    expect(stdout).toContain(join(folder, "report.json"));
  });

  test("fails on a fixture error: exit 1, no model call, nothing written", async () => {
    const broken = join(directory, "broken");
    await mkdir(broken);
    await copyFile(join(fixtures, "01-de-pdf-invoice.eml"), join(broken, "01-de-pdf-invoice.eml"));
    await writeFile(
      join(broken, "expected.json"),
      JSON.stringify({
        intakes: [
          {
            file: "01-de-pdf-invoice.eml",
            documents: [{ fileName: "Missing.pdf", documentDate: null }],
          },
        ],
      }),
    );
    const requests = model.requests.length;
    const { stdout, stderr, code, results } = await evalCommand({ HEX_EVAL_FIXTURES: broken });
    expect({ code, stdout }).toEqual({ code: 1, stdout: "" });
    expect(stderr).toBe(
      `hex eval: fixture errors:\n${join(broken, "01-de-pdf-invoice.eml")}: expected.json labels "Missing.pdf", but the mail has no attachment of that name\n`,
    );
    expect(model.requests.length).toBe(requests);
    expect(await readdir(results).catch(() => "missing")).toBe("missing");
  });

  test("records a failed model call, writes the reports and exits 1", async () => {
    let calls = 0;
    const failing = fakeOpenAI(() =>
      ++calls === 1 ? { status: 400, message: "file rejected" } : NOVEMBER_2,
    );
    try {
      const { stderr, code, results } = await evalCommand(
        { HEX_EVAL_FIXTURES: fixtures },
        { openai: failing },
      );
      expect(code).toBe(1);
      expect(stderr).toBe("hex eval: 1 model call(s) failed; see the report\n");
      const { folder, report } = await onlyReport(results);
      expect(report.extraction.failed).toBe(1);
      expect(report.intakes[0]!.documents[0]).toMatchObject({
        fileName: "Rechnung-RE-2026-1042.pdf",
        status: "failed",
        exact: false,
      });
      expect(await readFile(join(folder, "report.md"), "utf8")).toContain(
        "(HTTP 400): file rejected",
      );
    } finally {
      await failing.server.stop(true);
    }
  });
});
