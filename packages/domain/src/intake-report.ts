// The Intake report: the short message Daniel gets on his Main channel after each Intake run that
// ends processed or failed. A run that ends before its move step (an unreadable ledger, a defect)
// gets none.

/** One Filing as the report tells it: where the Document went, and whether it fell back. */
export interface ReportFiling {
  /**
   * Relative to the Outbox: `YYYY-MM/<Category>/<file name>`. The folder part is trusted (composed
   * by hex, its Category from config), shown as is; the file name is untrusted, quoted.
   */
  readonly path: string;
  /** Filed by the received date, since no usable Document date was detected. */
  readonly fellBack: boolean;
}

/** One target the Intake's Documents went to: by this run, or by an earlier one. */
export interface ReportForwarding {
  /** The target's name from config; trusted, shown as is. */
  readonly target: string;
  readonly earlier: boolean;
}

/** One branch that failed the run: which (e.g. `filing`, `forwarding to sevdesk`), and why. */
export interface ReportFailure {
  /** Which branch, composed by hex from config (target names); trusted, shown as is. */
  readonly branch: string;
  /**
   * Why it failed; with {@link sentUnrecorded}, why recording the send failed. Untrusted (from the
   * mail or a server), quoted.
   */
  readonly reason: string;
  /**
   * The server accepted the send but the ledger couldn't record it: running this Intake again
   * sends it again. Said by hex, outside the quoted reason, so cutting that never cuts this.
   */
  readonly sentUnrecorded?: boolean | undefined;
}

/**
 * Why a send the ledger couldn't record failed its branch, and what that means, `reason` as given
 * (quote it first where it goes into a report).
 */
export const sentUnrecordedReason = (reason: string): string =>
  `sent, but recording it failed (${reason}); running this Intake again sends it again`;

/** What became of the mail of an Intake that failed permanently. */
export type ReportFailedMail =
  | { readonly status: "moved" }
  | { readonly status: "not-in-mailbox" }
  | {
      readonly status: "not-moved";
      /** Untrusted (from a server), quoted. */
      readonly reason: string;
    };

/** What a failed run means for the Intake. */
export type ReportConsequence =
  /** Runs left: hex runs it again no sooner than `retryInMinutes`. */
  | {
      readonly status: "retry";
      readonly failedRuns: number;
      readonly maxFailedRuns: number;
      readonly retryInMinutes: number;
    }
  /**
   * The last run: the Intake failed permanently, its mail due in `hex/failed`; `mail` says what
   * became of it.
   */
  | {
      readonly status: "failed-permanently";
      readonly failedRuns: number;
      readonly maxFailedRuns: number;
      readonly mail: ReportFailedMail;
    }
  /**
   * Runs left by the ledger's count, none by the effective one (failed runs the mailbox watcher
   * counted in memory, the ledger failing, included): the watcher fails the Intake permanently at
   * its next look of the mailbox, its mail going to `hex/failed` then.
   */
  | {
      readonly status: "failing-permanently";
      readonly failedRuns: number;
      readonly maxFailedRuns: number;
    }
  /** The failed run could not be recorded (counted, or its Intake failed permanently). */
  | {
      readonly status: "uncounted";
      /** Untrusted (from a server), quoted. */
      readonly reason: string;
    };

/** One Intake run's outcome, as the Intake report tells it. */
export interface IntakeReportInput {
  /** As the mail gives them; untrusted. */
  readonly intake: {
    readonly messageId: string;
    readonly subject?: string | undefined;
    readonly sender?: string | undefined;
  };
  /**
   * Every Filing of the Intake so far, also those an earlier run made (only this run's when the
   * ledger can't be read: then `earlierRunsUnreadable` says so).
   */
  readonly filings: readonly ReportFiling[];
  /**
   * The Documents this run wrote to the Outbox but couldn't record in the ledger: running the
   * Intake again files them again.
   */
  readonly unrecordedFilings?: readonly ReportFiling[] | undefined;
  /** The targets that have the Documents (only this run's when the ledger can't be read). */
  readonly forwardings: readonly ReportForwarding[];
  /**
   * Why earlier runs' Filings and Forwardings could not be read, if they couldn't: the report
   * then lists this run's alone. Untrusted (from a server), quoted.
   */
  readonly earlierRunsUnreadable?: string | undefined;
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

/** How many folders, and how many file names, a line lists before it counts the rest. */
const MAX_LISTED = 10;

/**
 * Line breaks and other control characters, and format characters: the bidi controls that can
 * disguise a name, zero-width characters, the byte order mark.
 */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

/**
 * `text` as a code span: on one line, without backticks (so it can't end the span early), cut to
 * {@link MAX_QUOTED} characters. Every value that comes from the mail or a server goes in one; the
 * code span plus the channel's own escaping (`plainText` in `packages/server/src/channels.ts`)
 * keep it literal: no mention, link or formatting forms from it.
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
  const parts: string[] = [];
  if (present(subject)) parts.push(quote(subject));
  if (present(sender)) parts.push(`from ${quote(sender)}`);
  return parts.length > 0 ? parts.join(" ") : quote(messageId);
}

/** Where a failed Intake's mail went, as the end of the consequence line. */
function failedMailLine(mail: ReportFailedMail): string {
  switch (mail.status) {
    case "moved":
      return "its mail was moved to hex/failed";
    case "not-in-mailbox":
      return "its mail was not found by its Message-ID in the watched folder; see the hex log";
    case "not-moved":
      return `moving its mail to hex/failed failed (${quote(mail.reason)}); if moving it keeps failing, hex runs the Intake afresh; see the hex log`;
  }
}

/** The folder of a Filing's path, `YYYY-MM/<Category>`, and its file name. */
function splitPath(path: string): { folder: string; fileName: string } {
  const slash = path.lastIndexOf("/");
  return { folder: path.slice(0, slash), fileName: path.slice(slash + 1) };
}

/** `items` joined by commas, at most {@link MAX_LISTED} of them, then "and N more". */
function listBounded(items: readonly string[]): string {
  const listed = items.slice(0, MAX_LISTED);
  const rest = items.length - listed.length;
  return [...listed, ...(rest > 0 ? [`and ${rest} more`] : [])].join(", ");
}

/**
 * The Filings: how many went into each folder, in order of first appearance, e.g. "3 Documents
 * filed under 2026-10/ER, 1 under 2026-09/ER" (at most {@link MAX_LISTED} folders, then "and N
 * more in M folders"); then those filed by the received date, each named (at most
 * {@link MAX_LISTED}, then "and N more").
 */
function filingLines(filings: readonly ReportFiling[]): string[] {
  if (filings.length === 0) return [];
  const counts = new Map<string, number>();
  for (const { path } of filings) {
    const { folder } = splitPath(path);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  const folders = [...counts];
  const listed = folders
    .slice(0, MAX_LISTED)
    .map(([folder, count], position) =>
      position === 0
        ? `${count === 1 ? "1 Document" : `${count} Documents`} filed under ${folder}`
        : `${count} under ${folder}`,
    );
  const rest = folders.slice(MAX_LISTED);
  if (rest.length > 0) {
    const more = rest.reduce((sum, [, count]) => sum + count, 0);
    listed.push(`and ${more} more in ${rest.length === 1 ? "1 folder" : `${rest.length} folders`}`);
  }
  const lines = [listed.join(", ")];
  const fellBack = filings.filter((filing) => filing.fellBack);
  if (fellBack.length > 0) {
    const names = listBounded(fellBack.map(({ path }) => quote(splitPath(path).fileName)));
    lines.push(`${fellBack.length} without a detected date, filed by received date: ${names}`);
  }
  return lines;
}

/**
 * The Documents written to the Outbox but not recorded, each by its folder and name (at most
 * {@link MAX_LISTED}, then "and N more").
 */
function unrecordedLines(filings: readonly ReportFiling[]): string[] {
  if (filings.length === 0) return [];
  const paths = filings.map(({ path }) => {
    const { folder, fileName } = splitPath(path);
    return `${folder}/${quote(fileName)}`;
  });
  return [
    `Filed, but recording it failed, so running this Intake again files it again: ${listBounded(paths)}`,
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
      return `Failed run ${failedRuns} of ${maxFailedRuns}: failed permanently, ${failedMailLine(mail)}.`;
    }
    case "failing-permanently":
      return `Failed run ${consequence.failedRuns} of ${consequence.maxFailedRuns}: hex fails it permanently at its next look of the mailbox, its mail going to hex/failed then, unless that fails; see the hex log.`;
    case "uncounted":
      return `Recording or ending the failed runs failed (${quote(consequence.reason)}); see the hex log.`;
  }
}

/**
 * The Intake report for one run, as plain text: the Intake by its subject and sender (else its
 * Message-ID), then what was filed and where, each Document filed by the received date named,
 * and the targets forwarded to. A failed run is marked FAILED, names each failed branch, what was
 * done nonetheless (a Document written but not recorded among it), and what comes next: a retry,
 * or the Intake failed permanently. Earlier runs' work that could not be read is said so, never
 * told as nothing done. Every value from the mail or a server is quoted as a code span (see
 * {@link quote}).
 *
 * The report stays short whatever the Intake: each quoted value is cut at {@link MAX_QUOTED}
 * characters, each list at {@link MAX_LISTED} entries, and the failure and Forwarding lines grow
 * only with the configured targets and the targets recorded in the ledger; with a handful of
 * targets it stays within a few thousand characters, far below a chat platform's message limit,
 * so its last line, the consequence, is never cut.
 */
export function renderIntakeReport({
  intake,
  filings,
  unrecordedFilings = [],
  forwardings,
  earlierRunsUnreadable,
  outcome,
}: IntakeReportInput): string {
  const done = [
    ...filingLines(filings),
    ...unrecordedLines(unrecordedFilings),
    ...forwardingLines(forwardings),
  ];
  const unread =
    earlierRunsUnreadable === undefined
      ? []
      : [
          `${done.length === 0 ? "This run filed and forwarded nothing; earlier" : "Earlier"} runs' Filings and Forwardings could not be read (${quote(earlierRunsUnreadable)}), so they are not listed.`,
        ];
  if (outcome.status === "processed") {
    return [
      `Intake processed: ${identify(intake)}`,
      ...(done.length === 0 && unread.length === 0 ? ["No Documents; nothing filed."] : []),
      ...done,
      ...unread,
    ].join("\n");
  }
  const nothingDone = unread.length === 0 ? ["Nothing filed or forwarded."] : [];
  return [
    `Intake FAILED: ${identify(intake)}`,
    ...outcome.failures.map(
      ({ branch, reason, sentUnrecorded }) =>
        `Failed: ${branch}: ${sentUnrecorded ? sentUnrecordedReason(quote(reason)) : quote(reason)}`,
    ),
    ...(done.length === 0 ? nothingDone : ["Done nonetheless:", ...done]),
    ...unread,
    consequenceLine(outcome.consequence),
  ].join("\n");
}
