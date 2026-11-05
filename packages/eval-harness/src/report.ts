import { Schema } from "effect";
import type { ModelPrices } from "./prices.ts";

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

/** `$0.001234`: USD to six decimals, a millionth of a dollar. */
export const formatUsd = (usd: number) => `$${usd.toFixed(6)}`;

/** `120 ms`: milliseconds, rounded. */
export const formatMs = (ms: number) => `${Math.round(ms)} ms`;

/** The provider-reported tokens of one call, or their sum (see `TokenUsage`). */
export const Tokens = Schema.Struct({
  input: Schema.Int,
  output: Schema.Int,
  /** Of `input`, cached; `null` when the provider reported none. */
  cachedInput: Schema.NullOr(Schema.Int),
  /** Of `output`, reasoning; `null` when the provider reported none. */
  reasoning: Schema.NullOr(Schema.Int),
});
export type Tokens = typeof Tokens.Type;

const DocumentVerdicts = {
  fileName: Schema.String,
  /** The labelled Document date, `YYYY-MM-DD`; `null`: the Document carries none. */
  expected: Schema.NullOr(Schema.String),
  /**
   * Whether the prediction is the labelled day; for a `null` label, whether no date was predicted
   * (answered none, or not sent). Never for a failed call.
   */
  exact: Schema.Boolean,
  /** The same as `exact` for the labelled year and month. */
  month: Schema.Boolean,
};

/** Wall-clock time of the DateExtractor call, retries included, in milliseconds. */
const LatencyMs = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Answered: the Document date the model answered, `YYYY-MM-DD`; `null`: none (or no real day). */
const Answered = Schema.Struct({
  status: Schema.Literal("answered"),
  predicted: Schema.NullOr(Schema.String),
  latencyMs: LatencyMs,
  /** The call's tokens; `null` when the provider reported none. */
  tokens: Schema.NullOr(Tokens),
  /** The call's USD cost; `null` when the model is unpriced or the call reported no tokens. */
  costUsd: Schema.NullOr(Schema.Number),
});
/** Never sent to the model (`documentMediaType`): predicted no date. */
const NotSent = Schema.Struct({ status: Schema.Literal("not-sent") });
/** The model call failed: counts as incorrect. */
const Failed = Schema.Struct({
  status: Schema.Literal("failed"),
  error: Schema.String,
  latencyMs: LatencyMs,
});

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

/** Document detection on one Intake of the fixture folder. */
export const DetectionRow = Schema.Struct({
  /** The `.eml` file name. */
  file: Schema.String,
  /**
   * Attachments by detection verdict, each by the name a label gives it: its original file name,
   * or `document-<position>.<ext>` when it has none.
   */
  truePositives: Schema.Array(Schema.String),
  falsePositives: Schema.Array(Schema.String),
  falseNegatives: Schema.Array(Schema.String),
});
export type DetectionRow = typeof DetectionRow.Type;

/** One model's Documents of one Intake. */
export const IntakeRow = Schema.Struct({
  /** The `.eml` file name. */
  file: Schema.String,
  /** The labelled Documents, in label order. */
  documents: Schema.Array(DocumentRow),
});
export type IntakeRow = typeof IntakeRow.Type;

/** A cost figure, or why there is none. */
const Cost = Schema.Union([
  Schema.Struct({ status: Schema.Literal("priced"), usd: Schema.Number }),
  Schema.Struct({ status: Schema.Literal("unpriced"), reason: Schema.String }),
]);

/** Document date extraction by one model that was evaluated. */
export const ModelReport = Schema.Struct({
  /** `provider/model`. */
  model: Schema.String,
  /** LiteLLM's `supports_pdf_input` for the model: `true`, or `null` (unknown). */
  pdfInput: Schema.NullOr(Schema.Literal(true)),
  /**
   * The LiteLLM entry the model is priced and checked by, or, when its `litellm_provider` is
   * malformed, the entry it may be; `null` when none matched.
   */
  priceEntry: Schema.NullOr(Schema.String),
  extraction: Schema.Struct({
    /**
     * Labelled Documents whose predicted Document date is the labelled day; one labelled undated
     * counts when no date was predicted (answered none, or not sent); a failed call never counts.
     */
    exact: Ratio,
    /** The same as `exact` for the labelled year and month. */
    month: Ratio,
    notSent: Schema.Int,
    failed: Schema.Int,
  }),
  /** The tokens of the answered calls that reported them; `null` when none did. */
  tokens: Schema.NullOr(Tokens),
  /**
   * Total USD cost of the answered calls; unpriced when the model is, when no call answered, or
   * when an answered call reported no tokens. A failed call reports no tokens and is not counted.
   */
  cost: Cost,
  /** {@link cost} per answered call: what a Document costs; unpriced when `cost` is. */
  costPerDocument: Cost,
  /** Over every call made (answered or failed): their count, median and maximum milliseconds. */
  latency: Schema.Struct({
    calls: Schema.Int,
    /** `null` when no call was made. */
    medianMs: Schema.NullOr(Schema.Number),
    /** `null` when no call was made. */
    maxMs: Schema.NullOr(LatencyMs),
  }),
  intakes: Schema.Array(IntakeRow),
});
export type ModelReport = typeof ModelReport.Type;

/** One eval run: `report.json`, and what `report.md` renders. */
export const Report = Schema.Struct({
  /** The fixture folder, absolute. */
  fixtures: Schema.String,
  /** When the run started, ISO 8601 UTC. */
  startedAt: Schema.String,
  durationMs: Schema.Int,
  /** The LiteLLM price data, fetched once per run: its URL, and the error when it failed. */
  prices: Schema.Struct({ url: Schema.String, error: Schema.NullOr(Schema.String) }),
  /** Document detection, which no model takes part in: once per run. */
  detection: Schema.Struct({
    truePositives: Schema.Int,
    falsePositives: Schema.Int,
    falseNegatives: Schema.Int,
    /** True positives of the detected attachments. */
    precision: Ratio,
    /** True positives of the labelled Documents. */
    recall: Ratio,
    intakes: Schema.Array(DetectionRow),
  }),
  /** The evaluated models, in the configured order. */
  models: Schema.Array(ModelReport),
  /** Configured models left out before any call, with the reason. */
  excluded: Schema.Array(Schema.Struct({ model: Schema.String, reason: Schema.String })),
});
export type Report = typeof Report.Type;

/** The set-level detection figures of `rows`. */
export function detectionSummary(rows: readonly DetectionRow[]): Report["detection"] {
  const count = (pick: (row: DetectionRow) => readonly string[]) =>
    rows.reduce((sum, row) => sum + pick(row).length, 0);
  const truePositives = count((row) => row.truePositives);
  const falsePositives = count((row) => row.falsePositives);
  const falseNegatives = count((row) => row.falseNegatives);
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision: ratio(truePositives, truePositives + falsePositives),
    recall: ratio(truePositives, truePositives + falseNegatives),
    intakes: rows,
  };
}

/** The sum of `values`; `null` when all are (none was reported). */
function sumReported(values: readonly (number | null)[]): number | null {
  let sum: number | null = null;
  for (const value of values) if (value !== null) sum = (sum ?? 0) + value;
  return sum;
}

/** The sum of `all`; a detail (cached, reasoning) is `null` when no call reported it. */
function sumTokens(all: readonly Tokens[]): Tokens | null {
  if (all.length === 0) return null;
  return {
    input: all.reduce((sum, { input }) => sum + input, 0),
    output: all.reduce((sum, { output }) => sum + output, 0),
    cachedInput: sumReported(all.map(({ cachedInput }) => cachedInput)),
    reasoning: sumReported(all.map(({ reasoning }) => reasoning)),
  };
}

/** The middle of `values` (the mean of the two middle ones for an even count); `null` if none. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

type Answered = Extract<DocumentRow, { status: "answered" }>;

/**
 * The total cost of `answered`: unpriced when `pricing` is, when nothing answered, or when an
 * answered call reported no tokens (never a silent undercount).
 */
function totalCost(
  pricing: ModelPrices["pricing"],
  answered: readonly Answered[],
): ModelReport["cost"] {
  if (pricing.status === "unpriced") return { status: "unpriced", reason: pricing.reason };
  if (answered.length === 0) return { status: "unpriced", reason: "no answered call" };
  const unpriced = answered.filter(({ costUsd }) => costUsd === null).length;
  if (unpriced > 0) {
    return { status: "unpriced", reason: `${unpriced} answered call(s) reported no token usage` };
  }
  return { status: "priced", usd: answered.reduce((sum, { costUsd }) => sum + costUsd!, 0) };
}

/** One evaluated model's figures from its `rows`, priced as `prices` says. */
export function modelReport(
  model: string,
  { entry, pdfInput, pricing }: ModelPrices,
  rows: readonly IntakeRow[],
): ModelReport {
  const documents = rows.flatMap((row) => row.documents);
  const counted = (keep: (row: DocumentRow) => boolean) => documents.filter(keep).length;
  const answered = documents.filter((row): row is Answered => row.status === "answered");
  const latencies = documents.flatMap((row) => (row.status === "not-sent" ? [] : [row.latencyMs]));
  const cost = totalCost(pricing, answered);
  return {
    model,
    pdfInput: pdfInput === true ? true : null,
    priceEntry: entry,
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
    tokens: sumTokens(answered.flatMap(({ tokens }) => (tokens === null ? [] : [tokens]))),
    cost,
    costPerDocument:
      cost.status === "unpriced" ? cost : { status: "priced", usd: cost.usd / answered.length },
    latency: {
      calls: latencies.length,
      medianMs: median(latencies),
      maxMs: latencies.length === 0 ? null : Math.max(...latencies),
    },
    intakes: rows,
  };
}

/** `report` as `report.json`. */
export function encodeReport(report: Report): string {
  return `${JSON.stringify(Schema.encodeUnknownSync(Report)(report), null, 2)}\n`;
}

/** `text` safe inside a Markdown table cell: one line, pipes escaped. */
const cell = (text: string) => text.replace(/\s+/g, " ").replaceAll("|", "\\|");

/** A Markdown table row of `cells`, each already {@link cell}-safe. */
const row = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;

const names = (fileNames: readonly string[]) =>
  fileNames.length === 0 ? "none" : fileNames.map(cell).join(", ");

function predictedCell(row: DocumentRow): string {
  if (row.status === "not-sent") return "not sent";
  if (row.status === "failed") return `error: ${cell(row.error)}`;
  return row.predicted ?? "none";
}

const costCell = (cost: ModelReport["cost"]) =>
  cost.status === "priced" ? formatUsd(cost.usd) : "unpriced";

/** A model's total cost, saying when failed calls (which report no tokens) aren't in it. */
const totalCostCell = ({ cost, extraction: { failed } }: ModelReport) =>
  cost.status === "priced" && failed > 0
    ? `${formatUsd(cost.usd)} (${failed} failed call${failed === 1 ? "" : "s"} not counted)`
    : costCell(cost);

const msCell = (ms: number | null) => (ms === null ? "n/a" : formatMs(ms));

/** `1200 in (1024 cached), 80 out (64 reasoning)`. */
export function formatTokens({ input, output, cachedInput, reasoning }: Tokens): string {
  return [
    `${input} in${cachedInput === null ? "" : ` (${cachedInput} cached)`}`,
    `${output} out${reasoning === null ? "" : ` (${reasoning} reasoning)`}`,
  ].join(", ");
}

const tokensCell = (tokens: Tokens | null) =>
  tokens === null ? "not reported" : formatTokens(tokens);

const usdCell = (usd: number | null) => (usd === null ? "unpriced" : formatUsd(usd));

function documentLine(document: DocumentRow): string {
  const answered = document.status === "answered" ? document : undefined;
  return row([
    cell(document.fileName),
    document.expected ?? "none",
    predictedCell(document),
    document.exact ? "yes" : "no",
    document.month ? "yes" : "no",
    document.status === "not-sent" ? "n/a" : msCell(document.latencyMs),
    answered ? tokensCell(answered.tokens) : "n/a",
    answered ? usdCell(answered.costUsd) : "n/a",
  ]);
}

/** `report` as Markdown. */
export function renderMarkdown(report: Report): string {
  const { detection } = report;
  const lines = [
    "# hex eval report",
    "",
    `- Fixtures: ${report.fixtures}`,
    `- Started: ${report.startedAt}`,
    `- Duration: ${(report.durationMs / 1000).toFixed(1)} s`,
    `- Price data: ${report.prices.url}${report.prices.error === null ? "" : ` (unavailable: ${report.prices.error})`}`,
    "",
    "## Models",
    "",
    "| Model | Exact | Month | Failed | Total cost | Cost per Document | Latency median | Latency max | PDF input |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...report.models.map((model) =>
      row([
        cell(model.model),
        formatRatio(model.extraction.exact),
        formatRatio(model.extraction.month),
        String(model.extraction.failed),
        totalCostCell(model),
        costCell(model.costPerDocument),
        msCell(model.latency.medianMs),
        msCell(model.latency.maxMs),
        model.pdfInput ? "yes" : "PDF input unknown",
      ]),
    ),
  ];
  const unpriced = report.models.flatMap((model) =>
    model.cost.status === "unpriced" ? [`- ${model.model}: unpriced, ${model.cost.reason}`] : [],
  );
  if (unpriced.length > 0) lines.push("", ...unpriced);
  lines.push(
    "",
    "Excluded (no call made):",
    "",
    ...(report.excluded.length === 0
      ? ["- none"]
      : report.excluded.map(({ model, reason }) => `- ${model}: ${reason}`)),
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
  );
  for (const intake of detection.intakes) {
    lines.push(
      "",
      `### ${intake.file}`,
      "",
      `- Detected and labelled: ${names(intake.truePositives)}`,
      `- Detected, not labelled: ${names(intake.falsePositives)}`,
      `- Labelled, not detected: ${names(intake.falseNegatives)}`,
    );
  }
  for (const model of report.models) {
    const { extraction } = model;
    lines.push(
      "",
      `## Document dates by ${model.model}`,
      "",
      "| Metric | Value |",
      "| --- | --- |",
      `| Exact (year-month-day) | ${formatRatio(extraction.exact)} |`,
      `| Month (year-month) | ${formatRatio(extraction.month)} |`,
      `| Not sent | ${extraction.notSent} |`,
      `| Failed | ${extraction.failed} |`,
      `| Tokens | ${tokensCell(model.tokens)} |`,
      `| Total cost | ${model.cost.status === "priced" ? totalCostCell(model) : `unpriced (${cell(model.cost.reason)})`} |`,
      `| Cost per Document | ${costCell(model.costPerDocument)} |`,
      `| Price entry (LiteLLM) | ${model.priceEntry ?? "none"} |`,
      `| Latency median / max | ${msCell(model.latency.medianMs)} / ${msCell(model.latency.maxMs)} (${model.latency.calls} calls) |`,
    );
    for (const intake of model.intakes) {
      if (intake.documents.length === 0) continue;
      lines.push(
        "",
        `### ${intake.file} (${model.model})`,
        "",
        "| Document | Expected | Predicted | Exact | Month | Latency | Tokens | Cost |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        ...intake.documents.map(documentLine),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
