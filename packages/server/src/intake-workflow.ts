import {
  Filing,
  Intake,
  IntakeLedger,
  Outbox,
  intakeLedgerLayer,
  outboxLayer,
  toMastraSchema,
} from "@hex/adapters";
import type { LedgerError } from "@hex/adapters";
import {
  FILING_TIME_ZONE,
  calendarDateIn,
  isDocument,
  normalizeContentId,
  planFiling,
  safeFileName,
} from "@hex/domain";
import type { Category } from "@hex/domain";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";

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
const Documents = Schema.Struct({
  /** The Documents among the Intake's attachments: their position and the name to file under. */
  documents: Schema.Array(Schema.Struct({ attachment: Schema.Int, fileName: Schema.String })),
});
const Filed = Schema.Struct({ filings: Schema.Array(Filing) });

/** The services the workflow's steps run on, in one shared runtime (ADR 0002). */
export type IntakeRuntime = ManagedRuntime.ManagedRuntime<Outbox | IntakeLedger, LedgerError>;

/**
 * The runtime on the real Outbox and ledger. Built on first use; `dispose()` closes the ledger's
 * connection.
 */
export function createIntakeRuntime(paths: {
  databasePath: string;
  outboxDirectory: string;
}): IntakeRuntime {
  return ManagedRuntime.make(
    Layer.mergeAll(outboxLayer(paths.outboxDirectory), intakeLedgerLayer(paths.databasePath)),
  );
}

export interface IntakeWorkflowOptions {
  runtime: IntakeRuntime;
  /** The Category every Document is filed under. */
  category: Category;
}

/**
 * The Intake workflow: ledger check (an Intake already processed ends the run, nothing filed) →
 * Document detection → Filing of each Document into the Outbox under `YYYY-MM/<Category>/` by
 * the received date (in {@link FILING_TIME_ZONE}) → recording the Intake in the ledger. An Intake
 * without Documents is recorded too, with no Filings. Each step decodes its own output.
 */
export function createIntakeWorkflow({ runtime, category }: IntakeWorkflowOptions) {
  const run = <A, I>(
    schema: Schema.Codec<A, I>,
    program: Effect.Effect<unknown, unknown, Outbox | IntakeLedger>,
  ) => runtime.runPromise(program.pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema))));

  const checkLedger = createStep({
    id: "check-ledger",
    inputSchema: toMastraSchema(Intake),
    outputSchema: toMastraSchema(Unprocessed),
    execute: async ({ inputData, bail }) => {
      const earlier = await run(
        Schema.UndefinedOr(IntakeResult),
        IntakeLedger.use((ledger) => ledger.find(inputData.messageId)).pipe(
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
      return run(Unprocessed, Effect.succeed({ messageId: inputData.messageId }));
    },
  });

  const detectDocuments = createStep({
    id: "detect-documents",
    inputSchema: toMastraSchema(Unprocessed),
    outputSchema: toMastraSchema(Documents),
    execute: ({ getInitData }) => {
      const intake = getInitData<Intake>();
      const references = new Set(intake.cidReferences);
      const documents = intake.attachments.flatMap((attachment, index) => {
        const referencedByCid =
          attachment.contentId !== undefined &&
          references.has(normalizeContentId(attachment.contentId));
        if (!isDocument({ ...attachment, referencedByCid })) return [];
        const fileName = safeFileName(attachment.fileName, attachment.mimeType, index + 1);
        return [{ attachment: index, fileName }];
      });
      return run(Documents, Effect.succeed({ documents }));
    },
  });

  const fileDocuments = createStep({
    id: "file-documents",
    inputSchema: toMastraSchema(Documents),
    outputSchema: toMastraSchema(Filed),
    execute: ({ inputData, getInitData }) => {
      const intake = getInitData<Intake>();
      const received = calendarDateIn(new Date(intake.receivedAt), FILING_TIME_ZONE);
      // No Document date yet (#7): every Document falls back to the received date.
      const { folder } = planFiling(undefined, received, category);
      return run(
        Filed,
        Outbox.use((outbox) =>
          Effect.forEach(inputData.documents, ({ attachment, fileName }) =>
            outbox.file(
              folder,
              fileName,
              Buffer.from(intake.attachments[attachment]!.content, "base64"),
            ),
          ),
        ).pipe(Effect.map((paths) => ({ filings: paths.map((path) => ({ path })) }))),
      );
    },
  });

  const record = createStep({
    id: "record",
    inputSchema: toMastraSchema(Filed),
    outputSchema: toMastraSchema(IntakeResult),
    execute: ({ inputData, getInitData }) => {
      const { messageId } = getInitData<Intake>();
      const { filings } = inputData;
      return run(
        IntakeResult,
        IntakeLedger.use((ledger) =>
          ledger.record(messageId, { documentCount: filings.length, filings }),
        ).pipe(Effect.as({ messageId, status: "processed", filings })),
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
    .then(detectDocuments)
    .then(fileDocuments)
    .then(record)
    .commit();
}
