import { documentExtension } from "./document";

/**
 * Longest file name, in UTF-8 bytes, a Document is filed under: room below the usual 255-byte
 * limit for a ` (n)` collision suffix and a temporary `.<id>.partial` suffix.
 */
export const MAX_FILE_NAME_BYTES = 200;

/** An extension longer than this (in bytes) is not kept whole when a name is shortened. */
const MAX_EXTENSION_BYTES = 32;

/** UTF-8 length; the domain has no `TextEncoder` (its `lib` is ES2022 only, no DOM or Node). */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * Splits a name at its last dot into stem and extension (with the dot): `a.b.pdf` → `a.b` and
 * `.pdf`. A leading dot (`.env`) or a trailing one does not start an extension.
 */
function splitExtension(name: string): [stem: string, extension: string] {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return [name, ""];
  return [name.slice(0, dot), name.slice(dot)];
}

/** `name` cut to at most `maxBytes` UTF-8 bytes, whole code points only. */
function truncateBytes(name: string, maxBytes: number): string {
  let kept = "";
  let bytes = 0;
  for (const character of name) {
    bytes += utf8Bytes(character);
    if (bytes > maxBytes) break;
    kept += character;
  }
  return kept;
}

/** Control and format characters (NUL, line breaks, bidi overrides, zero-width characters). */
const INVISIBLE = /[\p{Cc}\p{Cf}]/u;
const EVERY_INVISIBLE = new RegExp(INVISIBLE, "gu");

/**
 * Leading dots and whitespace (hidden files, `.`, `..`), trailing `.partial` suffixes (which the
 * sync skips) and surrounding whitespace stripped, until none is left.
 */
function stripReserved(name: string): string {
  let current = name;
  for (;;) {
    const next = current
      .trim()
      .replace(/^[.\s]+/, "")
      .replace(/\.partial$/i, "")
      .trim();
    if (next === current) return current;
    current = next;
  }
}

/**
 * Whether `name` is safe to file as it is: one non-empty path segment (no `/`, `\` or NUL), not
 * hidden (no leading dot, so never `.` or `..`), no surrounding whitespace, no control or format
 * characters, not ending in `.partial`, at most {@link MAX_FILE_NAME_BYTES} UTF-8 bytes. Every
 * {@link safeFileName} result is.
 */
export function isSafeFileName(name: string): boolean {
  return (
    name !== "" &&
    !/[/\\]/.test(name) &&
    !INVISIBLE.test(name) &&
    stripReserved(name) === name &&
    utf8Bytes(name) <= MAX_FILE_NAME_BYTES
  );
}

/**
 * Makes a sender's attachment file name safe to file (see {@link isSafeFileName}), otherwise
 * keeping it (NFC-normalised): only its last `/`- or `\`-separated segment counts; every control
 * and format character (`\p{Cc}`, `\p{Cf}`: NUL, line breaks, bidi overrides, zero-width
 * characters) is removed; leading dots, surrounding whitespace and trailing `.partial` suffixes
 * are stripped; a name over {@link MAX_FILE_NAME_BYTES} UTF-8 bytes is cut, keeping its
 * extension unless that is over 32 bytes. A name with nothing left becomes
 * `document-<position>.<extension from the MIME type>`, where `position` is the attachment's
 * 1-based position among all of the Intake's attachments.
 */
export function safeFileName(
  original: string | undefined,
  mimeType: string,
  position: number,
): string {
  const lastSegment = (original ?? "").normalize("NFC").split(/[/\\]/).pop() ?? "";
  const cleaned = stripReserved(lastSegment.replace(EVERY_INVISIBLE, ""));
  let [stem, extension] = splitExtension(cleaned);
  if (utf8Bytes(extension) > MAX_EXTENSION_BYTES) [stem, extension] = [cleaned, ""];
  const bounded = stripReserved(
    truncateBytes(stem, MAX_FILE_NAME_BYTES - utf8Bytes(extension)) + extension,
  );
  return bounded || `document-${position}${documentExtension(mimeType)}`;
}

/**
 * The first name not in `taken`: `desired` itself, else `name (1).pdf`, `name (2).pdf`, … The
 * counter goes before the last extension (`a.b.pdf` → `a.b (1).pdf`); a name without one, or a
 * dotfile like `.env`, gets it at the end (`name (1)`, `.env (1)`). Names compare exactly.
 */
export function freeFileName(desired: string, taken: ReadonlySet<string>): string {
  if (!taken.has(desired)) return desired;
  const [stem, extension] = splitExtension(desired);
  for (let counter = 1; ; counter++) {
    const candidate = `${stem} (${counter})${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
}
