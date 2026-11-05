import { normalizeMessageId } from "./ids";

/** What the Intake tells about one attachment, enough to decide whether it is a Document. */
export interface AttachmentFacts {
  /** Content-Type as sent; case and parameters don't matter. */
  readonly mimeType: string;
  /** The sender's file name, if any. */
  readonly fileName?: string | undefined;
  /**
   * Content-Disposition (`inline`, `attachment`, …). Recorded but not decisive: Apple Mail sends
   * scans as unreferenced `inline` images, and decoration may come as `attachment` while the HTML
   * body shows it by `cid:`. Whether the body references the part decides instead.
   */
  readonly disposition?: string | undefined;
  /** Whether the HTML body references this part's Content-ID with a `cid:` URL. */
  readonly referencedByCid: boolean;
  /** Decoded content size in bytes. */
  readonly size: number;
}

/**
 * Images smaller than this are decoration, not Documents: tracking pixels are well under 1 KiB
 * and signature logos and social icons mostly a few KiB, while a legible scan or phone photo of a
 * receipt is far larger. A PDF is never dropped for its size.
 */
export const MIN_IMAGE_DOCUMENT_BYTES = 10 * 1024;

/**
 * Raster image types a scan or photo comes as, with the extension a nameless one is filed with.
 * SVG is left out (logos, never a scan).
 */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/pjpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/tiff": ".tif",
  "image/bmp": ".bmp",
};

/** The MIME type without parameters, lowercased: `Application/PDF; name=x` → `application/pdf`. */
function baseMimeType(mimeType: string): string {
  return (mimeType.split(";", 1)[0] ?? "").trim().toLowerCase();
}

function imageExtension(mimeType: string): string | undefined {
  const type = baseMimeType(mimeType);
  return Object.hasOwn(IMAGE_EXTENSIONS, type) ? IMAGE_EXTENSIONS[type] : undefined;
}

function isPdf({ mimeType, fileName }: Pick<AttachmentFacts, "mimeType" | "fileName">): boolean {
  const type = baseMimeType(mimeType);
  if (type === "application/pdf") return true;
  return type === "application/octet-stream" && /\.pdf$/i.test(fileName?.trim() ?? "");
}

/**
 * Whether an attachment is a Document: a PDF or a raster image that is not decoration.
 * A part the HTML body references by `cid:` is decoration whatever its type or disposition; an
 * image below {@link MIN_IMAGE_DOCUMENT_BYTES} is too. Everything else that is not a PDF or an
 * image (calendar invites, text, office files, forwarded mails) is not a Document.
 * `application/octet-stream` named `*.pdf` counts as a PDF.
 */
export function isDocument(attachment: AttachmentFacts): boolean {
  if (attachment.referencedByCid) return false;
  if (isPdf(attachment)) return true;
  return (
    imageExtension(attachment.mimeType) !== undefined && attachment.size >= MIN_IMAGE_DOCUMENT_BYTES
  );
}

/** The extension (with its dot) a Document of this MIME type is filed with when it has no name. */
export function documentExtension(mimeType: string): string {
  return imageExtension(mimeType) ?? ".pdf";
}

/**
 * Image types hex hands a model, each with the leading bytes (`undefined`: any byte) its content
 * starts with: a stricter subset of the signatures Mastra checks before it sends an image
 * (`isValidInlineContent`, which also passes BMP, TIFF, AVIF and HEIF). They are the types OpenAI
 * and Anthropic both document as image input (GIF only static: OpenAI takes non-animated GIFs,
 * Anthropic reads the first frame). The default model is OpenAI's; Google's Gemini documents PNG,
 * JPEG, WebP, HEIC and HEIF, so GIF is unverified there. Other images (HEIC, HEIF, TIFF, BMP)
 * OpenAI and Anthropic reject, which would fail every run of the Intake.
 */
const MODEL_IMAGE_SIGNATURES: readonly (readonly [string, readonly (number | undefined)[]])[] = [
  ["image/jpeg", [0xff, 0xd8]],
  ["image/png", [0x89, 0x50, 0x4e, 0x47]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
  [
    "image/webp",
    [0x52, 0x49, 0x46, 0x46, undefined, undefined, undefined, undefined, 0x57, 0x45, 0x42, 0x50],
  ],
];

/**
 * The leading bytes a PDF's `%PDF` header must lie within, as Mastra's `isValidInlineContent`
 * checks before sending one (the first 1026 bytes): the header may start at byte 1022 at the
 * latest.
 */
const PDF_HEADER_WINDOW = 1026;

const PDF_HEADER = [0x25, 0x50, 0x44, 0x46]; // %PDF

function hasPdfHeader(content: Uint8Array): boolean {
  const end = Math.min(content.length, PDF_HEADER_WINDOW) - PDF_HEADER.length;
  for (let start = 0; start <= end; start++) {
    if (PDF_HEADER.every((byte, offset) => content[start + offset] === byte)) return true;
  }
  return false;
}

/**
 * The media type to hand a Document to a model as, so it can read the Document date, decided by
 * its declared type and its content: a PDF (`application/octet-stream` named `*.pdf` too) as
 * `application/pdf` when `%PDF` lies within its first 1026 bytes; an image as the type its
 * content's signature names (JPEG, PNG, GIF, WebP), whatever type it was declared as. Undefined
 * otherwise, and the Document is never sent but filed by its received date, for one of two
 * reasons: content matching none of Mastra's signatures (no valid PDF or image) Mastra would
 * replace by a placeholder text the model answers blind; image types Mastra does pass (HEIC,
 * HEIF, AVIF, TIFF, BMP) OpenAI and Anthropic refuse, failing the run every time. A type that is
 * no Document is undefined too.
 */
export function documentMediaType(
  attachment: Pick<AttachmentFacts, "mimeType" | "fileName"> & { readonly content: Uint8Array },
): string | undefined {
  const { content } = attachment;
  if (isPdf(attachment)) return hasPdfHeader(content) ? "application/pdf" : undefined;
  if (imageExtension(attachment.mimeType) === undefined) return undefined;
  return MODEL_IMAGE_SIGNATURES.find(([, prefix]) =>
    prefix.every((byte, offset) => byte === undefined || content[offset] === byte),
  )?.[0];
}

/** A Content-ID as compared with `cid:` references: no angle brackets, trimmed, lowercase. */
export function normalizeContentId(contentId: string): string {
  return normalizeMessageId(contentId).toLowerCase();
}

/** Every Content-ID the HTML body references with a `cid:` URL, normalised. */
export function contentIdReferences(html: string): Set<string> {
  const references = new Set<string>();
  // A `cid:` URL starts where no word character, `/`, `.`, `:`, `%` or `-` precedes it: at an
  // attribute value, after `url(`, or after whitespace in plain text, never inside another URL
  // (`https://x/cid:y`). The URL ends at whitespace, a quote, `<`, `>` or a parenthesis.
  for (const [, raw] of html.matchAll(/(?<![\w/.:%-])cid:([^\s"'<>()]+)/gi)) {
    let decoded = raw!;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Not valid percent-encoding: compare it as written.
    }
    references.add(normalizeContentId(decoded));
  }
  return references;
}
