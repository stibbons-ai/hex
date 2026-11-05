import { join } from "node:path";
import { Schema } from "effect";

/** `YYYY-MM-DD` naming a real calendar day (`2026-02-30` fails). */
function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** Reports every value of `key` that occurs more than once in `items`. */
function unique<T>(key: (item: T) => string, label: string) {
  return Schema.makeFilter<ReadonlyArray<T>>((items) => {
    const seen = new Set<string>();
    const issues: Array<Schema.FilterIssue> = [];
    items.forEach((item, index) => {
      const value = key(item);
      if (seen.has(value)) issues.push({ path: [index], issue: `duplicate ${label} "${value}"` });
      seen.add(value);
    });
    return issues;
  });
}

export const DocumentDate = Schema.String.check(
  Schema.makeFilter((value: string) =>
    isCalendarDate(value) ? undefined : `expected a real calendar date YYYY-MM-DD, got "${value}"`,
  ),
);

/** One attachment of an Intake that is a Document, with the Document date printed on it. */
export const ExpectedDocument = Schema.Struct({
  fileName: Schema.NonEmptyString,
  /** `null`: the Document carries no date. */
  documentDate: Schema.NullOr(DocumentDate),
});

/** One `.eml` Intake of the set and the Documents it carries, in MIME order. */
export const ExpectedIntake = Schema.Struct({
  /** The `.eml` file name in the same folder as `expected.json`. */
  file: Schema.String.check(Schema.isPattern(/^[^/\\]+\.eml$/)),
  /** What the Intake covers, which trap it sets. */
  description: Schema.optionalKey(Schema.String),
  documents: Schema.Array(ExpectedDocument).check(
    unique((document: typeof ExpectedDocument.Type) => document.fileName, "fileName"),
  ),
});

/** The labels of one fixture folder: its `expected.json`. */
export const ExpectedSet = Schema.Struct({
  intakes: Schema.Array(ExpectedIntake).check(
    unique((intake: typeof ExpectedIntake.Type) => intake.file, "file"),
  ),
});

export type ExpectedDocument = typeof ExpectedDocument.Type;
export type ExpectedIntake = typeof ExpectedIntake.Type;
export type ExpectedSet = typeof ExpectedSet.Type;

export const decodeExpectedSet = Schema.decodeUnknownResult(ExpectedSet);

/** Reads and decodes `<folder>/expected.json`; rejects with the decode error when it is malformed. */
export async function loadExpectedSet(folder: string): Promise<ExpectedSet> {
  const json: unknown = await Bun.file(join(folder, "expected.json")).json();
  return Schema.decodeUnknownPromise(ExpectedSet)(json);
}
