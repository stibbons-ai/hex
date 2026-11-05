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
import type { IntakeAttachment } from "@hex/adapters";
import { detectDocuments, documentMediaType, safeFileName } from "@hex/domain";
import type { CalendarDate, DetectedDocument } from "@hex/domain";
import { Effect, Layer } from "effect";
import { loadExpectedSet } from "./expected.ts";
import type { ExpectedIntake } from "./expected.ts";
import { encodeReport, renderMarkdown, summarize } from "./report.ts";
import type { DocumentRow, IntakeRow, Prediction, Report } from "./report.ts";
import {
  documentDateExactScorer,
  documentDateMonthScorer,
  documentDetectionScorer,
} from "./scorers.ts";
import type { DetectionVerdict } from "./scorers.ts";

export interface EvalOptions {
  /** The fixture folder (`expected.json` and its `.eml` Intakes), absolute. */
  readonly fixtures: string;
  /** The model that reads Document dates, `provider/model`; names the run and the report. */
  readonly model: string;
  /** The DateExtractor on `model` (`dateExtractorLayer`; tests pass a scripted one). */
  readonly dateExtractor: Layer.Layer<DateExtractor>;
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

/**
 * What the model predicts for each labelled Document, as the workflow's `extract-dates` step
 * asks it: a Document whose content `documentMediaType` rejects is never sent; a failed model
 * call is recorded on its Document and the run goes on.
 */
function predict(intakes: readonly PreparedIntake[]) {
  return DateExtractor.use((extractor) =>
    Effect.forEach(intakes, ({ label, attachments, labelled }) =>
      Effect.forEach(label.documents, ({ fileName }, position): Effect.Effect<Prediction> => {
        const attachment = attachments[labelled[position]!]!;
        const content = Buffer.from(attachment.content, "base64");
        const mediaType = documentMediaType({ ...attachment, content });
        if (mediaType === undefined) return Effect.succeed({ status: "not-sent" });
        return extractor.extract({ content, mediaType, fileName }).pipe(
          Effect.map((answer): Prediction => {
            const date = documentDateOf(answer);
            return { status: "answered", predicted: date ? isoDate(date) : null };
          }),
          Effect.catchTag("DateExtractionError", ({ message }) =>
            Effect.succeed<Prediction>({ status: "failed", error: message }),
          ),
        );
      }),
    ),
  );
}

/** The verdicts on one Intake's attachments and labelled Documents, by the scorers. */
async function score(
  { label, detected, names, labelled }: PreparedIntake,
  predictions: readonly Prediction[],
): Promise<IntakeRow> {
  const detection: Record<DetectionVerdict, string[]> = {
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
    detection[analyzeStepResult!.verdict].push(names[index]!);
  }
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
  return {
    file: label.file,
    detection: {
      truePositives: detection["true-positive"],
      falsePositives: detection["false-positive"],
      falseNegatives: detection["false-negative"],
    },
    documents,
  };
}

/**
 * The run's own new folder under `root` (which exists): `<UTC time>_<model>`, suffixed `-2`,
 * `-3`… if taken.
 */
async function createRunFolder(root: string, startedAt: Date, model: string): Promise<string> {
  const id = `${startedAt.toISOString().replace(/[:.]/g, "-")}_${model.replace(/[^\w.-]+/g, "-")}`;
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
 * Runs the eval on `fixtures`: Document detection on every labelled Intake, then the Document
 * date of every labelled Document (ground truth, so detection errors don't reach extraction)
 * with `dateExtractor`, each verdict by a scorer. Writes `report.json` and `report.md` into a new
 * folder under `resultsRoot`, nothing elsewhere. Rejects on a fixture error before any model
 * call; a failed model call only marks its Document `failed`.
 */
export async function runEval({
  fixtures,
  model,
  dateExtractor,
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
  const predictions = await Effect.runPromise(predict(intakes).pipe(Effect.provide(dateExtractor)));
  const rows = await Promise.all(
    intakes.map((intake, position) => score(intake, predictions[position]!)),
  );
  const report: Report = {
    fixtures,
    model,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    ...summarize(rows),
    intakes: rows,
  };
  const folder = await createRunFolder(resultsRoot, startedAt, model);
  await writeFile(join(folder, "report.json"), encodeReport(report));
  await writeFile(join(folder, "report.md"), renderMarkdown(report));
  return { report, folder };
}
