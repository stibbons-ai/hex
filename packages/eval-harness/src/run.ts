import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DateExtractor,
  documentDateOf,
  isErrno,
  isWithin,
  messageOf,
  readEml,
} from "@hex/adapters";
import type { IntakeAttachment, TokenUsage } from "@hex/adapters";
import { detectDocuments, documentMediaType, safeFileName } from "@hex/domain";
import type { CalendarDate, DetectedDocument } from "@hex/domain";
import { Effect, Layer } from "effect";
import { loadExpectedSet } from "./expected.ts";
import type { ExpectedIntake } from "./expected.ts";
import { callCost, modelPrices } from "./prices.ts";
import type { ModelPrices, PriceData, Rates } from "./prices.ts";
import { encodeReport, ratio, renderMarkdown } from "./report.ts";
import type {
  DetectionRow,
  DocumentRow,
  IntakeRow,
  ModelReport,
  Prediction,
  Report,
  Tokens,
} from "./report.ts";
import {
  documentDateExactScorer,
  documentDateMonthScorer,
  documentDetectionScorer,
} from "./scorers.ts";
import type { DetectionVerdict } from "./scorers.ts";

export interface EvalOptions {
  /** The fixture folder (`expected.json` and its `.eml` Intakes), absolute. */
  readonly fixtures: string;
  /** The models that read Document dates, `provider/model`, in report order; at least one. */
  readonly models: readonly [string, ...string[]];
  /** The DateExtractor on a model (`dateExtractorLayer`; tests pass scripted ones). */
  readonly dateExtractor: (model: string) => Layer.Layer<DateExtractor>;
  /** LiteLLM's price data, fetched once for the run (`fetchPriceData`). */
  readonly prices: PriceData;
  /** The folder each run gets its own folder in, absolute; never inside `fixtures`. */
  readonly resultsRoot: string;
}

export interface EvalRun {
  readonly report: Report;
  /** The run's folder under the results root, holding `report.json` and `report.md`. */
  readonly folder: string;
}

/** One labelled Intake, read and detected, its labels matched to attachments. */
interface PreparedIntake {
  readonly label: ExpectedIntake;
  readonly attachments: readonly IntakeAttachment[];
  readonly detected: readonly DetectedDocument[];
  /** Per attachment: the name labels and the report give it (see {@link labelName}). */
  readonly names: readonly string[];
  /** Per labelled Document, in label order: the index of its attachment. */
  readonly labelled: readonly number[];
}

/** `YYYY-MM-DD`. */
const isoDate = ({ year, month, day }: CalendarDate) =>
  [year, month, day]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");

/**
 * The name a label gives an attachment: its original file name, or, when it has none, the name
 * hex files it under (`document-<position>.<ext>`, `safeFileName`).
 */
const labelName = ({ fileName, mimeType }: IntakeAttachment, index: number) =>
  fileName ?? safeFileName(undefined, mimeType, index + 1);

/**
 * Reads every labelled Intake and detects its Documents as the workflow's `detect-documents` step
 * does. Fails, before any model call, naming each `.eml` that can't be read and each label that
 * names no attachment (or more than one) of its mail by {@link labelName}.
 */
async function prepare(fixtures: string): Promise<PreparedIntake[]> {
  const { intakes } = await loadExpectedSet(fixtures);
  const problems: string[] = [];
  const prepared: PreparedIntake[] = [];
  for (const label of intakes) {
    const path = join(fixtures, label.file);
    const intake = await readFile(path)
      .then((bytes) => Effect.runPromise(readEml(bytes, path)))
      .catch((error: unknown) => {
        problems.push(messageOf(error));
        return undefined;
      });
    if (intake === undefined) continue;
    const { attachments, cidReferences } = intake;
    // As the workflow's detect-documents step: the size detection goes by is the content's.
    const facts = attachments.map(({ content, ...attachment }) => ({
      ...attachment,
      size: Buffer.byteLength(content, "base64"),
    }));
    const names = attachments.map(labelName);
    const labelled = label.documents.flatMap(({ fileName }) => {
      const matches = names.flatMap((name, index) => (name === fileName ? [index] : []));
      if (matches.length === 1) return matches;
      problems.push(
        `${path}: expected.json labels ${JSON.stringify(fileName)}, but the mail has ${matches.length === 0 ? "no attachment" : `${matches.length} attachments`} of that name`,
      );
      return [];
    });
    prepared.push({
      label,
      attachments,
      detected: detectDocuments(facts, cidReferences),
      names,
      labelled,
    });
  }
  if (problems.length > 0) throw new Error(`fixture errors:\n${problems.join("\n")}`);
  return prepared;
}

const tokensOf = ({
  inputTokens,
  outputTokens,
  cachedInputTokens,
  reasoningTokens,
}: TokenUsage) => ({
  input: inputTokens,
  output: outputTokens,
  cachedInput: cachedInputTokens ?? null,
  reasoning: reasoningTokens ?? null,
});

/**
 * What the model predicts for each labelled Document, as the workflow's `extract-dates` step
 * asks it: a Document whose content `documentMediaType` rejects is never sent; a failed model
 * call is recorded on its Document and the run goes on. One call at a time, each timed from
 * before the call to its answer or failure (retries included); priced at `rates` when the model
 * is priced and the call reported its tokens.
 */
function predict(intakes: readonly PreparedIntake[], rates: Rates | undefined) {
  return DateExtractor.use((extractor) =>
    Effect.forEach(intakes, ({ label, attachments, labelled }) =>
      Effect.forEach(label.documents, ({ fileName }, position): Effect.Effect<Prediction> => {
        const attachment = attachments[labelled[position]!]!;
        const content = Buffer.from(attachment.content, "base64");
        const mediaType = documentMediaType({ ...attachment, content });
        if (mediaType === undefined) return Effect.succeed({ status: "not-sent" });
        return Effect.suspend(() => {
          const start = performance.now();
          const elapsed = () => Math.round(performance.now() - start);
          return extractor.extract({ content, mediaType, fileName }).pipe(
            Effect.map(({ answer, usage }): Prediction => {
              const latencyMs = elapsed();
              const date = documentDateOf(answer);
              return {
                status: "answered",
                predicted: date ? isoDate(date) : null,
                latencyMs,
                tokens: usage ? tokensOf(usage) : null,
                costUsd: usage && rates ? callCost(rates, usage) : null,
              };
            }),
            Effect.catchTag("DateExtractionError", ({ message }) =>
              Effect.succeed<Prediction>({
                status: "failed",
                error: message,
                latencyMs: elapsed(),
              }),
            ),
          );
        });
      }),
    ),
  );
}

/** Detection's verdicts on one Intake's attachments, by the scorer. */
async function detectionRow({
  label,
  detected,
  names,
  labelled,
}: PreparedIntake): Promise<DetectionRow> {
  const verdicts: Record<DetectionVerdict, string[]> = {
    "true-positive": [],
    "false-positive": [],
    "false-negative": [],
    "true-negative": [],
  };
  for (const index of names.keys()) {
    const { analyzeStepResult } = await documentDetectionScorer.run({
      output: detected.some((document) => document.index === index),
      groundTruth: labelled.includes(index),
    });
    verdicts[analyzeStepResult!.verdict].push(names[index]!);
  }
  return {
    file: label.file,
    truePositives: verdicts["true-positive"],
    falsePositives: verdicts["false-positive"],
    falseNegatives: verdicts["false-negative"],
  };
}

/** The verdicts on one Intake's labelled Documents, by the scorers. */
async function intakeRow(
  { label }: PreparedIntake,
  predictions: readonly Prediction[],
): Promise<IntakeRow> {
  const documents: DocumentRow[] = [];
  for (const [position, { fileName, documentDate }] of label.documents.entries()) {
    const prediction = predictions[position]!;
    const run = { output: prediction, groundTruth: documentDate };
    const [exact, month] = await Promise.all([
      documentDateExactScorer.run(run),
      documentDateMonthScorer.run(run),
    ]);
    documents.push({
      fileName,
      expected: documentDate,
      exact: exact.score === 1,
      month: month.score === 1,
      ...prediction,
    });
  }
  return { file: label.file, documents };
}

/** The set-level detection figures of `rows`. */
function detectionSummary(rows: readonly DetectionRow[]): Report["detection"] {
  const truePositives = rows.flatMap((row) => row.truePositives).length;
  const falsePositives = rows.flatMap((row) => row.falsePositives).length;
  const falseNegatives = rows.flatMap((row) => row.falseNegatives).length;
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision: ratio(truePositives, truePositives + falsePositives),
    recall: ratio(truePositives, truePositives + falseNegatives),
    intakes: rows,
  };
}

/** The sum of `all`; a detail (cached, reasoning) is `null` when no call reported it. */
function sumTokens(all: readonly Tokens[]): Tokens | null {
  if (all.length === 0) return null;
  const detail = (pick: (tokens: Tokens) => number | null) => {
    const reported = all.flatMap((tokens) => (pick(tokens) === null ? [] : [pick(tokens)!]));
    return reported.length === 0 ? null : reported.reduce((sum, count) => sum + count, 0);
  };
  return {
    input: all.reduce((sum, { input }) => sum + input, 0),
    output: all.reduce((sum, { output }) => sum + output, 0),
    cachedInput: detail(({ cachedInput }) => cachedInput),
    reasoning: detail(({ reasoning }) => reasoning),
  };
}

/** The middle of `values` (the mean of the two middle ones for an even count); `null` if none. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** One evaluated model's figures from its `rows`. */
function modelReport(
  model: string,
  { entry, pdfInput, pricing }: ModelPrices,
  rows: readonly IntakeRow[],
): ModelReport {
  const documents = rows.flatMap((row) => row.documents);
  const counted = (keep: (row: DocumentRow) => boolean) => documents.filter(keep).length;
  const answered = documents.flatMap((row) => (row.status === "answered" ? [row] : []));
  const latencies = documents.flatMap((row) => (row.status === "not-sent" ? [] : [row.latencyMs]));
  const unreported = answered.filter(({ tokens }) => tokens === null).length;
  const cost: ModelReport["cost"] =
    pricing.status === "unpriced"
      ? { status: "unpriced", reason: pricing.reason }
      : answered.length === 0
        ? { status: "unpriced", reason: "no answered call" }
        : unreported > 0
          ? { status: "unpriced", reason: `${unreported} answered call(s) reported no token usage` }
          : { status: "priced", usd: answered.reduce((sum, { costUsd }) => sum + costUsd!, 0) };
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

/**
 * The run's own new folder under `root` (which exists): `<UTC time>_<model>` for one configured
 * model, `<UTC time>_matrix` for several, suffixed `-2`, `-3`… if taken.
 */
async function createRunFolder(
  root: string,
  startedAt: Date,
  models: readonly string[],
): Promise<string> {
  const name = models.length === 1 ? models[0]!.replace(/[^\w.-]+/g, "-") : "matrix";
  const id = `${startedAt.toISOString().replace(/[:.]/g, "-")}_${name}`;
  for (let attempt = 1; ; attempt++) {
    const folder = join(root, attempt === 1 ? id : `${id}-${attempt}`);
    try {
      await mkdir(folder);
      return folder;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
  }
}

/**
 * Runs the eval on `fixtures`: Document detection on every labelled Intake, once, then for each
 * model in turn the Document date of every labelled Document (ground truth, so detection errors
 * don't reach extraction), each verdict by a scorer. A model whose LiteLLM entry says it takes no
 * PDF input is excluded before any call. Writes `report.json` and `report.md` into a new folder
 * under `resultsRoot`, nothing elsewhere. Rejects on a fixture error before any model call; a
 * failed model call only marks its Document `failed`.
 */
export async function runEval({
  fixtures,
  models,
  dateExtractor,
  prices,
  resultsRoot,
}: EvalOptions): Promise<EvalRun> {
  if (isWithin(fixtures, resultsRoot)) {
    throw new Error(`the results folder ${resultsRoot} must not lie in the fixture folder`);
  }
  const startedAt = new Date();
  const intakes = await prepare(fixtures);
  // Before any paid model call: a results root that can't be a writable folder fails the run now.
  try {
    await mkdir(resultsRoot, { recursive: true });
    await access(resultsRoot, constants.W_OK);
  } catch (error) {
    throw new Error(`the results folder ${resultsRoot} can't be written to (${messageOf(error)})`, {
      cause: error,
    });
  }
  const detection = detectionSummary(await Promise.all(intakes.map(detectionRow)));
  const looked = models.map((model) => ({ model, prices: modelPrices(prices, model) }));
  const excluded = looked.flatMap(({ model, prices: { entry, pdfInput } }) =>
    pdfInput === false
      ? [{ model, reason: `no PDF input (LiteLLM entry ${entry}: supports_pdf_input false)` }]
      : [],
  );
  const evaluated: ModelReport[] = [];
  for (const { model, prices: found } of looked) {
    if (found.pdfInput === false) continue;
    const rates = found.pricing.status === "priced" ? found.pricing.rates : undefined;
    const predictions = await Effect.runPromise(
      predict(intakes, rates).pipe(Effect.provide(dateExtractor(model))),
    );
    const rows = await Promise.all(
      intakes.map((intake, position) => intakeRow(intake, predictions[position]!)),
    );
    evaluated.push(modelReport(model, found, rows));
  }
  const report: Report = {
    fixtures,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    prices: { url: prices.url, error: prices.status === "unavailable" ? prices.error : null },
    detection,
    models: evaluated,
    excluded,
  };
  const folder = await createRunFolder(resultsRoot, startedAt, models);
  await writeFile(join(folder, "report.json"), encodeReport(report));
  await writeFile(join(folder, "report.md"), renderMarkdown(report));
  return { report, folder };
}
