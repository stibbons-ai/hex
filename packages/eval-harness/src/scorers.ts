/**
 * The eval's verdicts, as deterministic Mastra scorers: detection and Document dates have exact
 * right answers (sets and calendar days), so no model judges them.
 */
import { createScorer } from "@mastra/core/evals";
import type { Prediction } from "./report.ts";

/** How detection and the labels compare on one attachment. */
export type DetectionVerdict =
  | "true-positive"
  | "false-positive"
  | "false-negative"
  | "true-negative";

/**
 * One attachment: `output` whether detection found it a Document, `groundTruth` whether
 * `expected.json` labels it one. Scores 1 when they agree; its analysis names the verdict.
 */
export const documentDetectionScorer = createScorer<unknown, boolean>({
  id: "document-detection",
  description: "Whether Document detection agrees with the label on one attachment",
})
  .analyze(({ run }): { verdict: DetectionVerdict } => {
    const labelled = run.groundTruth === true;
    if (run.output) return { verdict: labelled ? "true-positive" : "false-positive" };
    return { verdict: labelled ? "false-negative" : "true-negative" };
  })
  .generateScore(({ results }) => (results.analyzeStepResult.verdict.startsWith("true-") ? 1 : 0));

/**
 * A scorer of one labelled Document: `output` its {@link Prediction}, `groundTruth` its labelled
 * Document date (`YYYY-MM-DD`, `null` when it carries none). Scores 1 when the predicted date's
 * `key` equals the label's, no date (not answered or not sent) matching only `null`; a failed
 * model call is never correct, even for a Document labelled undated.
 */
function documentDateScorer(id: string, description: string, key: (date: string) => string) {
  const keyOf = (date: string | null) => (date === null ? null : key(date));
  return createScorer<unknown, Prediction>({ id, description }).generateScore(({ run }) => {
    const prediction = run.output;
    if (prediction.status === "failed") return 0;
    const predicted = prediction.status === "answered" ? prediction.predicted : null;
    return keyOf(predicted) === keyOf(run.groundTruth as string | null) ? 1 : 0;
  });
}

/** 1 when the predicted Document date is the labelled day. */
export const documentDateExactScorer = documentDateScorer(
  "document-date-exact",
  "Whether the predicted Document date is the labelled year, month and day",
  (date) => date,
);

/** 1 when the predicted Document date lies in the labelled month. */
export const documentDateMonthScorer = documentDateScorer(
  "document-date-month",
  "Whether the predicted Document date lies in the labelled year and month",
  (date) => date.slice(0, 7),
);
