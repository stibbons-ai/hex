/**
 * The eval's verdicts, as deterministic Mastra scorers: detection and Document dates have exact
 * right answers (sets and calendar days), so no model judges them.
 */
import { createScorer } from "@mastra/core/evals";

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
  .generateScore(({ results }) =>
    ["true-positive", "true-negative"].includes(results.analyzeStepResult.verdict) ? 1 : 0,
  );

/**
 * What the eval got for one labelled Document: the Document date the model answered (`null`:
 * none), or no answer because the Document was not sent or the model call failed.
 */
export type Prediction =
  | { readonly status: "answered"; readonly predicted: string | null }
  | { readonly status: "not-sent" }
  | { readonly status: "failed"; readonly error: string };

/**
 * The predicted Document date as `YYYY-MM-DD` (`null`: no date), or undefined when the model call
 * failed: never correct, even for a Document labelled undated.
 */
function predictedDate(prediction: Prediction): string | null | undefined {
  if (prediction.status === "failed") return undefined;
  return prediction.status === "answered" ? prediction.predicted : null;
}

/**
 * A scorer of one labelled Document: `output` its {@link Prediction}, `groundTruth` its labelled
 * Document date (`YYYY-MM-DD`, `null` when it carries none). Scores 1 when the prediction's
 * `key` equals the label's, `null` (no date) matching only `null`.
 */
function documentDateScorer(id: string, description: string, key: (date: string) => string) {
  return createScorer<unknown, Prediction>({ id, description }).generateScore(({ run }) => {
    const predicted = predictedDate(run.output);
    if (predicted === undefined) return 0;
    const expected = run.groundTruth as string | null;
    return (predicted === null ? null : key(predicted)) ===
      (expected === null ? null : key(expected))
      ? 1
      : 0;
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
