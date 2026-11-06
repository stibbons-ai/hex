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
      "permanently, its mail not found by its Message-ID",
      {
        status: "failed-permanently",
        failedRuns: 5,
        maxFailedRuns: 5,
        mail: { status: "not-in-mailbox" },
      },
      "Failed run 5 of 5: failed permanently, its mail was not found by its Message-ID in the watched folder; see the hex log.",
    ],
    [
      "at the limit only with failed runs counted in memory: failing permanently at the next look",
      { status: "failing-permanently", failedRuns: 5, maxFailedRuns: 5 },
      "Failed run 5 of 5: hex fails it permanently at its next look of the mailbox, its mail going to hex/failed then.",
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
      "Recording the failed run failed (`database is locked`); see the hex log.",
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

  test("earlier runs' work that can't be read is said so, never told as nothing done", () => {
    const unreadable = "Intake ledger: database is locked";
    const nothing = renderIntakeReport({
      ...failed({ status: "retry", failedRuns: 2, maxFailedRuns: 5, retryInMinutes: 10 }),
      filings: [],
      forwardings: [],
      earlierRunsUnreadable: unreadable,
    }).split("\n");
    expect(nothing).not.toContain("Nothing filed or forwarded.");
    expect(nothing.slice(-2)).toEqual([
      "This run filed and forwarded nothing; earlier runs' Filings and Forwardings could not be read (`Intake ledger: database is locked`), so they are not listed.",
      "Failed run 2 of 5: hex tries again in 10 min at the earliest.",
    ]);
    const some = renderIntakeReport({
      ...failed({ status: "retry", failedRuns: 2, maxFailedRuns: 5, retryInMinutes: 10 }),
      earlierRunsUnreadable: unreadable,
    }).split("\n");
    expect(some.slice(-2)).toEqual([
      "Earlier runs' Filings and Forwardings could not be read (`Intake ledger: database is locked`), so they are not listed.",
      "Failed run 2 of 5: hex tries again in 10 min at the earliest.",
    ]);
  });

  test("a Document written but not recorded is told as done, by its folder and quoted name", () => {
    const report = renderIntakeReport({
      ...failed({ status: "retry", failedRuns: 1, maxFailedRuns: 5, retryInMinutes: 5 }),
      filings: [],
      forwardings: [],
      unrecordedFilings: [{ path: "2026-10/ER/Rechnung.pdf", fellBack: false }],
    }).split("\n");
    expect(report).not.toContain("Nothing filed or forwarded.");
    expect(report.slice(-3, -1)).toEqual([
      "Done nonetheless:",
      "Filed, but recording it failed, so running this Intake again files it again: 2026-10/ER/`Rechnung.pdf`",
    ]);
  });

  test("a bulk Intake's report stays short: lists are bounded, the consequence comes last", () => {
    // 230 Documents without a date, each with a long name, across 23 folders of 10.
    const filings = Array.from({ length: 230 }, (_, n) => ({
      path: `2026-${String((n % 23) + 1).padStart(2, "0")}/ER/${"x".repeat(180)}-${n}.pdf`,
      fellBack: true,
    }));
    const consequence = "Failed run 1 of 5: hex tries again in 5 min at the earliest.";
    const report = renderIntakeReport({
      ...failed({ status: "retry", failedRuns: 1, maxFailedRuns: 5, retryInMinutes: 5 }),
      filings,
    });
    expect(report.length).toBeLessThan(4_000);
    const lines = report.split("\n");
    expect(lines.at(-1)).toBe(consequence);
    // The first 10 folders, 10 each; the other 13 folders' 130 counted.
    expect(lines[4]).toBe(
      [
        "10 Documents filed under 2026-01/ER",
        ...Array.from(
          { length: 9 },
          (_, n) => `10 under 2026-${String(n + 2).padStart(2, "0")}/ER`,
        ),
        "and 130 more in 13 folders",
      ].join(", "),
    );
    expect(lines[5]).toStartWith("230 without a detected date, filed by received date: `xxx");
    expect(lines[5]).toEndWith("-9.pdf`, and 220 more");
    expect(lines[5]!.match(/`/g)).toHaveLength(20);
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
