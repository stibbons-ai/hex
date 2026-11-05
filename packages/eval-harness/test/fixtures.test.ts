/**
 * Coverage of the committed synthetic set (issue #11): every label matches its `.eml`, and every
 * trap the set promises is present. The MIME walk is deliberately minimal; it is not the
 * workflow's Intake parser.
 */
import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadExpectedSet, type ExpectedIntake } from "../src/index.ts";
import { syntheticFolder } from "./paths.ts";

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

const isPdf = (part: Part) => part.contentType === "application/pdf";
const isImage = (part: Part) => part.contentType.startsWith("image/");

const intakes = (await loadExpectedSet(syntheticFolder)).intakes;
const mails = new Map<string, Mail>();
for (const intake of intakes)
  mails.set(intake.file, parseMail(await Bun.file(join(syntheticFolder, intake.file)).text()));

const mailOf = (intake: ExpectedIntake) => mails.get(intake.file)!;
/** Every labelled Document: its part, its label and, for a PDF, its text. */
const documents = intakes.flatMap((intake) =>
  intake.documents.map(({ fileName, documentDate }) => {
    const part = mailOf(intake).parts.find((candidate) => candidate.fileName === fileName);
    if (part === undefined) throw new Error(`${intake.file} has no part named ${fileName}`);
    return { part, date: documentDate, intake, text: isPdf(part) ? pdfText(part.data) : "" };
  }),
);
const textPdfs = documents.filter(({ text }) => text.includes(") Tj"));
const imageOnlyPdfs = documents.filter(
  ({ part, text }) => isPdf(part) && !text.includes(") Tj") && text.includes("/Subtype /Image"),
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

describe("committed synthetic fixture set", () => {
  test("holds 10–20 Intakes and labels exactly the .eml files in the folder", async () => {
    const files = (await readdir(syntheticFolder)).filter((name) => name.endsWith(".eml")).sort();
    expect(intakes.map((intake) => intake.file).sort()).toEqual(files);
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files.length).toBeLessThanOrEqual(20);
    for (const intake of intakes) expect(intake.description ?? "").not.toBe("");
  });

  test("every Document is an attachment part of its .eml, in MIME order, PDF or image, over 20 KB", () => {
    for (const intake of intakes) {
      const positions = intake.documents.map((document) =>
        mailOf(intake).parts.findIndex((part) => part.fileName === document.fileName),
      );
      expect({ file: intake.file, positions }).toEqual({
        file: intake.file,
        positions: [...positions].sort((a, b) => a - b),
      });
    }
    for (const { part } of documents) {
      expect({ fileName: part.fileName, disposition: part.disposition }).toEqual({
        fileName: part.fileName,
        disposition: "attachment",
      });
      expect(isPdf(part) || isImage(part)).toBe(true);
      expect(part.data.length).toBeGreaterThan(20 * 1024);
    }
  });

  test("covers German and English mails and invoices", () => {
    const languages = new Set(
      intakes.map((intake) => mailOf(intake).headers.get("content-language")),
    );
    expect([...languages].sort()).toEqual(["de", "en"]);
    expect(textPdfs.some(({ text }) => text.includes("(Rechnungsdatum:"))).toBe(true);
    expect(textPdfs.some(({ text }) => text.includes("(Invoice date:"))).toBe(true);
  });

  test("prints Document dates as 02.11.2026, 2 Nov 2026, 2026-11-02 and written out", () => {
    const printed = (format: (year: string, month: number, day: number) => string) =>
      textPdfs.some(({ date, text }) => {
        if (date === null) return false;
        const [year, month, day] = date.split("-");
        return text.includes(`: ${format(year!, Number(month), Number(day))})`);
      });
    expect(
      printed(
        (year, month, day) =>
          `${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}.${year}`,
      ),
    ).toBe(true);
    expect(printed((year, month, day) => `${day} ${months[month - 1]!.slice(0, 3)} ${year}`)).toBe(
      true,
    );
    expect(
      printed(
        (year, month, day) =>
          `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      ),
    ).toBe(true);
    expect(printed((year, month, day) => `${day}. ${monate[month - 1]} ${year}`)).toBe(true);
    expect(printed((year, month, day) => `${months[month - 1]} ${day}, ${year}`)).toBe(true);
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
      expect({ label, found: textPdfs.some(({ text }) => text.includes(`(${label}:`)) }).toEqual({
        label,
        found: true,
      });
    }
    const monthBoundary = documents.some(({ date, intake }) => {
      const sent = /^\w{3}, \d{2} (\w{3}) (\d{4})/.exec(mailOf(intake).headers.get("date")!)!;
      const sentMonth = `${sent[2]}-${String(months.findIndex((name) => name.startsWith(sent[1]!)) + 1).padStart(2, "0")}`;
      return date !== null && date.slice(0, 7) !== sentMonth;
    });
    expect(monthBoundary).toBe(true);
  });

  test("has multiple-Document, zero-Document and undated-Document Intakes", () => {
    expect(intakes.some((intake) => intake.documents.length >= 2)).toBe(true);
    expect(intakes.some((intake) => intake.documents.length === 0)).toBe(true);
    expect(documents.some(({ date }) => date === null)).toBe(true);
  });

  test("has non-Documents that are never labelled: inline logo, Outlook signature, tracking pixel, non-PDF/non-image file", () => {
    const referenced = (part: Part, html: string) =>
      part.contentId !== undefined && html.includes(`cid:${part.contentId}`);
    const big = (part: Part) => part.data.length > 20 * 1024;
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
});
