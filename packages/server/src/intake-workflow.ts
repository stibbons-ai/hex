import {
  DateExtractor,
  DocumentDateAnswer,
  Filing,
  Intake,
  IntakeLedger,
  Outbox,
  createLocalStore,
  intakeLedgerLayer,
  outboxLayer,
  toMastraSchema,
} from "@hex/adapters";
import type { LedgerError } from "@hex/adapters";
import {
  FILING_TIME_ZONE,
  calendarDateIn,
  detectDocuments,
  documentMediaType,
  normalizeMessageId,
  planFiling,
} from "@hex/domain";
import type { Category } from "@hex/domain";
import { Mastra } from "@mastra/core/mastra";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { closeInOrder } from "./close";
import type { DataPaths } from "./paths";

export const INTAKE_WORKFLOW_ID = "intake";

/** What the Intake workflow did with one Intake. */
export const IntakeResult = Schema.Struct({
  messageId: Schema.String,
  /** `already-processed`: the ledger had it, so nothing was filed this time. */
  status: Schema.Literals(["processed", "already-processed"]),
  /** One Filing per Document: this run's, or the earlier run's when already processed. */
  filings: Schema.Array(Filing),
});
export type IntakeResult = typeof IntakeResult.Type;

const Unprocessed = Schema.Struct({ messageId: Schema.String });
/** A Document among the Intake's attachments: its index and the name to file it under. */
const DetectedDocument = Schema.Struct({ index: Schema.Int, fileName: Schema.String });
const Documents = Schema.Struct({ documents: Schema.Array(DetectedDocument) });
/** A Document date as the model answered it: whole numbers, not yet checked to be a real day. */
const AnsweredDate = Schema.Struct({ year: Schema.Int, month: Schema.Int, day: Schema.Int });
const Dated = Schema.Struct({
  /** The Documents, each with the Document date the model answered, if it answered one. */
  documents: Schema.Array(
    Schema.Struct({ ...DetectedDocument.fields, documentDate: Schema.optionalKey(AnsweredDate) }),
  ),
});
const Filed = Schema.Struct({ filings: Schema.Array(Filing) });

/**
 * The Document date in a model's answer: present only when the answer decodes as
 * {@link DocumentDateAnswer} with no `null`. Anything else (no date found, malformed) is none.
 */
function documentDateOf(answer: unknown): { documentDate?: typeof AnsweredDate.Type } {
  const decoded = Schema.decodeUnknownOption(DocumentDateAnswer)(answer);
  if (Option.isNone(decoded)) return {};
  const { year, month, day } = decoded.value;
  if (year === null || month === null || day === null) return {};
  return { documentDate: { year, month, day } };
}

type IntakeServices = Outbox | IntakeLedger | DateExtractor;

/** The services the workflow's steps run on, in one shared runtime (ADR 0002). */
export type IntakeRuntime = ManagedRuntime.ManagedRuntime<IntakeServices, LedgerError>;

/**
 * The runtime on the real Outbox and ledger, and `dateExtractor` (`dateExtractorLayer` on the
 * configured model; tests pass a scripted one). Built on first use; `dispose()` closes the
 * ledger's connection.
 */
export function createIntakeRuntime(
  paths: DataPaths,
  dateExtractor: Layer.Layer<DateExtractor>,
): IntakeRuntime {
  return ManagedRuntime.make(
    Layer.mergeAll(
      outboxLayer(paths.outboxDirectory),
      intakeLedgerLayer(paths.databasePath),
      dateExtractor,
    ),
  );
}

export interface IntakeWorkflowOptions {
  runtime: IntakeRuntime;
  /** The Category every Document is filed under. */
  category: Category;
}

/**
 * The Intake workflow: ledger check (an Intake already processed ends the run, nothing filed) →
 * Document detection → reading each Document's Document date with the DateExtractor → Filing of
 * each Document into the Outbox under `YYYY-MM/<Category>/` by its Document date, or by the
 * received date (in {@link FILING_TIME_ZONE}) when no usable one came back, flagged `fellBack` →
 * recording the Intake in the ledger. A failed model call fails the run before anything is filed
 * or recorded, so a re-run retries it. An Intake without Documents is recorded too, with no
 * Filings. Each step decodes its own output.
 */
export function createIntakeWorkflow({ runtime, category }: IntakeWorkflowOptions) {
  /** Runs `program` on the services, then decodes its result as the step's output. */
  const run = <A, I>(
    schema: Schema.Codec<A, I>,
    program: Effect.Effect<unknown, unknown, IntakeServices>,
  ) => runtime.runPromise(program.pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema))));

  const checkLedger = createStep({
    id: "check-ledger",
    inputSchema: toMastraSchema(Intake),
    outputSchema: toMastraSchema(Unprocessed),
    execute: async ({ inputData, bail }) => {
      const { messageId } = inputData;
      const earlier = await run(
        Schema.UndefinedOr(IntakeResult),
        IntakeLedger.use((ledger) => ledger.find(messageId)).pipe(
          Effect.map(
            (entry) =>
              entry && {
                messageId: entry.messageId,
                status: "already-processed",
                filings: entry.filings,
              },
          ),
        ),
      );
      if (earlier) return bail<IntakeResult>(earlier);
      return Schema.decodeUnknownPromise(Unprocessed)({ messageId });
    },
  });

  const detect = createStep({
    id: "detect-documents",
    inputSchema: toMastraSchema(Unprocessed),
    outputSchema: toMastraSchema(Documents),
    execute: ({ getInitData }) => {
      const { attachments, cidReferences } = getInitData<Intake>();
      // The size detection goes by is the content's, never a claimed one.
      const facts = attachments.map(({ content, ...attachment }) => ({
        ...attachment,
        size: Buffer.byteLength(content, "base64"),
      }));
      return Schema.decodeUnknownPromise(Documents)({
        documents: detectDocuments(facts, cidReferences),
      });
    },
  });

  const extract = createStep({
    id: "extract-dates",
    inputSchema: toMastraSchema(Documents),
    outputSchema: toMastraSchema(Dated),
    execute: ({ inputData, getInitData }) => {
      const { attachments } = getInitData<Intake>();
      return run(
        Dated,
        DateExtractor.use((extractor) =>
          Effect.forEach(inputData.documents, (document) => {
            const attachment = attachments[document.index]!;
            const mediaType = documentMediaType(attachment);
            // A type models don't take is never sent: it has no Document date.
            if (mediaType === undefined) return Effect.succeed(document);
            return extractor
              .extract({
                content: Buffer.from(attachment.content, "base64"),
                mediaType,
                fileName: document.fileName,
              })
              .pipe(Effect.map((answer) => ({ ...document, ...documentDateOf(answer) })));
          }),
        ).pipe(Effect.map((documents) => ({ documents }))),
      );
    },
  });

  const file = createStep({
    id: "file-documents",
    inputSchema: toMastraSchema(Dated),
    outputSchema: toMastraSchema(Filed),
    execute: ({ inputData, getInitData }) => {
      const { attachments, receivedAt } = getInitData<Intake>();
      const received = calendarDateIn(new Date(receivedAt), FILING_TIME_ZONE);
      return run(
        Filed,
        Outbox.use((outbox) =>
          Effect.forEach(inputData.documents, ({ index, fileName, documentDate }) => {
            const { folder, fellBack } = planFiling(documentDate, received, category);
            return outbox
              .file(folder, fileName, Buffer.from(attachments[index]!.content, "base64"))
              .pipe(Effect.map((path) => ({ index, path, fellBack })));
          }),
        ).pipe(Effect.map((filings) => ({ filings }))),
      );
    },
  });

  const record = createStep({
    id: "record",
    inputSchema: toMastraSchema(Filed),
    outputSchema: toMastraSchema(IntakeResult),
    execute: ({ inputData, getInitData }) => {
      const messageId = normalizeMessageId(getInitData<Intake>().messageId);
      const { filings } = inputData;
      return run(
        IntakeResult,
        IntakeLedger.use((ledger) => ledger.record(messageId, filings)).pipe(
          Effect.as({ messageId, status: "processed", filings }),
        ),
      );
    },
  });

  return createWorkflow({
    id: INTAKE_WORKFLOW_ID,
    inputSchema: toMastraSchema(Intake),
    outputSchema: toMastraSchema(IntakeResult),
    options: { validateInputs: true },
  })
    .then(checkLedger)
    .then(detect)
    .then(extract)
    .then(file)
    .then(record)
    .commit();
}

/**
 * Runs the Intake workflow once, in process, on `intake` against the data at `paths`, with its
 * own Mastra (persisting the run in `mastra.db`) and runtime on `dateExtractor`, closed again
 * afterwards. Throws when the run does not succeed. A failure to close is logged and never
 * replaces the run's outcome.
 */
export async function runIntake(
  intake: Intake,
  {
    paths,
    category,
    dateExtractor,
  }: { paths: DataPaths; category: Category; dateExtractor: Layer.Layer<DateExtractor> },
): Promise<IntakeResult> {
  const storage = await createLocalStore(paths.databasePath);
  const runtime = createIntakeRuntime(paths, dateExtractor);
  const mastra = new Mastra({
    storage,
    logger: false,
    workflows: { [INTAKE_WORKFLOW_ID]: createIntakeWorkflow({ runtime, category }) },
  });
  try {
    await storage.init();
    const run = await mastra.getWorkflow(INTAKE_WORKFLOW_ID).createRun();
    const result = await run.start({ inputData: intake });
    if (result.status !== "success") {
      const reason = result.status === "failed" ? result.error.message : result.status;
      throw new Error(`the Intake workflow did not finish: ${reason}`);
    }
    return result.result;
  } finally {
    await closeInOrder([
      () => mastra.shutdown(),
      () => storage.close(),
      () => runtime.dispose(),
    ]).catch((error: unknown) => {
      console.error("hex: closing after the Intake run failed", error);
    });
  }
}
