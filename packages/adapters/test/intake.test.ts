import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { readEml } from "../src";

const pdfBase64 = Buffer.from("%PDF-1.7 fake").toString("base64");
const pngBase64 = Buffer.from("PNG fake").toString("base64");

/** CRLF-joined lines, as an `.eml` file has them. */
const eml = (...lines: string[]) => new TextEncoder().encode(lines.join("\r\n"));

const headers = [
  "Received: from mx.example.net by mail.example.com; Sat, 31 Oct 2026 23:30:00 +0000 (UTC)",
  "Received: from sender.example by mx.example.net; Sat, 31 Oct 2026 23:29:00 +0000",
  "Date: Fri, 30 Oct 2026 10:00:00 +0100",
  "From: Shop <billing@shop.example>",
  "To: intake@example.com",
  "Subject: Rechnung",
  "Message-ID: <invoice-1@shop.example>",
  "MIME-Version: 1.0",
];

const read = (bytes: Uint8Array, source = "test.eml") => Effect.runPromise(readEml(bytes, source));

async function failure(bytes: Uint8Array, source = "test.eml"): Promise<string> {
  const exit = await Effect.runPromiseExit(readEml(bytes, source));
  if (Exit.isSuccess(exit)) throw new Error("expected readEml to fail");
  return String(exit.cause);
}

describe("readEml", () => {
  test("reads a multipart mail: Message-ID, received date, sender, attachments", async () => {
    const intake = await read(
      eml(
        ...headers,
        'Content-Type: multipart/mixed; boundary="b"',
        "",
        "--b",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Anbei die Rechnung.",
        "--b",
        'Content-Type: application/pdf; name="Rechnung.pdf"',
        'Content-Disposition: attachment; filename="Rechnung.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        pdfBase64,
        "--b",
        'Content-Type: text/calendar; name="invite.ics"',
        'Content-Disposition: attachment; filename="invite.ics"',
        "",
        "BEGIN:VCALENDAR",
        "--b--",
        "",
      ),
    );
    expect(intake).toMatchObject({
      messageId: "invoice-1@shop.example",
      // The topmost Received header, not the sender's Date.
      receivedAt: "2026-10-31T23:30:00.000Z",
      sender: "billing@shop.example",
      cidReferences: [],
    });
    expect(intake.attachments).toEqual([
      {
        fileName: "Rechnung.pdf",
        mimeType: "application/pdf",
        disposition: "attachment",
        content: pdfBase64,
      },
      expect.objectContaining({ fileName: "invite.ics", mimeType: "text/calendar" }),
    ]);
  });

  test("an inline logo referenced by cid: shows up as a reference and a Content-ID", async () => {
    const intake = await read(
      eml(
        ...headers,
        'Content-Type: multipart/related; boundary="r"',
        "",
        "--r",
        "Content-Type: text/html; charset=utf-8",
        "",
        '<p>Hallo</p><img src="cid:Logo@Shop.example">',
        "--r",
        "Content-Type: image/png",
        "Content-ID: <Logo@Shop.example>",
        'Content-Disposition: inline; filename="logo.png"',
        "Content-Transfer-Encoding: base64",
        "",
        pngBase64,
        "--r--",
        "",
      ),
    );
    expect(intake.cidReferences).toEqual(["logo@shop.example"]);
    expect(intake.attachments).toEqual([
      expect.objectContaining({
        fileName: "logo.png",
        disposition: "inline",
        contentId: "<Logo@Shop.example>",
      }),
    ]);
  });

  test("an Apple Mail inline PDF keeps its inline disposition and no Content-ID reference", async () => {
    const intake = await read(
      eml(
        ...headers,
        'Content-Type: multipart/mixed; boundary="a"',
        "",
        "--a",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>Scan</p>",
        "--a",
        'Content-Type: application/pdf; name="Scan.pdf"',
        'Content-Disposition: inline; filename="Scan.pdf"',
        "Content-ID: <scan-part@apple.example>",
        "Content-Transfer-Encoding: base64",
        "",
        pdfBase64,
        "--a--",
        "",
      ),
    );
    expect(intake.cidReferences).toEqual([]);
    expect(intake.attachments).toEqual([
      expect.objectContaining({ fileName: "Scan.pdf", disposition: "inline" }),
    ]);
  });

  test("decodes RFC 2047 and RFC 2231 file names; a missing name stays missing", async () => {
    const intake = await read(
      eml(
        ...headers,
        'Content-Type: multipart/mixed; boundary="n"',
        "",
        "--n",
        "Content-Type: application/pdf",
        'Content-Disposition: attachment; filename="=?UTF-8?B?UmVjaG51bmcgTcOkcnoucGRm?="',
        "Content-Transfer-Encoding: base64",
        "",
        pdfBase64,
        "--n",
        "Content-Type: application/pdf",
        "Content-Disposition: attachment; filename*=UTF-8''Gr%C3%BC%C3%9Fe%20%E2%82%AC.pdf",
        "Content-Transfer-Encoding: base64",
        "",
        pdfBase64,
        "--n",
        "Content-Type: application/pdf",
        "Content-Disposition: attachment",
        "Content-Transfer-Encoding: base64",
        "",
        pdfBase64,
        "--n--",
        "",
      ),
    );
    const [encodedWord, extended, nameless] = intake.attachments;
    expect(encodedWord?.fileName).toBe("Rechnung März.pdf");
    expect(extended?.fileName).toBe("Grüße €.pdf");
    expect(nameless).not.toHaveProperty("fileName");
  });

  test("without a Received header the Date header is the received date", async () => {
    const intake = await read(
      eml(...headers.filter((line) => !line.startsWith("Received")), "", "body"),
    );
    expect(intake.receivedAt).toBe("2026-10-30T09:00:00.000Z");
  });

  // The topmost Received date is used only after a `;` and only when it is a strict RFC 5322
  // date-time with a zone; otherwise the Date header (30 Oct 2026 10:00 +0100) is.
  test.each([
    ["no ';' (a date-like id)", "from a by mx.example.org id 2024", "2026-10-30T09:00:00.000Z"],
    [
      "no ';' (a five-digit id)",
      "from a by mx.example.org with ESMTP id 12345",
      "2026-10-30T09:00:00.000Z",
    ],
    ["not a date after ';'", "from a by b; not a date", "2026-10-30T09:00:00.000Z"],
    ["31 February", "from a by b; Tue, 31 Feb 2025 10:00:00 +0000", "2026-10-30T09:00:00.000Z"],
    ["year 0999", "from a by b; Mon, 1 Jan 0999 10:00:00 +0000", "2026-10-30T09:00:00.000Z"],
    ["no zone", "from a by b; Tue, 4 Nov 2026 23:30:00", "2026-10-30T09:00:00.000Z"],
    ["hour 24", "from a by b; Tue, 4 Nov 2026 24:00:00 +0000", "2026-10-30T09:00:00.000Z"],
    [
      "valid, comment zone",
      "from a by b; Tue, 4 Nov 2026 23:30:00 +0100 (CET)",
      "2026-11-04T22:30:00.000Z",
    ],
    ["valid, no seconds", "from a by b; 4 Nov 2026 23:30 -0500", "2026-11-05T04:30:00.000Z"],
    [
      "valid, obsolete zone",
      "from a by b;\r\n\tTue, 4 Nov 2026 23:30:00 GMT",
      "2026-11-04T23:30:00.000Z",
    ],
  ])("Received %s → %s", async (_case, received, expected) => {
    const intake = await read(eml(`Received: ${received}`, ...headers.slice(2), "", "body"));
    expect(intake.receivedAt).toBe(expected);
  });

  test.each([
    ["a zone-less Date", "Date: Tue, 4 Nov 2026 23:30:00"],
    ["a Date with a five-digit year", "Date: Tue, 4 Nov 12345 23:30:00 +0000"],
    ["a 30 February Date", "Date: Fri, 30 Feb 2026 10:00:00 +0100"],
    ["no Date at all", undefined],
  ])("no Received date and %s fails, naming the file", async (_case, date) => {
    const lines = headers.filter(
      (line) => !line.startsWith("Received") && !line.startsWith("Date"),
    );
    const message = await failure(
      eml(...lines, ...(date ? [date] : []), "", "body"),
      "/mail/no-date.eml",
    );
    expect(message).toContain("/mail/no-date.eml: no Received or Date header with a valid");
  });

  test("no Message-ID fails, naming the file", async () => {
    const message = await failure(
      eml(...headers.filter((line) => !line.startsWith("Message-ID")), "", "body"),
      "/mail/no-id.eml",
    );
    expect(message).toContain("/mail/no-id.eml: no Message-ID");
  });

  test("bytes that are no mail fail as not an email, naming the file", async () => {
    const message = await failure(new Uint8Array([0, 159, 146, 150]), "/mail/garbage.eml");
    expect(message).toContain("/mail/garbage.eml: not an email");
  });

  test("an attached mail stays one attachment: its own attachments are not unpacked", async () => {
    const intake = await read(
      eml(
        ...headers,
        'Content-Type: multipart/mixed; boundary="o"',
        "",
        "--o",
        "Content-Type: text/plain",
        "",
        "Forwarded below.",
        "--o",
        "Content-Type: message/rfc822",
        "",
        "Message-ID: <inner@x>",
        "Subject: inner",
        'Content-Type: multipart/mixed; boundary="i"',
        "",
        "--i",
        "Content-Type: text/plain",
        "",
        "inner body",
        "--i",
        'Content-Type: application/pdf; name="inner.pdf"',
        'Content-Disposition: attachment; filename="inner.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        pdfBase64,
        "--i--",
        "--o--",
        "",
      ),
    );
    expect(intake.attachments).toEqual([expect.objectContaining({ mimeType: "message/rfc822" })]);
  });

  test("a Content-Type with case and parameters reads as its plain MIME type", async () => {
    const intake = await read(
      eml(
        ...headers,
        'Content-Type: multipart/mixed; boundary="c"',
        "",
        "--c",
        "Content-Type: Application/PDF; name=x",
        "Content-Disposition: attachment",
        "Content-Transfer-Encoding: base64",
        "",
        pdfBase64,
        "--c--",
        "",
      ),
    );
    expect(intake.attachments).toEqual([expect.objectContaining({ mimeType: "application/pdf" })]);
  });
});
