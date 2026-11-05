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
export function baseMimeType(mimeType: string): string {
  return (mimeType.split(";", 1)[0] ?? "").trim().toLowerCase();
}

function imageExtension(mimeType: string): string | undefined {
  const type = baseMimeType(mimeType);
  return Object.hasOwn(IMAGE_EXTENSIONS, type) ? IMAGE_EXTENSIONS[type] : undefined;
}

function isPdf({ mimeType, fileName }: AttachmentFacts): boolean {
  const type = baseMimeType(mimeType);
  if (type === "application/pdf") return true;
  return type === "application/octet-stream" && /\.pdf$/i.test(fileName?.trim() ?? "");
}

/**
 * Whether an attachment is a Document: a PDF or a raster image that is not inline decoration.
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

/** A Content-ID as compared with `cid:` references: no angle brackets, trimmed, lowercase. */
export function normalizeContentId(contentId: string): string {
  return contentId
    .trim()
    .replace(/^<(.*)>$/s, "$1")
    .trim()
    .toLowerCase();
}

/** Every Content-ID the HTML body references with a `cid:` URL, normalised. */
export function contentIdReferences(html: string): Set<string> {
  const references = new Set<string>();
  // `cid:` starts the URL: an attribute value, `url(`, never the middle of another URL.
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
