import { Schema } from "effect";

/** `count` of `total`; `value` is `count / total`, `null` (not applicable) when `total` is 0. */
export const Ratio = Schema.Struct({
  count: Schema.Int,
  total: Schema.Int,
  value: Schema.NullOr(Schema.Number),
});
export type Ratio = typeof Ratio.Type;

function ratio(count: number, total: number): Ratio {
  return { count, total, value: total === 0 ? null : count / total };
}

/** `11/13 (84.6 %)`, or `0/0 (n/a)`. */
export function formatRatio({ count, total, value }: Ratio): string {
  return `${count}/${total} (${value === null ? "n/a" : `${(value * 100).toFixed(1)} %`})`;
}

const DocumentVerdicts = {
  fileName: Schema.String,
  /** The labelled Document date, `YYYY-MM-DD`; `null`: the Document carries none. */
  expected: Schema.NullOr(Schema.String),
  /** Whether the prediction is the labelled day. */
  exact: Schema.Boolean,
  /** Whether the prediction lies in the labelled month. */
  month: Schema.Boolean,
};

/** Answered: the Document date the model answered, `YYYY-MM-DD`; `null`: none (or no real day). */
const Answered = Schema.Struct({
  status: Schema.Literal("answered"),
  predicted: Schema.NullOr(Schema.String),
});
/** Never sent to the model (`documentMediaType`): predicted no date. */
const NotSent = Schema.Struct({ status: Schema.Literal("not-sent") });
/** The model call failed: counts as incorrect. */
const Failed = Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String });

/** What the eval got for one labelled Document. */
export const Prediction = Schema.Union([Answered, NotSent, Failed]);
export type Prediction = typeof Prediction.Type;

/** One labelled Document: its {@link Prediction} and the verdicts. */
export const DocumentRow = Schema.Union([
  Schema.Struct({ ...DocumentVerdicts, ...Answered.fields }),
  Schema.Struct({ ...DocumentVerdicts, ...NotSent.fields }),
  Schema.Struct({ ...DocumentVerdicts, ...Failed.fields }),
]);
export type DocumentRow = typeof DocumentRow.Type;

/** One Intake of the fixture folder. */
export const IntakeRow = Schema.Struct({
  /** The `.eml` file name. */
  file: Schema.String,
  /** Attachment file names by detection verdict. */
  detection: Schema.Struct({
    truePositives: Schema.Array(Schema.String),
    falsePositives: Schema.Array(Schema.String),
    falseNegatives: Schema.Array(Schema.String),
  }),
  /** The labelled Documents, in label order. */
  documents: Schema.Array(DocumentRow),
});
export type IntakeRow = typeof IntakeRow.Type;

/** One eval run: `report.json`, and what `report.md` renders. */
export const Report = Schema.Struct({
  /** The fixture folder, absolute. */
  fixtures: Schema.String,
  /** The model that read the Document dates, `provider/model`. */
  model: Schema.String,
  /** When the run started, ISO 8601 UTC. */
  startedAt: Schema.String,
  durationMs: Schema.Int,
  detection: Schema.Struct({
    truePositives: Schema.Int,
    falsePositives: Schema.Int,
    falseNegatives: Schema.Int,
    /** True positives of the detected attachments. */
    precision: Ratio,
    /** True positives of the labelled Documents. */
    recall: Ratio,
  }),
  extraction: Schema.Struct({
    /** Labelled Documents whose predicted Document date is the labelled day. */
    exact: Ratio,
    /** Labelled Documents whose predicted Document date lies in the labelled month. */
    month: Ratio,
    notSent: Schema.Int,
    failed: Schema.Int,
  }),
  intakes: Schema.Array(IntakeRow),
});
export type Report = typeof Report.Type;

/** The set-level figures of `intakes`. */
export function summarize(intakes: readonly IntakeRow[]): Pick<Report, "detection" | "extraction"> {
  const truePositives = intakes.flatMap((row) => row.detection.truePositives).length;
  const falsePositives = intakes.flatMap((row) => row.detection.falsePositives).length;
  const falseNegatives = intakes.flatMap((row) => row.detection.falseNegatives).length;
  const documents = intakes.flatMap((row) => row.documents);
  const counted = (keep: (row: DocumentRow) => boolean) => documents.filter(keep).length;
  return {
    detection: {
      truePositives,
      falsePositives,
      falseNegatives,
      precision: ratio(truePositives, truePositives + falsePositives),
      recall: ratio(truePositives, truePositives + falseNegatives),
    },
    extraction: {
      exact: ratio(
        counted((row) => row.exact),
        documents.length,
      ),
      month: ratio(
        counted((row) => row.month),
        documents.length,
      ),
      notSent: counted((row) => row.status === "not-sent"),
      failed: counted((row) => row.status === "failed"),
    },
  };
}

/** `report` as `report.json`. */
export function encodeReport(report: Report): string {
  return `${JSON.stringify(Schema.encodeUnknownSync(Report)(report), null, 2)}\n`;
}

/** `text` safe inside a Markdown table cell: one line, pipes escaped. */
const cell = (text: string) => text.replace(/\s+/g, " ").replaceAll("|", "\\|");

const names = (fileNames: readonly string[]) =>
  fileNames.length === 0 ? "none" : fileNames.map(cell).join(", ");

function predictedCell(row: DocumentRow): string {
  if (row.status === "not-sent") return "not sent";
  if (row.status === "failed") return `error: ${cell(row.error)}`;
  return row.predicted ?? "none";
}

/** `report` as Markdown. */
export function renderMarkdown(report: Report): string {
  const { detection, extraction } = report;
  const lines = [
    "# hex eval report",
    "",
    `- Fixtures: ${report.fixtures}`,
    `- Model: ${report.model}`,
    `- Started: ${report.startedAt}`,
    `- Duration: ${(report.durationMs / 1000).toFixed(1)} s`,
    "",
    "## Document detection",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Precision | ${formatRatio(detection.precision)} |`,
    `| Recall | ${formatRatio(detection.recall)} |`,
    `| True positives | ${detection.truePositives} |`,
    `| False positives | ${detection.falsePositives} |`,
    `| False negatives | ${detection.falseNegatives} |`,
    "",
    "## Document date extraction",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Exact (year-month-day) | ${formatRatio(extraction.exact)} |`,
    `| Month (year-month) | ${formatRatio(extraction.month)} |`,
    `| Not sent | ${extraction.notSent} |`,
    `| Failed | ${extraction.failed} |`,
    "",
    "## Per Intake",
  ];
  for (const intake of report.intakes) {
    lines.push(
      "",
      `### ${intake.file}`,
      "",
      `- Detected and labelled: ${names(intake.detection.truePositives)}`,
      `- Detected, not labelled: ${names(intake.detection.falsePositives)}`,
      `- Labelled, not detected: ${names(intake.detection.falseNegatives)}`,
    );
    if (intake.documents.length === 0) continue;
    lines.push(
      "",
      "| Document | Expected | Predicted | Exact | Month |",
      "| --- | --- | --- | --- | --- |",
      ...intake.documents.map(
        (row) =>
          `| ${cell(row.fileName)} | ${row.expected ?? "none"} | ${predictedCell(row)} | ${row.exact ? "yes" : "no"} | ${row.month ? "yes" : "no"} |`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}
