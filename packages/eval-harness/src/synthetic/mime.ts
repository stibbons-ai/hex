/** A minimal MIME writer: fixed boundaries and headers, CRLF line endings, base64 file parts. */
import { isCalendarDate } from "../expected.ts";

export type MimeNode =
  | { readonly headers: readonly string[]; readonly body: string }
  | { readonly subtype: "mixed" | "related" | "alternative"; readonly parts: readonly MimeNode[] };

export interface Mailbox {
  name: string;
  address: string;
}

const printableAscii = /^[\x20-\x7e]*$/;
/**
 * UTF-8 bytes per encoded word: 39 bytes are 52 base64 characters, 64 with `=?UTF-8?B?…?=`, so even
 * `Subject: ` plus one word stays within RFC 2047's 76-character line limit.
 */
const wordBytes = 39;

/**
 * `text` as is when it is plain ASCII, else RFC 2047 encoded words of at most 75 characters, folded
 * onto continuation lines. Words split between characters, never inside one.
 */
export function headerText(text: string): string {
  if (printableAscii.test(text)) return text;
  const words: string[] = [];
  let chunk = "";
  for (const char of text) {
    if (Buffer.byteLength(chunk + char) > wordBytes) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString("base64")}?=`).join("\n ");
}

/** `Name <address>`; the address always stays outside any encoded word. */
export function mailbox({ name, address }: Mailbox): string {
  // A plain name with RFC 5322 specials (".", ",", …) goes into a quoted string.
  const phrase =
    printableAscii.test(name) && /[()<>[\]:;@\\,."]/.test(name)
      ? `"${name.replaceAll(/["\\]/g, "\\$&")}"`
      : headerText(name);
  return `${phrase} <${address}>`;
}

/**
 * An RFC 5322 date from `YYYY-MM-DDTHH:MM:SS±HH:MM`, e.g. `Mon, 02 Nov 2026 09:14:00 +0100`.
 * The weekday comes from `toUTCString`, whose format ECMAScript fixes; no local time zone is read.
 */
export function headerDate(sent: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})([+-]\d{2}):(\d{2})$/.exec(sent);
  if (match === null || !isCalendarDate(match[1]!)) throw new Error(`bad sent time ${sent}`);
  const [, day, time, offsetHours, offsetMinutes] = match;
  const date = new Date(`${day}T00:00:00Z`).toUTCString().slice(0, 16);
  return `${date} ${time} ${offsetHours}${offsetMinutes}`;
}

/** A UTF-8 text part sent as 8bit (every line of the synthetic mails is far below 998 bytes). */
export function textPart(type: "text/plain" | "text/html", text: string): MimeNode {
  return {
    headers: [`Content-Type: ${type}; charset=utf-8`, "Content-Transfer-Encoding: 8bit"],
    body: text,
  };
}

export interface FilePart {
  contentType: string;
  fileName: string;
  disposition: "attachment" | "inline";
  /** Without angle brackets; referenced from HTML as `cid:<contentId>`. */
  contentId?: string;
  data: Uint8Array;
}

/** A base64 file part; `fileName` must be printable ASCII without `"` or `\` (no RFC 2231 here). */
export function filePart(file: FilePart): MimeNode {
  if (!printableAscii.test(file.fileName) || /["\\]/.test(file.fileName)) {
    throw new Error(`file name needs RFC 2231 encoding, which this writer lacks: ${file.fileName}`);
  }
  const base64 = Buffer.from(file.data).toString("base64");
  return {
    headers: [
      `Content-Type: ${file.contentType}; name="${file.fileName}"`,
      `Content-Disposition: ${file.disposition}; filename="${file.fileName}"`,
      ...(file.contentId === undefined ? [] : [`Content-ID: <${file.contentId}>`]),
      "Content-Transfer-Encoding: base64",
    ],
    body: (base64.match(/.{1,76}/g) ?? []).join("\n"),
  };
}

/**
 * Renders a message: `headers` first, then the tree. Multipart boundaries are numbered from
 * `boundaryPrefix` in document order, so the same tree always renders the same bytes.
 */
export function renderMessage(
  headers: readonly string[],
  root: MimeNode,
  boundaryPrefix: string,
): Uint8Array {
  let next = 0;
  const render = (node: MimeNode): string[] => {
    if ("body" in node) return [...node.headers, "", node.body];
    const boundary = `${boundaryPrefix}_${++next}`;
    return [
      `Content-Type: multipart/${node.subtype}; boundary="${boundary}"`,
      "",
      ...node.parts.flatMap((part) => [`--${boundary}`, ...render(part)]),
      `--${boundary}--`,
    ];
  };
  const text = [...headers, "MIME-Version: 1.0", ...render(root)].join("\n");
  return new TextEncoder().encode(`${text.replaceAll("\n", "\r\n")}\r\n`);
}
