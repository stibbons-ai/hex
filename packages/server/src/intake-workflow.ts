import {
  DateExtractor,
  Filing,
  Intake,
  IntakeLedger,
  Mailbox,
  Mailer,
  MailerError,
  Outbox,
  createLocalStore,
  documentDateOf,
  intakeLedgerLayer,
  outboxLayer,
  toMastraSchema,
} from "@hex/adapters";
import type { LedgerError, MailboxError, OutgoingMail } from "@hex/adapters";
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
import { Effect, Layer, ManagedRuntime, Option, Schedule, Schema } from "effect";
import { closeInOrder } from "./close";
import type { DataPaths } from "./paths";
import {
  ProcessedMailFate,
  describeFailedRun,
  mailFateOf,
  moveMail,
  recordFailedRun,
} from "./mail-fate";
import type { FailedRunMailFate } from "./mail-fate";

/** The data the Intake workflow works on: the ledger's LibSQL file and the Outbox. */
type IntakePaths = Pick<DataPaths, "databasePath" | "outboxDirectory">;

export const INTAKE_WORKFLOW_ID = "intake";

/** One target Forwarding hands an Intake's Documents to: its name (the ledger's key) and address. */
interface ForwardingTarget {
  readonly name: string;
  readonly to: string;
}

/** Where the workflow forwards each Intake's Documents: the sender address and the targets that are on. */
export interface IntakeForwarding {
  readonly from: string;
  readonly targets: readonly ForwardingTarget[];
}

/** One target's Forwarding of an Intake: sent by this run, or by an earlier one. */
const ForwardingOutcome = Schema.Struct({
  target: Schema.String,
  status: Schema.Literals(["forwarded", "forwarded-earlier"]),
});

/** What the Intake workflow did with one Intake, before its mail was moved. */
const IntakeOutcome = Schema.Struct({
  messageId: Schema.String,
  /** `already-processed`: the ledger had it, so nothing was filed or forwarded this time. */
  status: Schema.Literals(["processed", "already-processed"]),
  /** One Filing per Document: this run's or an earlier run's. */
  filings: Schema.Array(Filing),
  /** One per target the Documents went to, by this run or an earlier one. */
  forwardings: Schema.Array(ForwardingOutcome),
});

/** What the Intake workflow did with one Intake, and with its mail. */
export const IntakeResult = Schema.Struct({ ...IntakeOutcome.fields, mail: ProcessedMailFate });
export type IntakeResult = typeof IntakeResult.Type;

/**
 * This run's attempt at one target: as in the result, failed (nothing sent), or sent but not
 * recorded (the server accepted the mail, the ledger kept failing), so running the Intake again
 * sends it again.
 */
const ForwardingAttempt = Schema.Union([
  ForwardingOutcome,
  Schema.Struct({
    target: Schema.String,
    status: Schema.Literals(["failed", "sent-unrecorded"]),
    reason: Schema.String,
  }),
]);
export type ForwardingAttempt = typeof ForwardingAttempt.Type;

const Unprocessed = Schema.Struct({ messageId: Schema.String });
/** A Document among the Intake's attachments: its index and the name to file it under. */
const DetectedDocument = Schema.Struct({ index: Schema.Int, fileName: Schema.String });
const Documents = Schema.Struct({ documents: Schema.Array(DetectedDocument) });
const Forwarded = Schema.Struct({ forwardings: Schema.Array(ForwardingAttempt) });
/** A Document date as the model answered it, a real day (`documentDateOf`). */
const AnsweredDate = Schema.Struct({ year: Schema.Int, month: Schema.Int, day: Schema.Int });
const Dated = Schema.Union([
  Schema.Struct({
    /**
     * The Documents not filed yet, each with the Document date the model answered, if it
     * answered a real one.
     */
    documents: Schema.Array(
      Schema.Struct({ ...DetectedDocument.fields, documentDate: Schema.optionalKey(AnsweredDate) }),
    ),
  }),
  /** Why date extraction failed, failing the Filing branch before anything is filed. */
  Schema.Struct({ failure: Schema.String }),
]);
/** A Filing made by this run: unlike a ledger entry's, it always says whether it fell back. */
const RunFiling = Schema.Struct({ ...Filing.fields, fellBack: Schema.Boolean });
export type RunFiling = typeof RunFiling.Type;
/**
 * This run's Filings, each in the ledger as soon as it was made, and, when the Filing branch
 * failed, why (the Filings made before the failure stay).
 */
const Filed = Schema.Struct({
  filings: Schema.Array(RunFiling),
  failure: Schema.optionalKey(Schema.String),
});
/** The Intake recorded as processed, or why the run failed (each failed branch). */
const Recorded = Schema.Union([IntakeOutcome, Schema.Struct({ failure: Schema.String })]);

type IntakeServices = Outbox | IntakeLedger | DateExtractor | Mailer | Mailbox;

/** The services the workflow's steps run on, in one shared runtime (ADR 0002). */
export type IntakeRuntime = ManagedRuntime.ManagedRuntime<
  IntakeServices,
  LedgerError | MailboxError
>;

/** The Mailer when Forwarding is off: every send fails, saying so. */
const mailerOff = Layer.succeed(Mailer, {
  send: ({ to }) =>
    Effect.fail(
      new MailerError({ message: `sending to ${to}: Forwarding is off (no SMTP settings)` }),
    ),
});

/**
 * The Mailbox without a mailbox (the dev command, Studio): no mail is ever in it, so nothing is
 * moved.
 */
const noMailbox = Layer.succeed(Mailbox, {
  folder: "(no mailbox)",
  list: Effect.succeed([]),
  source: () => Effect.succeed(undefined),
  waitForChange: () => Effect.never,
  moveMessageId: () => Effect.succeed(0),
  moveUid: () => Effect.succeed(false),
  close: Effect.void,
});

/** The services an Intake runtime is built from, beside the Outbox at its path. */
export interface IntakeServiceLayers {
  /** `dateExtractorLayer` on the configured model; tests pass a scripted one. */
  dateExtractor: Layer.Layer<DateExtractor>;
  /** `smtpMailerLayer` when Forwarding is on; tests pass a recording one. Off when absent. */
  mailer?: Layer.Layer<Mailer> | undefined;
  /** The Intake ledger in `paths.databasePath` when absent; tests may wrap it to fail. */
  ledger?: Layer.Layer<IntakeLedger, LedgerError> | undefined;
  /** `imapMailboxLayer` when the mailbox is watched; tests pass an in-memory one. None when absent. */
  mailbox?: Layer.Layer<Mailbox, MailboxError> | undefined;
}

/**
 * The runtime on the real Outbox and `services`. Built on first use; `dispose()` closes the
 * ledger's and the mailbox's connections.
 */
export function createIntakeRuntime(
  paths: IntakePaths,
  { dateExtractor, mailer = mailerOff, ledger, mailbox = noMailbox }: IntakeServiceLayers,
): IntakeRuntime {
  return ManagedRuntime.make(
    Layer.mergeAll(
      outboxLayer(paths.outboxDirectory),
      ledger ?? intakeLedgerLayer(paths.databasePath),
      dateExtractor,
      mailer,
      mailbox,
    ),
  );
}

export interface IntakeWorkflowOptions {
  runtime: IntakeRuntime;
  /** The Category every Document is filed under. */
  category: Category;
  /** Absent or without targets: Forwarding is off. */
  forwarding?: IntakeForwarding | undefined;
}

/** The subject of a forwarded mail when the Intake had none. */
const FALLBACK_SUBJECT = "Documents forwarded by hex";

/** The content of the Intake's attachment at `index`, decoded. */
const contentOf = (intake: Intake, index: number) =>
  Buffer.from(intake.attachments[index]!.content, "base64");

/**
 * The mail that forwards `documents` of `intake`, without its sender and recipient. Each
 * attachment goes as the type its content shows when hex recognises it (a PDF declared
 * `application/octet-stream` goes as `application/pdf`), else as declared; bytes and file name
 * unchanged.
 */
function forwardingMail(
  intake: Intake,
  messageId: string,
  documents: readonly (typeof DetectedDocument.Type)[],
): Omit<OutgoingMail, "from" | "to"> {
  const { subject, sender, attachments } = intake;
  return {
    // A header: no control characters, so no line break can end it early.
    subject: subject?.replace(/\p{Cc}+/gu, " ").trim() || FALLBACK_SUBJECT,
    text: `Forwarded by hex: the Documents of the mail ${messageId}${sender ? ` from ${sender}` : ""}, attached unchanged.\n`,
    attachments: documents.map(({ index, fileName }) => {
      const attachment = attachments[index]!;
      const content = contentOf(intake, index);
      return {
        fileName,
        contentType: documentMediaType({ ...attachment, content }) ?? attachment.mimeType,
        content,
      };
    }),
  };
}

/** How a successful send's Forwarding is recorded when the ledger fails: 3 attempts in all. */
const RECORD_RETRY = { schedule: Schedule.exponential("100 millis"), times: 2 };

/** The forward step's id: {@link runIntake} reads its output after a failed run. */
const FORWARD_STEP_ID = "forward-documents";
/** The file step's id: {@link runIntake} reads its output after a failed run. */
const FILE_STEP_ID = "file-documents";

/**
 * The Intake workflow: ledger check (an Intake already processed ends the run, nothing filed or
 * forwarded, its mail moved to `hex/processed`) → Document detection → Forwarding of the
 * Documents to each target that is on, one mail per target → reading each Document's Document
 * date with the DateExtractor → Filing of each Document into the Outbox under
 * `YYYY-MM/<Category>/` by its Document date, or by the received date (in
 * {@link FILING_TIME_ZONE}) when no usable one came back, flagged `fellBack` → recording the
 * Intake in the ledger → moving its mail: every copy in the watched folder with its Message-ID to
 * `hex/processed`, or, for a failed run, recording the failure ({@link recordFailedRun}: on the
 * 5th the Intake fails permanently, its mail going to `hex/failed`). No copy in the folder moves nothing;
 * a move that fails is reported in the result, the outcome standing.
 *
 * Forwarding per target and Filing (date extraction, then Filing) are branches: each is attempted
 * on every run even when another failed, and recorded in the ledger as it succeeds (a Forwarding
 * right after its send, retried briefly when the ledger fails; a Filing per Document). A target or
 * Document recorded by an earlier run is skipped: running a failed Intake again repeats only the
 * branches that failed. A send the server accepted but the ledger couldn't record fails its
 * branch as `sent-unrecorded`: running the Intake again sends it again. The run fails, naming each
 * failed branch and what happened to the mail, when any failed; the Intake is recorded as
 * processed only when all succeeded.
 * Only a ledger that can't be read, or an unexpected defect, ends the run before every branch was
 * attempted. An unreadable ledger ends it before anything is sent; a defect may come after earlier
 * targets were sent to, and the failed run's {@link IntakeRunError} then lists no Forwardings
 * (the ledger has those that were recorded). A failed model call fails the Filing branch before
 * any of its Documents is filed. An Intake without Documents forwards nothing and is recorded with
 * no Filings. Every ledger call takes the Intake's
 * Message-ID as given (the ledger normalises it). Each step decodes its own output.
 */
export function createIntakeWorkflow({ runtime, category, forwarding }: IntakeWorkflowOptions) {
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
          Effect.flatMap((entry) =>
            entry
              ? moveMail(messageId, "processed").pipe(
                  Effect.map((mail) => ({
                    messageId: entry.messageId,
                    status: "already-processed",
                    filings: entry.filings,
                    forwardings: entry.forwardings.map(({ target }) => ({
                      target,
                      status: "forwarded-earlier",
                    })),
                    mail,
                  })),
                )
              : Effect.succeed(undefined),
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

  const forward = createStep({
    id: FORWARD_STEP_ID,
    inputSchema: toMastraSchema(Documents),
    outputSchema: toMastraSchema(Forwarded),
    execute: ({ inputData: { documents }, getInitData }) => {
      if (!forwarding || documents.length === 0) {
        return Schema.decodeUnknownPromise(Forwarded)({ forwardings: [] });
      }
      const { from, targets } = forwarding;
      const intake = getInitData<Intake>();
      const { messageId } = intake;
      return run(
        Forwarded,
        Effect.gen(function* () {
          const ledger = yield* IntakeLedger;
          const mailer = yield* Mailer;
          const earlier = new Set(
            (yield* ledger.branches(messageId)).forwardings.map(({ target }) => target),
          );
          // Built (the Documents decoded) only when some target still needs it.
          const mail = targets.some(({ name }) => !earlier.has(name))
            ? forwardingMail(intake, normalizeMessageId(messageId), documents)
            : undefined;
          const forwardings = yield* Effect.forEach(targets, ({ name, to }) =>
            !mail || earlier.has(name)
              ? Effect.succeed({ target: name, status: "forwarded-earlier" })
              : mailer.send({ ...mail, from, to }).pipe(
                  Effect.matchEffect({
                    onFailure: ({ message }) =>
                      Effect.succeed({ target: name, status: "failed", reason: message }),
                    // Sent: a record that keeps failing must not read as "nothing sent".
                    onSuccess: () =>
                      ledger.recordForwarding(messageId, name).pipe(
                        Effect.retry(RECORD_RETRY),
                        Effect.match({
                          onSuccess: () => ({ target: name, status: "forwarded" }),
                          onFailure: ({ message }) => ({
                            target: name,
                            status: "sent-unrecorded",
                            reason: message,
                          }),
                        }),
                      ),
                  }),
                ),
          );
          return { forwardings };
        }),
      );
    },
  });

  const extract = createStep({
    id: "extract-dates",
    inputSchema: toMastraSchema(Forwarded),
    outputSchema: toMastraSchema(Dated),
    execute: ({ getStepResult, getInitData }) => {
      const intake = getInitData<Intake>();
      const { documents } = getStepResult(detect);
      return run(
        Dated,
        Effect.gen(function* () {
          const ledger = yield* IntakeLedger;
          const extractor = yield* DateExtractor;
          // Documents filed by an earlier run are neither read again nor filed again.
          const filed = new Set(
            (yield* ledger.branches(intake.messageId)).filings.map(({ index }) => index),
          );
          const unfiled = documents.filter(({ index }) => !filed.has(index));
          return yield* Effect.forEach(unfiled, (document) => {
            const attachment = intake.attachments[document.index]!;
            const content = contentOf(intake, document.index);
            const mediaType = documentMediaType({ ...attachment, content });
            // Never sent (no Document date) when its content is no valid PDF or image (Mastra
            // would send a placeholder instead) or OpenAI and Anthropic refuse its image type.
            if (mediaType === undefined) return Effect.succeed(document);
            return extractor.extract({ content, mediaType, fileName: document.fileName }).pipe(
              Effect.map(({ answer }) => {
                const documentDate = documentDateOf(answer);
                return documentDate ? { ...document, documentDate } : document;
              }),
            );
          }).pipe(
            Effect.match({
              onSuccess: (dated) => ({ documents: dated }),
              onFailure: ({ message }) => ({ failure: message }),
            }),
          );
        }),
      );
    },
  });

  const file = createStep({
    id: FILE_STEP_ID,
    inputSchema: toMastraSchema(Dated),
    outputSchema: toMastraSchema(Filed),
    execute: ({ inputData, getInitData }) => {
      if ("failure" in inputData) {
        return Schema.decodeUnknownPromise(Filed)({ filings: [], failure: inputData.failure });
      }
      const intake = getInitData<Intake>();
      const received = calendarDateIn(new Date(intake.receivedAt), FILING_TIME_ZONE);
      return run(
        Filed,
        Effect.gen(function* () {
          const ledger = yield* IntakeLedger;
          const outbox = yield* Outbox;
          // This run's Filings, also those made before a failure.
          const filings: RunFiling[] = [];
          return yield* Effect.forEach(
            inputData.documents,
            ({ index, fileName, documentDate }) => {
              const { folder, fellBack } = planFiling(documentDate, received, category);
              return outbox.file(folder, fileName, contentOf(intake, index)).pipe(
                Effect.map((path) => ({ index, path, fellBack })),
                Effect.tap((filing) => ledger.recordFiling(intake.messageId, filing)),
                Effect.map((filing) => filings.push(filing)),
              );
            },
            { discard: true },
          ).pipe(
            Effect.match({
              onSuccess: () => ({ filings }),
              onFailure: ({ message }) => ({ filings, failure: message }),
            }),
          );
        }),
      );
    },
  });

  const record = createStep({
    id: "record",
    inputSchema: toMastraSchema(Filed),
    outputSchema: toMastraSchema(Recorded),
    execute: async ({ inputData, getStepResult, getInitData }) => {
      const rawMessageId = getInitData<Intake>().messageId;
      const attempts = getStepResult(forward).forwardings;
      const failures = [
        ...attempts.flatMap((attempt) => {
          switch (attempt.status) {
            case "failed":
              return [`forwarding to ${attempt.target}: ${attempt.reason}`];
            case "sent-unrecorded":
              return [
                `forwarding to ${attempt.target}: sent, but recording it failed (${attempt.reason}); running this Intake again sends it again`,
              ];
            default:
              return [];
          }
        }),
        ...(inputData.failure === undefined ? [] : [`filing: ${inputData.failure}`]),
      ];
      if (failures.length > 0) {
        return Schema.decodeUnknownPromise(Recorded)({ failure: failures.join("; ") });
      }
      return run(
        Recorded,
        Effect.gen(function* () {
          const ledger = yield* IntakeLedger;
          // Every branch as recorded, this run's and earlier runs'.
          const { filings, forwardings } = yield* ledger.branches(rawMessageId);
          yield* ledger.record(rawMessageId, filings);
          // This run's targets in configured order, then any other recorded one (e.g. a target
          // disabled since an earlier run forwarded to it).
          const attempted = new Set(attempts.map(({ target }) => target));
          return {
            messageId: normalizeMessageId(rawMessageId),
            status: "processed",
            filings,
            forwardings: [
              ...attempts,
              ...forwardings
                .filter(({ target }) => !attempted.has(target))
                .map(({ target }) => ({ target, status: "forwarded-earlier" })),
            ],
          };
        }),
      );
    },
  });

  const move = createStep({
    // The IMAP move is the workflow's last step, so a run resumed after a restart moves its mail too.
    id: "move-mail",
    inputSchema: toMastraSchema(Recorded),
    outputSchema: toMastraSchema(IntakeResult),
    execute: async ({ inputData, getInitData, runId }) => {
      const { messageId } = getInitData<Intake>();
      if ("failure" in inputData) {
        // The failure stays the run's error even when the ledger can't count it.
        const consequence = await runtime.runPromise(
          recordFailedRun(messageId, runId).pipe(
            Effect.map((failed) => ({
              text: describeFailedRun(failed, { retryPending: true }),
              mail: failed.mail,
            })),
            Effect.catchTag("LedgerError", ({ message }) =>
              Effect.succeed({
                text: `counting the failed run failed: ${message}`,
                mail: undefined,
              }),
            ),
          ),
        );
        throw Object.assign(new Error(`${inputData.failure}; ${consequence.text}`), {
          mail: consequence.mail,
        });
      }
      return run(
        IntakeResult,
        moveMail(messageId, "processed").pipe(Effect.map((mail) => ({ ...inputData, mail }))),
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
    .then(forward)
    .then(extract)
    .then(file)
    .then(record)
    .then(move)
    .commit();
}

/**
 * The Intake workflow did not finish. Carries this run's Forwarding attempts and Filings, so a
 * caller can show what was done although a branch failed, and what happened to the mail, unless
 * the run ended before it got there (an unreadable ledger, a defect) or the ledger couldn't count
 * or end the failed runs there.
 */
export class IntakeRunError extends Error {
  constructor(
    message: string,
    readonly forwardings: readonly ForwardingAttempt[],
    readonly filings: readonly RunFiling[],
    readonly mail: FailedRunMailFate | undefined,
  ) {
    super(message);
  }
}

/** The output of a step in `steps` decoded as `schema`, if the step succeeded with one. */
function stepOutput<A, I>(
  steps: Record<string, { status: string; output?: unknown }>,
  id: string,
  schema: Schema.Codec<A, I>,
): A | undefined {
  const step = steps[id];
  return step?.status === "success"
    ? Option.getOrUndefined(Schema.decodeUnknownOption(schema)(step.output))
    : undefined;
}

/**
 * Runs the Intake workflow once, in process, on `intake` against the data at `paths`, with its
 * own Mastra (persisting the run in `mastra.db`) and runtime (see {@link createIntakeRuntime}),
 * closed again afterwards. Throws an {@link IntakeRunError} when the run does not succeed. A
 * failure to close is logged and never replaces the run's outcome.
 */
export async function runIntake(
  intake: Intake,
  {
    paths,
    category,
    forwarding,
    ...services
  }: IntakeServiceLayers & {
    paths: IntakePaths;
    category: Category;
    forwarding?: IntakeForwarding | undefined;
  },
): Promise<IntakeResult> {
  const storage = await createLocalStore(paths.databasePath);
  const runtime = createIntakeRuntime(paths, services);
  const mastra = new Mastra({
    storage,
    logger: false,
    workflows: { [INTAKE_WORKFLOW_ID]: createIntakeWorkflow({ runtime, category, forwarding }) },
  });
  try {
    await storage.init();
    const run = await mastra.getWorkflow(INTAKE_WORKFLOW_ID).createRun();
    const result = await run.start({ inputData: intake });
    if (result.status !== "success") {
      const error = result.status === "failed" ? result.error : undefined;
      const reason = error ? error.message : result.status;
      throw new IntakeRunError(
        `the Intake workflow did not finish: ${reason}`,
        stepOutput(result.steps, FORWARD_STEP_ID, Forwarded)?.forwardings ?? [],
        stepOutput(result.steps, FILE_STEP_ID, Filed)?.filings ?? [],
        mailFateOf(error),
      );
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
