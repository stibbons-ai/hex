// The Intake report: the short message Daniel gets on his Main channel after each Intake run that
// ends processed or failed.

/** One Filing as the report tells it: where the Document went, and whether it fell back. */
export interface ReportFiling {
  /** Relative to the Outbox: `YYYY-MM/<Category>/<file name>`. */
  readonly path: string;
  /** Filed by the received date, since no usable Document date was detected. */
  readonly fellBack: boolean;
}

/** One target the Intake's Documents went to: by this run, or by an earlier one. */
export interface ReportForwarding {
  readonly target: string;
  readonly earlier: boolean;
}

/** One branch that failed the run: which (e.g. `filing`, `forwarding to sevdesk`), and why. */
export interface ReportFailure {
  readonly branch: string;
  readonly reason: string;
}

/** What became of the mail of an Intake that failed permanently. */
export type ReportFailedMail =
  | { readonly status: "moved" }
  | { readonly status: "not-in-mailbox" }
  | { readonly status: "not-moved"; readonly reason: string };

/** What a failed run means for the Intake. */
export type ReportConsequence =
  /** Runs left: hex runs it again no sooner than `retryInMinutes`. */
  | {
      readonly status: "retry";
      readonly failedRuns: number;
      readonly maxFailedRuns: number;
      readonly retryInMinutes: number;
    }
  /** The last run: its mail goes to `hex/failed`. */
  | {
      readonly status: "failed-permanently";
      readonly failedRuns: number;
      readonly maxFailedRuns: number;
      readonly mail: ReportFailedMail;
    }
  /** The failed run could not be counted. */
  | { readonly status: "uncounted"; readonly reason: string };

/** One Intake run's outcome, as the Intake report tells it. */
export interface IntakeReportInput {
  /** As the mail gives them; untrusted. */
  readonly intake: {
    readonly messageId: string;
    readonly subject?: string | undefined;
    readonly sender?: string | undefined;
  };
  /** Processed: every Filing of the Intake. Failed: the ones this run made before it failed. */
  readonly filings: readonly ReportFiling[];
  /** The targets that have the Documents. */
  readonly forwardings: readonly ReportForwarding[];
  readonly outcome:
    | { readonly status: "processed" }
    | {
        readonly status: "failed";
        readonly failures: readonly ReportFailure[];
        readonly consequence: ReportConsequence;
      };
}

/** How long a quoted value may get before it is cut. */
const MAX_QUOTED = 200;

/** Line breaks and other control characters, and the bidi controls that can disguise a name. */
const UNPRINTABLE = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]+/gu;

/**
 * `text` as a code span: on one line, without backticks (so it can't end the span early), cut to
 * {@link MAX_QUOTED} characters. Every value that comes from the mail or a server goes in one, so
 * a chat platform shows it literally: no mention, link or formatting forms from it.
 */
function quote(text: string): string {
  const flat = text.replace(UNPRINTABLE, " ").replaceAll("`", "'").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  const cut = chars.length > MAX_QUOTED ? `${chars.slice(0, MAX_QUOTED - 1).join("")}…` : flat;
  return `\`${cut}\``;
}

/** Whether `value` says anything once flattened. */
const present = (value: string | undefined): value is string =>
  value !== undefined && value.replace(UNPRINTABLE, "").trim() !== "";

/** The Intake by its subject and sender when it has them, else by its Message-ID. */
function identify({ messageId, subject, sender }: IntakeReportInput["intake"]): string {
  const parts = [
    ...(present(subject) ? [quote(subject)] : []),
    ...(present(sender) ? [`from ${quote(sender)}`] : []),
  ];
  return parts.length > 0 ? parts.join(" ") : quote(messageId);
}

const documents = (count: number) => (count === 1 ? "1 Document" : `${count} Documents`);

/** The folder of a Filing's path, `YYYY-MM/<Category>`, and its file name. */
function splitPath(path: string): { folder: string; fileName: string } {
  const slash = path.lastIndexOf("/");
  return { folder: path.slice(0, slash), fileName: path.slice(slash + 1) };
}

/**
 * The Filings: how many went into each folder, in order of first appearance, e.g. "3 Documents
 * filed under 2026-10/ER, 1 under 2026-09/ER"; then those filed by the received date, each named.
 */
function filingLines(filings: readonly ReportFiling[]): string[] {
  const counts = new Map<string, number>();
  for (const { path } of filings) {
    const { folder } = splitPath(path);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  const [first, ...rest] = [...counts].map(([folder, count], position) =>
    position === 0 ? `${documents(count)} filed under ${folder}` : `${count} under ${folder}`,
  );
  if (first === undefined) return [];
  const fellBack = filings.filter((filing) => filing.fellBack);
  return [
    [first, ...rest].join(", "),
    ...(fellBack.length === 0
      ? []
      : [
          `${fellBack.length} without a detected date, filed by received date: ${fellBack
            .map(({ path }) => quote(splitPath(path).fileName))
            .join(", ")}`,
        ]),
  ];
}

/** The targets that have the Documents, e.g. "Forwarded to sevdesk, paperless (earlier run)". */
function forwardingLines(forwardings: readonly ReportForwarding[]): string[] {
  if (forwardings.length === 0) return [];
  const targets = forwardings.map(({ target, earlier }) =>
    earlier ? `${target} (earlier run)` : target,
  );
  return [`Forwarded to ${targets.join(", ")}`];
}

function consequenceLine(consequence: ReportConsequence): string {
  switch (consequence.status) {
    case "retry":
      return `Failed run ${consequence.failedRuns} of ${consequence.maxFailedRuns}: hex tries again in ${consequence.retryInMinutes} min at the earliest.`;
    case "failed-permanently": {
      const { failedRuns, maxFailedRuns, mail } = consequence;
      const where =
        mail.status === "moved"
          ? "its mail was moved to hex/failed"
          : mail.status === "not-in-mailbox"
            ? "no mail of it was in the watched folder"
            : `moving its mail to hex/failed failed (${quote(mail.reason)}); see the hex log`;
      return `Failed run ${failedRuns} of ${maxFailedRuns}: failed permanently, ${where}.`;
    }
    case "uncounted":
      return `Counting the failed run failed (${quote(consequence.reason)}); see the hex log.`;
  }
}

/**
 * The Intake report for one run, as plain text: the Intake by its subject and sender (else its
 * Message-ID), then what was filed and where, each Document filed by the received date named,
 * and the targets forwarded to. A failed run is marked FAILED, names each failed branch, what was
 * done nonetheless, and what comes next: a retry, or the Intake failed permanently. Every value
 * from the mail or a server is quoted as a code span (see {@link quote}).
 */
export function renderIntakeReport({
  intake,
  filings,
  forwardings,
  outcome,
}: IntakeReportInput): string {
  const done = [...filingLines(filings), ...forwardingLines(forwardings)];
  if (outcome.status === "processed") {
    return [
      `Intake processed: ${identify(intake)}`,
      ...(filings.length === 0 ? ["No Documents; nothing filed."] : []),
      ...done,
    ].join("\n");
  }
  return [
    `Intake FAILED: ${identify(intake)}`,
    ...outcome.failures.map(({ branch, reason }) => `Failed: ${branch}: ${quote(reason)}`),
    ...(done.length === 0 ? ["Nothing filed or forwarded."] : ["Done nonetheless:", ...done]),
    consequenceLine(outcome.consequence),
  ].join("\n");
}
