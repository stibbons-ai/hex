/** Renders the synthetic Intakes to `.eml` files plus their `expected.json`, byte for byte reproducibly. */
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExpectedIntake, ExpectedSet } from "../expected.ts";
import { intakes, type Attachment, type SyntheticIntake } from "./intakes.ts";
import { documentDate, invoicePdf, scanPdf, scanPng } from "./invoice.ts";
import { filePart, headerText, renderMessage, textPart, type MimeNode } from "./mime.ts";
import { encodePng } from "./png.ts";
import { Bitmap } from "./raster.ts";

const recipient = "Erika Mustermann <erika.mustermann@hex.example>";
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const monthNames = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** `2026-11-02T09:14:00+01:00` → `Mon, 02 Nov 2026 09:14:00 +0100`, without the local time zone. */
function mailDate(sent: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})([+-]\d{2}):(\d{2})$/.exec(sent);
  if (match === null) throw new Error(`bad sent time ${sent}`);
  const [, year, month, day, time, offsetHours, offsetMinutes] = match as unknown as string[];
  const weekday =
    weekdays[new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay()];
  return `${weekday}, ${day} ${monthNames[Number(month) - 1]} ${year} ${time} ${offsetHours}${offsetMinutes}`;
}

/** A small grey PNG of `text`, two lines at most; large enough (> 20 KB) that only its role excludes it. */
function decoration(text: string): Uint8Array {
  const image = new Bitmap(360, 72);
  text.split("\n").forEach((line, index) => image.drawText(8, 8 + index * 32, line, 3));
  return encodePng({
    width: image.width,
    height: image.height,
    bitDepth: 8,
    colorType: 0,
    rows: image.toGray8(),
  });
}

/** A transparent 1×1 RGBA PNG. */
const pixel = encodePng({
  width: 1,
  height: 1,
  bitDepth: 8,
  colorType: 6,
  rows: [new Uint8Array(4)],
});

function isDocument(
  attachment: Attachment,
): attachment is Extract<Attachment, { invoice: unknown }> {
  return "invoice" in attachment;
}

function attachmentNode(attachment: Attachment): MimeNode {
  const { fileName } = attachment;
  switch (attachment.kind) {
    case "pdf":
      return filePart({
        contentType: "application/pdf",
        fileName,
        disposition: "attachment",
        data: invoicePdf(attachment.invoice),
      });
    case "scan-pdf":
      return filePart({
        contentType: "application/pdf",
        fileName,
        disposition: "attachment",
        data: scanPdf(attachment.invoice),
      });
    case "scan-png":
      return filePart({
        contentType: "image/png",
        fileName,
        disposition: "attachment",
        data: scanPng(attachment.invoice),
      });
    case "logo":
      return filePart({
        contentType: "image/png",
        fileName,
        disposition: "inline",
        contentId: attachment.contentId,
        data: decoration(attachment.text),
      });
    case "signature":
      // Outlook style: referenced from the HTML via cid:, yet marked as an attachment.
      return filePart({
        contentType: "image/png",
        fileName,
        disposition: "attachment",
        contentId: attachment.contentId,
        data: decoration(attachment.text),
      });
    case "pixel":
      return filePart({
        contentType: "image/png",
        fileName,
        disposition: "inline",
        contentId: attachment.contentId,
        data: pixel,
      });
    case "file":
      return filePart({
        contentType: attachment.contentType,
        fileName,
        disposition: "attachment",
        data: new TextEncoder().encode(attachment.content),
      });
  }
}

/**
 * The MIME tree: `cid:` decorations sit with the HTML in multipart/related, every other
 * attachment follows in multipart/mixed in list order.
 */
function messageTree(intake: SyntheticIntake): MimeNode {
  const referenced = intake.attachments.filter((attachment) => "contentId" in attachment);
  const attached = intake.attachments.filter((attachment) => !("contentId" in attachment));
  let body: MimeNode = textPart("text/plain", intake.text);
  if (intake.html !== undefined) {
    for (const attachment of referenced) {
      if (!intake.html.includes(`cid:${attachment.contentId}`))
        throw new Error(`${intake.slug}: HTML misses cid:${attachment.contentId}`);
    }
    const alternative: MimeNode = {
      subtype: "alternative",
      parts: [body, textPart("text/html", intake.html)],
    };
    body =
      referenced.length === 0
        ? alternative
        : { subtype: "related", parts: [alternative, ...referenced.map(attachmentNode)] };
  } else if (referenced.length > 0) {
    throw new Error(`${intake.slug}: cid: attachments need an HTML body`);
  }
  return attached.length === 0
    ? body
    : { subtype: "mixed", parts: [body, ...attached.map(attachmentNode)] };
}

/** The set's file names and contents: `NN-<slug>.eml` per Intake and one `expected.json`. */
export function renderFixtureSet(): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const labelled: ExpectedIntake[] = [];
  intakes.forEach((intake, index) => {
    const number = String(index + 1).padStart(2, "0");
    const file = `${number}-${intake.slug}.eml`;
    const headers = [
      `From: ${headerText(intake.from)}`,
      `To: ${recipient}`,
      `Subject: ${headerText(intake.subject)}`,
      `Date: ${mailDate(intake.sent)}`,
      `Message-ID: <synthetic-${number}-${intake.slug}@hex-fixtures.example>`,
      `Content-Language: ${intake.language}`,
    ];
    files.set(file, renderMessage(headers, messageTree(intake), `=_hex_${number}`));
    labelled.push({
      file,
      description: intake.description,
      documents: intake.attachments.filter(isDocument).map((attachment) => ({
        fileName: attachment.fileName,
        documentDate: documentDate(attachment.invoice),
      })),
    });
  });
  const expected: ExpectedSet = { intakes: labelled };
  files.set("expected.json", new TextEncoder().encode(`${JSON.stringify(expected, null, 2)}\n`));
  return files;
}

/** Replaces the `.eml` files and `expected.json` in `folder` with a freshly rendered set. */
export async function writeFixtureSet(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true });
  for (const name of await readdir(folder)) {
    if (name.endsWith(".eml") || name === "expected.json") await rm(join(folder, name));
  }
  for (const [name, bytes] of renderFixtureSet()) await Bun.write(join(folder, name), bytes);
}
