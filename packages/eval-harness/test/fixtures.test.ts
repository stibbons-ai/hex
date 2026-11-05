/**
 * Coverage of the committed synthetic set (issue #11): every label matches its `.eml`, and every
 * trap the set promises is present. The MIME walk is deliberately minimal; it is not the
 * workflow's Intake parser.
 */
import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadExpectedSet, type ExpectedIntake } from "../src/index.ts";
import { syntheticFolder } from "../src/synthetic/generate.ts";
import { intakes as model } from "../src/synthetic/intakes.ts";
import { printedLines } from "../src/synthetic/invoice.ts";

interface Part {
  contentType: string;
  disposition?: string;
  fileName?: string;
  contentId?: string;
  data: Uint8Array;
}

interface Mail {
  headers: Map<string, string>;
  parts: Part[];
  html: string;
}

function splitHeaders(raw: string): [Map<string, string>, string] {
  const end = raw.indexOf("\r\n\r\n");
  const headers = new Map<string, string>();
  for (const line of raw
    .slice(0, end)
    .replaceAll(/\r\n[ \t]+/g, " ")
    .split("\r\n")) {
    const colon = line.indexOf(":");
    headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return [headers, raw.slice(end + 4)];
}

function leaves(raw: string): Part[] {
  const [headers, body] = splitHeaders(raw);
  const type = headers.get("content-type") ?? "text/plain";
  const boundary = /boundary="([^"]+)"/.exec(type)?.[1];
  if (boundary !== undefined) {
    return body
      .split(`--${boundary}`)
      .slice(1, -1)
      .flatMap((part) => leaves(part.replace(/^\r\n/, "").replace(/\r\n$/, "")));
  }
  const disposition = headers.get("content-disposition");
  const fileName = /filename="([^"]+)"/.exec(disposition ?? "")?.[1];
  const contentId = /^<(.+)>$/.exec(headers.get("content-id") ?? "")?.[1];
  const base64 = headers.get("content-transfer-encoding") === "base64";
  return [
    {
      contentType: type.split(";")[0]!.trim(),
      ...(disposition === undefined ? {} : { disposition: disposition.split(";")[0]!.trim() }),
      ...(fileName === undefined ? {} : { fileName }),
      ...(contentId === undefined ? {} : { contentId }),
      data: base64
        ? Buffer.from(body.replaceAll("\r\n", ""), "base64")
        : new TextEncoder().encode(body),
    },
  ];
}

function parseMail(raw: string): Mail {
  const [headers] = splitHeaders(raw);
  const parts = leaves(raw);
  const html = parts
    .filter((part) => part.contentType === "text/html")
    .map((part) => new TextDecoder().decode(part.data))
    .join("");
  return { headers, parts, html };
}

/** A PDF's bytes as text, with WinAnsi octal escapes in its strings resolved (ä is `\344`). */
function pdfText(data: Uint8Array): string {
  return new TextDecoder("latin1")
    .decode(data)
    .replaceAll(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/** The strings a text PDF shows with `( … ) Tj`, unescaped. */
function pdfLines(text: string): string[] {
  return [...text.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map(([, line]) =>
    line!.replaceAll(/\\(.)/g, "$1"),
  );
}

/**
 * The lines a scanned Document shows. A scan has no text layer and this test does no OCR, so they
 * come from the generator's model, which is what the raster draws: a scan that skipped its date
 * row would still pass. A part with no invoice in the model (a mislabelled decoration) shows no
 * lines, so the Document assertions below report it instead of this lookup.
 */
function scanLines(intake: ExpectedIntake, fileName: string): string[] {
  const source = model.find(({ slug }) => intake.file === `${intake.file.slice(0, 3)}${slug}.eml`);
  const attachment = source?.attachments.find((candidate) => candidate.fileName === fileName);
  return attachment !== undefined && "invoice" in attachment
    ? printedLines(attachment.invoice)
    : [];
}

const isPdf = (part: Part) => part.contentType === "application/pdf";
const isImage = (part: Part) => part.contentType.startsWith("image/");
/** No plausible "tiny image" threshold (issue #6) may be what excludes a part. */
const sizeFloor = 20 * 1024;

const intakes = (await loadExpectedSet(syntheticFolder)).intakes;
const mails = new Map<string, Mail>();
for (const intake of intakes)
  mails.set(intake.file, parseMail(await Bun.file(join(syntheticFolder, intake.file)).text()));

const mailOf = (intake: ExpectedIntake) => mails.get(intake.file)!;
const referenced = (part: Part, html: string) =>
  part.contentId !== undefined && html.includes(`cid:${part.contentId}`);
/** Every labelled Document: its part, its label, its PDF text (if any) and its printed lines. */
const documents = intakes.flatMap((intake) =>
  intake.documents.map(({ fileName, documentDate }) => {
    const part = mailOf(intake).parts.find((candidate) => candidate.fileName === fileName);
    if (part === undefined) throw new Error(`${intake.file} has no part named ${fileName}`);
    const text = isPdf(part) ? pdfText(part.data) : "";
    const textLayer = text.includes(") Tj");
    const lines = textLayer ? pdfLines(text) : scanLines(intake, fileName);
    return { part, fileName, date: documentDate, intake, text, textLayer, lines };
  }),
);
const textPdfs = documents.filter(({ textLayer }) => textLayer);
const imageOnlyPdfs = documents.filter(
  ({ part, textLayer, text }) => isPdf(part) && !textLayer && text.includes("/Subtype /Image"),
);
/** Every attachment-like part of the set that is not labelled a Document. */
const nonDocuments = intakes.flatMap((intake) => {
  const labelled = new Set(intake.documents.map((document) => document.fileName));
  return mailOf(intake)
    .parts.filter((part) => part.fileName !== undefined && !labelled.has(part.fileName))
    .map((part) => ({ part, html: mailOf(intake).html }));
});

const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const monate = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
];
const pad = (value: number) => String(value).padStart(2, "0");

/** An ISO date as the invoices may print it: dot, short, ISO, German long, English long. */
function formats(iso: string): string[] {
  const [year, month, day] = iso.split("-").map(Number) as [number, number, number];
  return [
    `${pad(day)}.${pad(month)}.${year}`,
    `${day} ${months[month - 1]!.slice(0, 3)} ${year}`,
    `${year}-${pad(month)}-${pad(day)}`,
    `${day}. ${monate[month - 1]} ${year}`,
    `${months[month - 1]} ${day}, ${year}`,
  ];
}

/**
 * Labels that print a Document date; every other date label is a distractor. This wording is the
 * contract between the invoices and their labels: a new Document-date label must be added here.
 */
const documentDateLabels = ["Rechnungsdatum", "Invoice date", "Datum"];

describe("committed synthetic fixture set", () => {
  test("holds 10–20 Intakes and labels exactly the .eml files in the folder", async () => {
    const files = (await readdir(syntheticFolder)).filter((name) => name.endsWith(".eml")).sort();
    expect(intakes.map((intake) => intake.file).sort()).toEqual(files);
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files.length).toBeLessThanOrEqual(20);
    for (const intake of intakes) expect(intake.description ?? "").not.toBe("");
  });

  test("every From names its address outside any encoded word of at most 75 characters", () => {
    for (const { file } of intakes) {
      const from = mails.get(file)!.headers.get("from") ?? "";
      const words = from.match(/=\?[^?]+\?[BbQq]\?[^?]*\?=/g) ?? [];
      const outside = words.reduce((rest, word) => rest.replace(word, ""), from);
      expect({
        file,
        address: /<[^<>@\s]+@[^<>@\s]+>$/.test(outside),
        tooLong: words.filter((word) => word.length > 75),
      }).toEqual({ file, address: true, tooLong: [] });
    }
  });

  test("every Document is an attachment part of its .eml, in MIME order, PDF or image, over 20 KB, never cid:-referenced", () => {
    for (const intake of intakes) {
      const positions = intake.documents.map((document) =>
        mailOf(intake).parts.findIndex((part) => part.fileName === document.fileName),
      );
      expect({ file: intake.file, positions }).toEqual({
        file: intake.file,
        positions: [...positions].sort((a, b) => a - b),
      });
    }
    for (const { part, fileName, intake } of documents) {
      expect({
        fileName,
        disposition: part.disposition,
        cid: referenced(part, mailOf(intake).html),
      }).toEqual({ fileName, disposition: "attachment", cid: false });
      expect(isPdf(part) || isImage(part)).toBe(true);
      expect(part.data.length).toBeGreaterThan(sizeFloor);
    }
  });

  test("labels each Document with the date printed beside its Document-date label, or null when none is printed", () => {
    for (const { fileName, date, lines } of documents) {
      const printed = lines.flatMap((line) => {
        const label = documentDateLabels.find((candidate) => line.startsWith(`${candidate}: `));
        return label === undefined ? [] : [line.slice(label.length + 2)];
      });
      const expected =
        date === null ? [] : formats(date).filter((format) => printed.includes(format));
      expect({ fileName, printed }).toEqual({ fileName, printed: date === null ? [] : expected });
      if (date !== null)
        expect({ fileName, count: expected.length }).toEqual({ fileName, count: 1 });
    }
  });

  test("covers German and English mails and invoices", () => {
    const languages = new Set(
      intakes.map((intake) => mailOf(intake).headers.get("content-language")),
    );
    expect([...languages].sort()).toEqual(["de", "en"]);
    expect(
      textPdfs.some(({ lines }) => lines.some((line) => line.startsWith("Rechnungsdatum: "))),
    ).toBe(true);
    expect(
      textPdfs.some(({ lines }) => lines.some((line) => line.startsWith("Invoice date: "))),
    ).toBe(true);
  });

  test("prints Document dates in dot, short, ISO, German long and English long formats", () => {
    for (const index of formats("2026-01-01").keys()) {
      const found = textPdfs.some(
        ({ date, lines }) =>
          date !== null && lines.some((line) => line.endsWith(`: ${formats(date)[index]}`)),
      );
      expect({ format: index, found }).toEqual({ format: index, found: true });
    }
  });

  test("has scanned Documents: a PNG and an image-only PDF", () => {
    expect(documents.some(({ part }) => part.contentType === "image/png")).toBe(true);
    expect(imageOnlyPdfs.length).toBeGreaterThan(0);
  });

  test("sets due-date, service-date and month-boundary traps", () => {
    for (const label of [
      "Fälligkeitsdatum",
      "Due date",
      "Leistungsdatum",
      "Lieferdatum",
      "Service period",
    ]) {
      const found = textPdfs.some(({ lines }) =>
        lines.some((line) => line.startsWith(`${label}: `)),
      );
      expect({ label, found }).toEqual({ label, found: true });
    }
    const sentMonth = (intake: ExpectedIntake) => {
      const [, month, year] = /^\w{3}, \d{2} (\w{3}) (\d{4})/.exec(
        mailOf(intake).headers.get("date")!,
      )!;
      const index = months.findIndex((name) => name.startsWith(month!));
      expect({ file: intake.file, month, known: index >= 0 }).toEqual({
        file: intake.file,
        month,
        known: true,
      });
      return `${year}-${pad(index + 1)}`;
    };
    expect(
      documents.some(({ date, intake }) => date !== null && date.slice(0, 7) !== sentMonth(intake)),
    ).toBe(true);
  });

  test("has multiple-Document, zero-Document and undated-Document Intakes", () => {
    expect(intakes.some((intake) => intake.documents.length >= 2)).toBe(true);
    expect(intakes.some((intake) => intake.documents.length === 0)).toBe(true);
    expect(documents.some(({ date }) => date === null)).toBe(true);
  });

  test("has non-Documents that are never labelled: inline logo, Outlook signature, tracking pixel, non-PDF/non-image file", () => {
    // The sizes define the traps: decorations big enough to defeat a size heuristic, a pixel tiny by nature.
    const big = (part: Part) => part.data.length > sizeFloor;
    expect(
      nonDocuments.some(
        ({ part, html }) =>
          isImage(part) && part.disposition === "inline" && referenced(part, html) && big(part),
      ),
    ).toBe(true);
    expect(
      nonDocuments.some(
        ({ part, html }) =>
          isImage(part) && part.disposition === "attachment" && referenced(part, html) && big(part),
      ),
    ).toBe(true);
    expect(nonDocuments.some(({ part }) => isImage(part) && part.data.length < 200)).toBe(true);
    expect(
      nonDocuments.some(
        ({ part }) => part.disposition === "attachment" && !isPdf(part) && !isImage(part),
      ),
    ).toBe(true);
  });

  test("labels every Document: each unlabelled file part is one of the non-Document traps", () => {
    const untrapped = nonDocuments
      .filter(
        ({ part, html }) =>
          !referenced(part, html) && part.data.length >= 200 && (isPdf(part) || isImage(part)),
      )
      .map(({ part }) => part.fileName);
    expect(untrapped).toEqual([]);
  });
});
