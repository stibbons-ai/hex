/**
 * Seam test of the eval (issue #12): `runEval` on fixture folders with a scripted DateExtractor,
 * asserting the computed figures and the reports it writes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateExtractionError, DateExtractor } from "@hex/adapters";
import { Effect, Layer, Schema } from "effect";
import { Report, loadExpectedSet, runEval } from "../src/index.ts";
import type { ExpectedSet } from "../src/index.ts";
import { syntheticFolder } from "../src/synthetic/generate.ts";

let directory: string;
let labels: ExpectedSet;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-eval-run-"));
  labels = await loadExpectedSet(syntheticFolder);
});

afterAll(() => rm(directory, { recursive: true, force: true }));

afterEach(() => setSystemTime());

/** The model's answer naming `date` (`YYYY-MM-DD`), or no date. */
function answer(date: string | null) {
  if (date === null) return { year: null, month: null, day: null };
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
}

/** A DateExtractor answering per file name: `script` if it has the name, else the label. */
function scriptedExtractor(script: Readonly<Record<string, unknown>> = {}) {
  const truth = new Map(
    labels.intakes.flatMap(({ documents }) =>
      documents.map(({ fileName, documentDate }) => [fileName, answer(documentDate)] as const),
    ),
  );
  const calls: string[] = [];
  const layer = Layer.succeed(DateExtractor, {
    extract: ({ fileName }) => {
      calls.push(fileName);
      const reply = Object.hasOwn(script, fileName) ? script[fileName] : truth.get(fileName);
      return reply instanceof DateExtractionError ? Effect.fail(reply) : Effect.succeed(reply);
    },
  });
  return { layer, calls };
}

let folders = 0;
/** A fresh, not yet created path under the temp directory. */
const newFolder = (name: string) => join(directory, `${name}-${++folders}`);

/**
 * A fixture folder with copies of the synthetic `.eml`s `intakes` names, labelled by them; `edit`
 * rewrites a mail's text (byte for byte as latin1), or leaves it out by returning undefined.
 */
async function fixtureFolder(
  intakes: ExpectedSet["intakes"],
  edit: (file: string, mail: string) => string | undefined = (_, mail) => mail,
): Promise<string> {
  const folder = await mkdtemp(join(directory, "fixtures-"));
  for (const { file } of intakes) {
    const mail = edit(file, await readFile(join(syntheticFolder, file), "latin1"));
    if (mail !== undefined) await writeFile(join(folder, file), mail, "latin1");
  }
  await writeFile(join(folder, "expected.json"), JSON.stringify({ intakes }));
  return folder;
}

const label = (file: string) => labels.intakes.find((intake) => intake.file === file)!;

describe("runEval on the synthetic set", () => {
  test("computes detection and Document date figures and writes both reports", async () => {
    const { layer, calls } = scriptedExtractor({
      "Rechnung-RE-2026-1042.pdf": answer("2026-11-03"), // wrong day, right month
      "PP-3301.pdf": answer("2026-10-01"), // wrong month
      "INV-2026-0815.pdf": answer(null), // no date for a dated Document
      "Kostenvoranschlag.pdf": answer("2026-06-01"), // a date for the undated Document
      "Kassenbeleg.png": { year: 2026, month: 2, day: 30 }, // no real day: none
      "scan-0001.pdf": new DateExtractionError({ message: "provider down" }),
    });
    const resultsRoot = newFolder("results");
    const { report, folder } = await runEval({
      fixtures: syntheticFolder,
      model: "scripted/model",
      dateExtractor: layer,
      resultsRoot,
    });

    expect(calls).toHaveLength(14);
    expect(report.detection).toEqual({
      truePositives: 14,
      falsePositives: 0,
      falseNegatives: 0,
      precision: { count: 14, total: 14, value: 1 },
      recall: { count: 14, total: 14, value: 1 },
    });
    expect(report.extraction).toEqual({
      exact: { count: 8, total: 14, value: 8 / 14 },
      month: { count: 9, total: 14, value: 9 / 14 },
      notSent: 0,
      failed: 1,
    });
    const row = (file: string) => report.intakes.find((intake) => intake.file === file)!;
    expect(row("01-de-pdf-invoice.eml").documents).toEqual([
      {
        fileName: "Rechnung-RE-2026-1042.pdf",
        expected: "2026-11-02",
        status: "answered",
        predicted: "2026-11-03",
        exact: false,
        month: true,
      },
    ]);
    expect(row("07-en-scan-pdf.eml").documents).toEqual([
      {
        fileName: "scan-0001.pdf",
        expected: "2026-08-07",
        status: "failed",
        error: "provider down",
        exact: false,
        month: false,
      },
    ]);
    expect(row("14-de-undated-document.eml").documents[0]).toMatchObject({
      expected: null,
      predicted: "2026-06-01",
      exact: false,
      month: false,
    });
    expect(row("13-de-multiple-documents.eml").documents[2]).toMatchObject({
      fileName: "Kassenbeleg.png",
      predicted: null,
      exact: false,
      month: false,
    });
    expect(row("08-de-inline-logo.eml").detection).toEqual({
      truePositives: ["Rechnung-RE-2026-1077.pdf"],
      falsePositives: [],
      falseNegatives: [],
    });
    expect(report.intakes.map(({ file }) => file)).toEqual(labels.intakes.map(({ file }) => file));

    expect(await readdir(resultsRoot)).toEqual([folder.slice(resultsRoot.length + 1)]);
    expect(folder.slice(resultsRoot.length + 1)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_scripted-model$/,
    );
    const json = Schema.decodeUnknownSync(Report)(
      JSON.parse(await readFile(join(folder, "report.json"), "utf8")),
    );
    expect(json).toEqual(report);
    const markdown = await readFile(join(folder, "report.md"), "utf8");
    for (const line of [
      "| Precision | 14/14 (100.0 %) |",
      "| Recall | 14/14 (100.0 %) |",
      "| Exact (year-month-day) | 8/14 (57.1 %) |",
      "| Month (year-month) | 9/14 (64.3 %) |",
      "| Failed | 1 |",
      "### 01-de-pdf-invoice.eml",
      "| Rechnung-RE-2026-1042.pdf | 2026-11-02 | 2026-11-03 | no | yes |",
      "| scan-0001.pdf | 2026-08-07 | error: provider down | no | no |",
      "| Kostenvoranschlag.pdf | none | 2026-06-01 | no | no |",
      "- Detected and labelled: Rechnung-RE-2026-1077.pdf",
    ]) {
      expect(markdown).toContain(line);
    }
  });

  test("never overwrites an earlier run's folder", async () => {
    setSystemTime(new Date("2026-11-05T15:00:00.000Z"));
    const resultsRoot = newFolder("results");
    const options = { fixtures: syntheticFolder, model: "scripted/model", resultsRoot };
    const first = await runEval({ ...options, dateExtractor: scriptedExtractor().layer });
    const second = await runEval({ ...options, dateExtractor: scriptedExtractor().layer });
    expect(first.folder).toBe(join(resultsRoot, "2026-11-05T15-00-00-000Z_scripted-model"));
    expect(second.folder).toBe(`${first.folder}-2`);
    expect(await readdir(resultsRoot)).toHaveLength(2);
  });
});

describe("runEval on edited labels", () => {
  test("counts false positives and false negatives; an unsendable labelled Document is not sent", async () => {
    const multiple = label("13-de-multiple-documents.eml");
    const fixtures = await fixtureFolder([
      {
        ...multiple,
        documents: [
          ...multiple.documents.filter(({ fileName }) => fileName !== "Kassenbeleg.png"),
          { fileName: "Hinweise.txt", documentDate: null },
        ],
      },
      { ...label("08-de-inline-logo.eml"), documents: [] },
      label("11-en-zero-documents-ics.eml"),
    ]);
    const { layer, calls } = scriptedExtractor();
    const { report } = await runEval({
      fixtures,
      model: "scripted/model",
      dateExtractor: layer,
      resultsRoot: newFolder("results"),
    });
    expect(report.detection).toEqual({
      truePositives: 2,
      falsePositives: 2,
      falseNegatives: 1,
      precision: { count: 2, total: 4, value: 0.5 },
      recall: { count: 2, total: 3, value: 2 / 3 },
    });
    expect(report.intakes[0]!.detection).toEqual({
      truePositives: ["Rechnung-RE-2026-0612.pdf", "Gutschrift-GS-2026-0031.pdf"],
      falsePositives: ["Kassenbeleg.png"],
      falseNegatives: ["Hinweise.txt"],
    });
    expect(report.intakes[1]!.detection.falsePositives).toEqual(["Rechnung-RE-2026-1077.pdf"]);
    // The undated .txt is never sent, so "no date" is right for it.
    expect(calls).toEqual(["Rechnung-RE-2026-0612.pdf", "Gutschrift-GS-2026-0031.pdf"]);
    expect(report.intakes[0]!.documents[2]).toEqual({
      fileName: "Hinweise.txt",
      expected: null,
      status: "not-sent",
      exact: true,
      month: true,
    });
    expect(report.extraction).toEqual({
      exact: { count: 3, total: 3, value: 1 },
      month: { count: 3, total: 3, value: 1 },
      notSent: 1,
      failed: 0,
    });
  });

  test("reports figures without a denominator as not applicable", async () => {
    const fixtures = await fixtureFolder([
      label("11-en-zero-documents-ics.eml"),
      label("12-de-zero-documents-plain.eml"),
    ]);
    const { report, folder } = await runEval({
      fixtures,
      model: "scripted/model",
      dateExtractor: scriptedExtractor().layer,
      resultsRoot: newFolder("results"),
    });
    const none = { count: 0, total: 0, value: null };
    expect(report.detection.precision).toEqual(none);
    expect(report.detection.recall).toEqual(none);
    expect(report.extraction.exact).toEqual(none);
    expect(report.extraction.month).toEqual(none);
    const json = JSON.parse(await readFile(join(folder, "report.json"), "utf8"));
    expect(json.detection.precision.value).toBeNull();
    const markdown = await readFile(join(folder, "report.md"), "utf8");
    expect(markdown).toContain("| Precision | 0/0 (n/a) |");
    expect(markdown).toContain("| Exact (year-month-day) | 0/0 (n/a) |");
  });

  test("collects every fixture error, before any model call, writing nothing", async () => {
    const invoice = label("01-de-pdf-invoice.eml");
    const multiple = label("13-de-multiple-documents.eml");
    const fixtures = await fixtureFolder(
      [
        { ...invoice, documents: [{ fileName: "Missing.pdf", documentDate: "2026-11-02" }] },
        multiple,
        label("02-en-pdf-invoice.eml"),
      ],
      (file, mail) => {
        if (file === "02-en-pdf-invoice.eml") return undefined;
        // Two attachments named like the invoice.
        return mail.replaceAll("Gutschrift-GS-2026-0031.pdf", "Rechnung-RE-2026-0612.pdf");
      },
    );
    const { layer, calls } = scriptedExtractor();
    const resultsRoot = newFolder("results");
    const run = runEval({ fixtures, model: "scripted/model", dateExtractor: layer, resultsRoot });
    const message = await run.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    expect(message.split("\n")).toEqual([
      "fixture errors:",
      `${join(fixtures, "01-de-pdf-invoice.eml")}: expected.json labels "Missing.pdf", but the mail has no attachment of that name`,
      `${join(fixtures, "13-de-multiple-documents.eml")}: expected.json labels "Rechnung-RE-2026-0612.pdf", but the mail has 2 attachments of that name`,
      `${join(fixtures, "13-de-multiple-documents.eml")}: expected.json labels "Gutschrift-GS-2026-0031.pdf", but the mail has no attachment of that name`,
      expect.stringContaining(
        `ENOENT: no such file or directory, open '${join(fixtures, "02-en-pdf-invoice.eml")}'`,
      ),
    ]);
    expect(calls).toEqual([]);
    expect(await readdir(resultsRoot).catch(() => "missing")).toBe("missing");
  });

  test("labels a nameless attachment by the name hex files it under", async () => {
    const invoice = label("01-de-pdf-invoice.eml");
    const fixtures = await fixtureFolder(
      [{ ...invoice, documents: [{ fileName: "document-1.pdf", documentDate: "2026-11-02" }] }],
      (_, mail) => mail.replaceAll(/; (?:file)?name="Rechnung-RE-2026-1042\.pdf"/g, ""),
    );
    const { layer, calls } = scriptedExtractor({ "document-1.pdf": answer("2026-11-02") });
    const { report } = await runEval({
      fixtures,
      model: "scripted/model",
      dateExtractor: layer,
      resultsRoot: newFolder("results"),
    });
    expect(calls).toEqual(["document-1.pdf"]);
    expect(report.intakes[0]!.detection.truePositives).toEqual(["document-1.pdf"]);
    expect(report.intakes[0]!.documents[0]).toMatchObject({ status: "answered", exact: true });
  });

  test("a sent Document labelled undated is right when the model finds no date", async () => {
    const fixtures = await fixtureFolder([label("14-de-undated-document.eml")]);
    const { layer, calls } = scriptedExtractor({ "Kostenvoranschlag.pdf": answer(null) });
    const { report } = await runEval({
      fixtures,
      model: "scripted/model",
      dateExtractor: layer,
      resultsRoot: newFolder("results"),
    });
    expect(calls).toEqual(["Kostenvoranschlag.pdf"]);
    expect(report.intakes[0]!.documents).toEqual([
      {
        fileName: "Kostenvoranschlag.pdf",
        expected: null,
        status: "answered",
        predicted: null,
        exact: true,
        month: true,
      },
    ]);
    expect(report.extraction.exact).toEqual({ count: 1, total: 1, value: 1 });
    expect(report.extraction.month).toEqual({ count: 1, total: 1, value: 1 });
  });

  test("fails before any model call when the results folder can't be created", async () => {
    const resultsRoot = newFolder("results-file");
    await writeFile(resultsRoot, "not a folder");
    const { layer, calls } = scriptedExtractor();
    const run = runEval({
      fixtures: syntheticFolder,
      model: "scripted/model",
      dateExtractor: layer,
      resultsRoot,
    });
    await expect(run).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(await readFile(resultsRoot, "utf8")).toBe("not a folder");
  });

  test("refuses a results folder inside the fixture folder", async () => {
    const fixtures = await fixtureFolder([label("11-en-zero-documents-ics.eml")]);
    const run = runEval({
      fixtures,
      model: "scripted/model",
      dateExtractor: scriptedExtractor().layer,
      resultsRoot: join(fixtures, "eval-results"),
    });
    await expect(run).rejects.toThrow("must not lie in the fixture folder");
    expect((await readdir(fixtures)).sort()).toEqual([
      "11-en-zero-documents-ics.eml",
      "expected.json",
    ]);
  });
});
