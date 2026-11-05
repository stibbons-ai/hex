// Hand-built `.eml` Intakes for the Intake workflow tests: no real mail, no personal data.

export interface Part {
  contentType: string;
  /** `Content-Disposition` value without the file name, e.g. `attachment` or `inline`. */
  disposition?: string;
  fileName?: string;
  /** RFC 2231 `filename*`, already percent-encoded UTF-8, e.g. `..%2Fx.pdf`. */
  encodedFileName?: string;
  /** Without angle brackets. */
  contentId?: string;
  content: Uint8Array;
}

export interface Mail {
  /** Without angle brackets; omitted leaves the header out. */
  messageId?: string;
  /** RFC 5322 date of the topmost Received header; omitted leaves Received out. */
  received?: string;
  /** RFC 5322 date of the Date header. */
  date?: string;
  html?: string;
  parts?: readonly Part[];
}

/** `size` bytes of filler content, so detection's size threshold can be exercised. */
export const bytes = (size: number, fill = "x") => new TextEncoder().encode(fill.repeat(size));

/** A PDF attachment. */
export const pdf = (fileName: string, content = bytes(500, "p")): Part => ({
  contentType: "application/pdf",
  disposition: "attachment",
  fileName,
  content,
});

/** A received date: 08:15 on 2 November 2026 in Berlin. */
export const RECEIVED = "Mon, 02 Nov 2026 08:15:00 +0100";

/** A multipart/mixed `.eml`: an HTML body (if any), then each part base64-encoded. */
export function buildEml({
  messageId,
  received,
  date = "Fri, 30 Oct 2026 10:00:00 +0100",
  html = "<p>Anbei.</p>",
  parts = [],
}: Mail): Uint8Array {
  const boundary = "hex-test-boundary";
  const lines = [
    ...(received ? [`Received: from mx.example.net by mail.example.com; ${received}`] : []),
    `Date: ${date}`,
    "From: Shop <billing@shop.example>",
    "To: intake@example.com",
    "Subject: Rechnung",
    ...(messageId ? [`Message-ID: <${messageId}>`] : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
  ];
  for (const part of parts) {
    const name =
      (part.fileName === undefined ? "" : `; filename="${part.fileName}"`) +
      (part.encodedFileName === undefined ? "" : `; filename*=UTF-8''${part.encodedFileName}`);
    lines.push(
      `--${boundary}`,
      `Content-Type: ${part.contentType}`,
      ...(part.disposition ? [`Content-Disposition: ${part.disposition}${name}`] : []),
      ...(part.contentId ? [`Content-ID: <${part.contentId}>`] : []),
      "Content-Transfer-Encoding: base64",
      "",
      ...(Buffer.from(part.content)
        .toString("base64")
        .match(/.{1,76}/g) ?? [""]),
    );
  }
  lines.push(`--${boundary}--`, "");
  return new TextEncoder().encode(lines.join("\r\n"));
}
