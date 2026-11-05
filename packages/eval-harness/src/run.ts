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
import type { DocumentFile, IntakeAttachment, TokenUsage } from "@hex/adapters";
import { detectDocuments, documentMediaType, safeFileName } from "@hex/domain";
import type { CalendarDate, DetectedDocument } from "@hex/domain";
import { Effect, Layer } from "effect";
import { loadExpectedSet } from "./expected.ts";
import type { ExpectedIntake } from "./expected.ts";
import { callCost, modelPrices } from "./prices.ts";
import type { PriceData, Rates } from "./prices.ts";
import { detectionSummary, encodeReport, modelReport, renderMarkdown } from "./report.ts";
import type {
  DetectionRow,
  DocumentRow,
  IntakeRow,
  ModelReport,
  Prediction,
  Report,
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
  readonly detected: readonly DetectedDocument[];
  /** Per attachment: the name labels and the report give it (see {@link labelName}). */
  readonly names: readonly string[];
  /** Per labelled Document, in label order: the index of its attachment. */
  readonly labelled: readonly number[];
  /**
   * Per labelled Document, in label order: what goes to the model, or undefined when its content
   * `documentMediaType` rejects (never sent).
   */
  readonly sendable: readonly (Omit<DocumentFile, "fileName"> | undefined)[];
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
    const sendable = labelled.map((index) => {
      const attachment = attachments[index]!;
      const content = Buffer.from(attachment.content, "base64");
      const mediaType = documentMediaType({ ...attachment, content });
      return mediaType === undefined ? undefined : { content, mediaType };
    });
    prepared.push({
      label,
      detected: detectDocuments(facts, cidReferences),
      names,
      labelled,
      sendable,
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
    Effect.forEach(intakes, ({ label, sendable }) =>
      Effect.forEach(label.documents, ({ fileName }, position): Effect.Effect<Prediction> => {
        const document = sendable[position];
        if (document === undefined) return Effect.succeed({ status: "not-sent" });
        return Effect.suspend(() => {
          const start = performance.now();
          const elapsed = () => Math.round(performance.now() - start);
          return extractor.extract({ ...document, fileName }).pipe(
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
  const excluded: Report["excluded"][number][] = [];
  const evaluated: ModelReport[] = [];
  for (const model of models) {
    const found = modelPrices(prices, model);
    if (found.pdfInput === false) {
      const reason = `no PDF input (LiteLLM entry ${found.entry}: supports_pdf_input false)`;
      excluded.push({ model, reason });
      continue;
    }
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
