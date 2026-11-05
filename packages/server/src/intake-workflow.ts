import {
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
import { FILING_TIME_ZONE, calendarDateIn, detectDocuments, planFiling } from "@hex/domain";
import type { Category } from "@hex/domain";
import { Mastra } from "@mastra/core/mastra";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
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
const Documents = Schema.Struct({
  /** The Documents among the Intake's attachments: their index and the name to file under. */
  documents: Schema.Array(Schema.Struct({ index: Schema.Int, fileName: Schema.String })),
});
const Filed = Schema.Struct({ filings: Schema.Array(Filing) });

type IntakeServices = Outbox | IntakeLedger;

/** The services the workflow's steps run on, in one shared runtime (ADR 0002). */
export type IntakeRuntime = ManagedRuntime.ManagedRuntime<IntakeServices, LedgerError>;

/**
 * The runtime on the real Outbox and ledger. Built on first use; `dispose()` closes the ledger's
 * connection.
 */
export function createIntakeRuntime(paths: DataPaths): IntakeRuntime {
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
      return Schema.decodeUnknownPromise(Documents)({
        documents: detectDocuments(attachments, cidReferences),
      });
    },
  });

  const file = createStep({
    id: "file-documents",
    inputSchema: toMastraSchema(Documents),
    outputSchema: toMastraSchema(Filed),
    execute: ({ inputData, getInitData }) => {
      const { attachments, receivedAt } = getInitData<Intake>();
      const received = calendarDateIn(new Date(receivedAt), FILING_TIME_ZONE);
      // No Document date yet (#7): every Document falls back to the received date.
      const { folder } = planFiling(undefined, received, category);
      return run(
        Filed,
        Outbox.use((outbox) =>
          Effect.forEach(inputData.documents, ({ index, fileName }) =>
            outbox.file(folder, fileName, Buffer.from(attachments[index]!.content, "base64")),
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
    .then(detect)
    .then(file)
    .then(record)
    .commit();
}

/**
 * Runs the Intake workflow once, in process, on `intake` against the data at `paths`, with its
 * own Mastra (persisting the run in `mastra.db`) and runtime, closed again afterwards. Throws when
 * the run does not succeed.
 */
export async function runIntake(
  intake: Intake,
  { paths, category }: { paths: DataPaths; category: Category },
): Promise<IntakeResult> {
  const storage = await createLocalStore(paths.databasePath);
  const runtime = createIntakeRuntime(paths);
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
    await closeInOrder([() => mastra.shutdown(), () => storage.close(), () => runtime.dispose()]);
  }
}
