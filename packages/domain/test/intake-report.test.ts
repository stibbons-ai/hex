import { describe, expect, test } from "bun:test";
import { renderIntakeReport } from "../src";
import type { IntakeReportInput, ReportConsequence } from "../src";

const intake = {
  messageId: "a1@shop.example",
  subject: "Rechnung Oktober",
  sender: "shop@example.com",
};
const processed = { status: "processed" } as const;

describe("renderIntakeReport", () => {
  test("processed: counts per folder in order, then the targets", () => {
    const report = renderIntakeReport({
      intake,
      filings: [
        { path: "2026-10/ER/a.pdf", fellBack: false },
        { path: "2026-09/ER/b.pdf", fellBack: false },
        { path: "2026-10/ER/c.pdf", fellBack: false },
        { path: "2026-10/ER/d.pdf", fellBack: false },
      ],
      forwardings: [
        { target: "sevdesk", earlier: false },
        { target: "paperless", earlier: true },
      ],
      outcome: processed,
    });
    expect(report).toBe(
      [
        "Intake processed: `Rechnung Oktober` from `shop@example.com`",
        "3 Documents filed under 2026-10/ER, 1 under 2026-09/ER",
        "Forwarded to sevdesk, paperless (earlier run)",
      ].join("\n"),
    );
  });

  test("date fallbacks are counted and each such file named", () => {
    const report = renderIntakeReport({
      intake,
      filings: [
        { path: "2026-10/ER/dated.pdf", fellBack: false },
        { path: "2026-11/ER/scan.pdf", fellBack: true },
        { path: "2026-11/ER/IMG 1.HEIC", fellBack: true },
      ],
      forwardings: [],
      outcome: processed,
    });
    expect(report).toBe(
      [
        "Intake processed: `Rechnung Oktober` from `shop@example.com`",
        "1 Document filed under 2026-10/ER, 2 under 2026-11/ER",
        "2 without a detected date, filed by received date: `scan.pdf`, `IMG 1.HEIC`",
      ].join("\n"),
    );
  });

  test("zero Documents: nothing filed", () => {
    expect(renderIntakeReport({ intake, filings: [], forwardings: [], outcome: processed })).toBe(
      "Intake processed: `Rechnung Oktober` from `shop@example.com`\nNo Documents; nothing filed.",
    );
  });

  test.each([
    ["no subject: by its sender", { sender: "shop@example.com" }, "from `shop@example.com`"],
    ["no sender: by its subject", { subject: "Beleg" }, "`Beleg`"],
    ["neither: by its Message-ID", {}, "`a1@shop.example`"],
    [
      "a blank subject counts as none",
      { subject: " \r\n ", sender: undefined },
      "`a1@shop.example`",
    ],
  ])("identifies the Intake: %s", (_case, fields, identity) => {
    const report = renderIntakeReport({
      intake: { messageId: "a1@shop.example", ...fields },
      filings: [],
      forwardings: [],
      outcome: processed,
    });
    expect(report.split("\n")[0]).toBe(`Intake processed: ${identity}`);
  });

  const failed = (consequence: ReportConsequence): IntakeReportInput => ({
    intake,
    filings: [{ path: "2026-11/ER/a.pdf", fellBack: true }],
    forwardings: [{ target: "paperless", earlier: false }],
    outcome: {
      status: "failed",
      failures: [
        { branch: "forwarding to sevdesk", reason: "sending to x@sevdesk.example failed: 451" },
        { branch: "filing", reason: "disk full" },
      ],
      consequence,
    },
  });
  const failedHead = [
    "Intake FAILED: `Rechnung Oktober` from `shop@example.com`",
    "Failed: forwarding to sevdesk: `sending to x@sevdesk.example failed: 451`",
    "Failed: filing: `disk full`",
    "Done nonetheless:",
    "1 Document filed under 2026-11/ER",
    "1 without a detected date, filed by received date: `a.pdf`",
    "Forwarded to paperless",
  ];

  test.each<[string, ReportConsequence, string]>([
    [
      "with runs left: retried later",
      { status: "retry", failedRuns: 2, maxFailedRuns: 5, retryInMinutes: 10 },
      "Failed run 2 of 5: hex tries again in 10 min at the earliest.",
    ],
    [
      "permanently: its mail to hex/failed",
      { status: "failed-permanently", failedRuns: 5, maxFailedRuns: 5, mail: { status: "moved" } },
      "Failed run 5 of 5: failed permanently, its mail was moved to hex/failed.",
    ],
    [
      "permanently, its mail not in the folder",
      {
        status: "failed-permanently",
        failedRuns: 5,
        maxFailedRuns: 5,
        mail: { status: "not-in-mailbox" },
      },
      "Failed run 5 of 5: failed permanently, no mail of it was in the watched folder.",
    ],
    [
      "permanently, its move failed",
      {
        status: "failed-permanently",
        failedRuns: 5,
        maxFailedRuns: 5,
        mail: { status: "not-moved", reason: "connection lost" },
      },
      "Failed run 5 of 5: failed permanently, moving its mail to hex/failed failed (`connection lost`); see the hex log.",
    ],
    [
      "uncounted",
      { status: "uncounted", reason: "database is locked" },
      "Counting the failed run failed (`database is locked`); see the hex log.",
    ],
  ])(
    "a failed run %s: each failure, what was done, the consequence",
    (_case, consequence, last) => {
      expect(renderIntakeReport(failed(consequence))).toBe([...failedHead, last].join("\n"));
    },
  );

  test("a failed run that did nothing says so", () => {
    const report = renderIntakeReport({
      ...failed({ status: "retry", failedRuns: 1, maxFailedRuns: 5, retryInMinutes: 5 }),
      filings: [],
      forwardings: [],
    });
    expect(report.split("\n")).toContain("Nothing filed or forwarded.");
    expect(report).not.toContain("Done nonetheless");
  });

  test("untrusted text stays inside one code span on one line, cut when long", () => {
    const report = renderIntakeReport({
      intake: {
        messageId: "x@y",
        subject: "Hi `<!channel>` @here\nhttps://evil.example \u202Efdp.exe",
        sender: "a".repeat(300),
      },
      filings: [{ path: "2026-11/ER/x`y.pdf", fellBack: true }],
      forwardings: [],
      outcome: processed,
    });
    const [head, , fallback] = report.split("\n");
    expect(head).toBe(
      `Intake processed: \`Hi '<!channel>' @here https://evil.example fdp.exe\` from \`${"a".repeat(199)}…\``,
    );
    expect(fallback).toBe("1 without a detected date, filed by received date: `x'y.pdf`");
  });

  test("zero-width, bidi mark and byte order mark characters are flattened like line breaks", () => {
    const report = renderIntakeReport({
      intake: {
        messageId: "only-invisible@shop.example",
        subject: "\u200B\uFEFF\u200E",
        sender: "bill\u200Bing\u200F@\u061Cshop.example\uFEFF",
      },
      filings: [],
      forwardings: [],
      outcome: processed,
    });
    expect(report.split("\n")[0]).toBe("Intake processed: from `bill ing @ shop.example`");
  });
});
