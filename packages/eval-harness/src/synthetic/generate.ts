/** Renders the synthetic Intakes to `.eml` files plus their `expected.json`, byte for byte reproducibly. */
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readExpectedFile, type ExpectedIntake, type ExpectedSet } from "../expected.ts";
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

/** Domain of every generated `Message-ID`; how a later run recognises the files it may replace. */
const syntheticDomain = "hex-fixtures.example";

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
    if (!/^[a-z0-9-]+$/.test(intake.slug))
      throw new Error(`slug must be [a-z0-9-]+: ${intake.slug}`);
    const names = intake.attachments.map(({ fileName }) => fileName);
    const repeated = names.filter((name, at) => names.indexOf(name) !== at);
    if (repeated.length > 0)
      throw new Error(`${intake.slug}: repeated file names ${repeated.join(", ")}`);
    const file = `${number}-${intake.slug}.eml`;
    const headers = [
      `From: ${mailbox(intake.from)}`,
      `To: ${mailbox(recipient)}`,
      `Subject: ${headerText(intake.subject)}`,
      `Date: ${headerDate(intake.sent)}`,
      `Message-ID: <synthetic-${number}-${intake.slug}@${syntheticDomain}>`,
      `Content-Language: ${intake.language}`,
    ];
    files.set(file, renderMessage(headers, messageTree(intake), `=_hex_${number}`));
    labelled.push({
      file,
      description: intake.description,
      documents: intake.attachments
        .filter((attachment) => "invoice" in attachment)
        .map(({ fileName, invoice }) => ({
          fileName,
          documentDate: documentDate(invoice, fileName),
        })),
    });
  });
  const expected: ExpectedSet = { intakes: labelled };
  files.set("expected.json", new TextEncoder().encode(`${JSON.stringify(expected, null, 2)}\n`));
  return files;
}

/** The `Message-ID` header line every generated `.eml` carries. */
const syntheticMessageId = new RegExp(
  `^Message-ID: <synthetic-[^@>\\s]+@${syntheticDomain.replaceAll(".", "\\.")}>\\r?$`,
  "im",
);

/**
 * Why the `.eml` at `path` is not one this generator wrote, or `undefined` when it is (or is
 * absent): it must be a regular file whose header block carries the synthetic `Message-ID`.
 */
async function emlRefusal(path: string): Promise<string | undefined> {
  const stats = await lstat(path).catch(() => undefined);
  if (stats === undefined) return undefined;
  if (!stats.isFile()) return "not a regular file";
  const eml = await Bun.file(path).text();
  const end = eml.search(/\r?\n\r?\n/);
  return syntheticMessageId.test(end === -1 ? eml : eml.slice(0, end))
    ? undefined
    : `no Message-ID <synthetic-…@${syntheticDomain}>`;
}

/**
 * Why the labels at `path` are not ones this generator wrote, or `undefined` when they are: a
 * regular file that decodes and whose listed files in `folder`, where present, pass {@link emlRefusal}.
 */
async function labelsRefusal(folder: string, path: string): Promise<string | undefined> {
  if (!(await lstat(path)).isFile()) return "not a regular file";
  let set: ExpectedSet;
  try {
    set = await readExpectedFile(path);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  for (const { file } of set.intakes) {
    const reason = await emlRefusal(join(folder, file));
    if (reason !== undefined) return `lists ${file}, which is ${reason}`;
  }
  return undefined;
}

/**
 * Replaces the generated `.eml` files and `expected.json` in `folder` with a freshly rendered set.
 * Renders first, then refuses, touching nothing, when the folder holds any `.eml` or
 * `expected.json` (any letter case) this generator did not write, judged by content: those may be
 * real fixtures, which git ignores and so cannot restore.
 */
export async function writeFixtureSet(folder: string): Promise<void> {
  const files = renderFixtureSet();
  await mkdir(folder, { recursive: true });
  const replaced = (await readdir(folder)).filter((name) =>
    /^(?:.*\.eml|expected\.json)$/i.test(name),
  );
  const refused: string[] = [];
  for (const name of replaced) {
    const path = join(folder, name);
    const reason =
      name.toLowerCase() === "expected.json"
        ? await labelsRefusal(folder, path)
        : await emlRefusal(path);
    if (reason !== undefined) refused.push(`${name} (${reason})`);
  }
  if (refused.length > 0) {
    throw new Error(`${folder} holds files this generator did not write: ${refused.join("; ")}`);
  }
  for (const name of replaced) await rm(join(folder, name));
  for (const [name, bytes] of files) await Bun.write(join(folder, name), bytes);
}
