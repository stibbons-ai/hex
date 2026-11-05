/** Renders the synthetic Intakes to `.eml` files plus their `expected.json`, byte for byte reproducibly. */
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExpectedSet, type ExpectedIntake, type ExpectedSet } from "../expected.ts";
import { intakes, recipient, type Attachment, type SyntheticIntake } from "./intakes.ts";
import { documentDate, invoicePdf, scanPdf, scanPng } from "./invoice.ts";
import {
  filePart,
  headerDate,
  headerText,
  mailbox,
  renderMessage,
  textPart,
  type FilePart,
  type MimeNode,
} from "./mime.ts";
import { encodePng } from "./png.ts";
import { Bitmap } from "./raster.ts";

/** The committed set, `packages/eval-harness/fixtures/synthetic/`. */
export const syntheticFolder = fileURLToPath(new URL("../../fixtures/synthetic", import.meta.url));

/** The names the generator gives its `.eml` files, `NN-<slug>.eml`. */
const generatedName = /^\d{2}-[a-z0-9-]+\.eml$/;

/** A small grey PNG of `text`, two lines at most; large enough (> 20 KB) that only its role excludes it. */
function decoration(text: string): Uint8Array {
  const image = new Bitmap(360, 72);
  text.split("\n").forEach((line, index) => image.drawText(8, 8 + index * 32, line, 3));
  return encodePng({ ...image.gray(8), colorType: 0 });
}

/** A transparent 1×1 RGBA PNG. */
const pixel = encodePng({
  width: 1,
  height: 1,
  bitDepth: 8,
  colorType: 6,
  rows: [new Uint8Array(4)],
});

/** How each kind of attachment goes on the wire. */
function wireFormat(attachment: Attachment): Omit<FilePart, "fileName"> {
  switch (attachment.kind) {
    case "pdf":
      return {
        contentType: "application/pdf",
        disposition: "attachment",
        data: invoicePdf(attachment.invoice),
      };
    case "scan-pdf":
      return {
        contentType: "application/pdf",
        disposition: "attachment",
        data: scanPdf(attachment.invoice),
      };
    case "scan-png":
      return {
        contentType: "image/png",
        disposition: "attachment",
        data: scanPng(attachment.invoice),
      };
    case "logo":
      return {
        contentType: "image/png",
        disposition: "inline",
        contentId: attachment.contentId,
        data: decoration(attachment.text),
      };
    case "signature":
      // Outlook style: referenced from the HTML via cid:, yet marked as an attachment.
      return {
        contentType: "image/png",
        disposition: "attachment",
        contentId: attachment.contentId,
        data: decoration(attachment.text),
      };
    case "pixel":
      return {
        contentType: "image/png",
        disposition: "inline",
        contentId: attachment.contentId,
        data: pixel,
      };
    case "file":
      return {
        contentType: attachment.contentType,
        disposition: "attachment",
        data: new TextEncoder().encode(attachment.content),
      };
  }
}

function attachmentNode(attachment: Attachment): MimeNode {
  return filePart({ fileName: attachment.fileName, ...wireFormat(attachment) });
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
      if (!intake.html.includes(`cid:${attachment.contentId}`)) {
        throw new Error(`${intake.slug}: HTML misses cid:${attachment.contentId}`);
      }
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
    if (!generatedName.test(file)) throw new Error(`slug must be [a-z0-9-]+: ${intake.slug}`);
    const headers = [
      `From: ${mailbox(intake.from)}`,
      `To: ${mailbox(recipient)}`,
      `Subject: ${headerText(intake.subject)}`,
      `Date: ${headerDate(intake.sent)}`,
      `Message-ID: <synthetic-${number}-${intake.slug}@hex-fixtures.example>`,
      `Content-Language: ${intake.language}`,
    ];
    files.set(file, renderMessage(headers, messageTree(intake), `=_hex_${number}`));
    labelled.push({
      file,
      description: intake.description,
      documents: intake.attachments
        .filter((attachment) => "invoice" in attachment)
        .map((attachment) => ({
          fileName: attachment.fileName,
          documentDate: documentDate(attachment.invoice),
        })),
    });
  });
  const expected: ExpectedSet = { intakes: labelled };
  files.set("expected.json", new TextEncoder().encode(`${JSON.stringify(expected, null, 2)}\n`));
  return files;
}

/**
 * Whether `name` in `folder` belongs to a set this generator wrote: an `NN-<slug>.eml`, or an
 * `expected.json` that decodes and lists only such files. Anything else may be real mail.
 */
async function isGenerated(folder: string, name: string): Promise<boolean> {
  if (name !== "expected.json") return generatedName.test(name);
  const set = await loadExpectedSet(folder).catch(() => undefined);
  return set !== undefined && set.intakes.every(({ file }) => generatedName.test(file));
}

/**
 * Replaces the generated `.eml` files and `expected.json` in `folder` with a freshly rendered set.
 * Renders first, then refuses, touching nothing, when the folder holds any other `.eml` or a foreign
 * `expected.json`: those may be real fixtures, which git ignores and so cannot restore.
 */
export async function writeFixtureSet(folder: string): Promise<void> {
  const files = renderFixtureSet();
  await mkdir(folder, { recursive: true });
  const replaced = (await readdir(folder)).filter(
    (name) => /\.eml$/i.test(name) || name === "expected.json",
  );
  const foreign: string[] = [];
  for (const name of replaced) if (!(await isGenerated(folder, name))) foreign.push(name);
  if (foreign.length > 0) {
    throw new Error(`${folder} holds files this generator did not write: ${foreign.join(", ")}`);
  }
  for (const name of replaced) await rm(join(folder, name));
  for (const [name, bytes] of files) await Bun.write(join(folder, name), bytes);
}
