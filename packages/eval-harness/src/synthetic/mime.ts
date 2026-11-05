/** A minimal MIME writer: fixed boundaries and headers, CRLF line endings, base64 for binaries. */

export type MimeNode =
  | { readonly headers: readonly string[]; readonly body: string }
  | { readonly subtype: "mixed" | "related" | "alternative"; readonly parts: readonly MimeNode[] };

/** An RFC 2047 encoded word when `text` is not plain ASCII. */
export function headerText(text: string): string {
  return /^[\x20-\x7e]*$/.test(text)
    ? text
    : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

/**
 * An RFC 5322 date from `YYYY-MM-DDTHH:MM:SS±HH:MM`, e.g. `Mon, 02 Nov 2026 09:14:00 +0100`.
 * The weekday comes from `toUTCString`, whose format ECMAScript fixes; no local time zone is read.
 */
export function headerDate(sent: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})([+-]\d{2}):(\d{2})$/.exec(sent);
  if (match === null) throw new Error(`bad sent time ${sent}`);
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

export function filePart(file: FilePart): MimeNode {
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
