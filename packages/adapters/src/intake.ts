import {
  FILING_TIME_ZONE,
  calendarDateIn,
  contentIdReferences,
  isCalendarDate,
  normalizeMessageId,
  withoutMessageIdComments,
} from "@hex/domain";
import { Data, Effect, Schema } from "effect";
import PostalMime from "postal-mime";
import { messageOf } from "./errors";

/** One attachment of an Intake, as the mail carried it. */
export const IntakeAttachment = Schema.Struct({
  /** The sender's file name, decoded (RFC 2047/2231); untrusted. */
  fileName: Schema.optionalKey(Schema.String),
  /** Content-Type as sent, lowercase, without parameters. */
  mimeType: Schema.String,
  /** Content-Disposition as sent (`attachment`, `inline`, …). */
  disposition: Schema.optionalKey(Schema.String),
  /** Content-ID as sent, usually in angle brackets. */
  contentId: Schema.optionalKey(Schema.String),
  /**
   * Decoded content as unwrapped, padded base64 (no whitespace or line breaks), so its decoded
   * size, which detection goes by, follows from its length.
   */
  content: Schema.String.check(Schema.isBase64()),
});
export type IntakeAttachment = typeof IntakeAttachment.Type;

/** One incoming email: what the Intake workflow processes once, keyed by its Message-ID. */
export const Intake = Schema.Struct({
  /**
   * Not blank once trimmed and unbracketed. As given (`workflows.start` may pass `<a@b>`): any
   * comparison or key must go through `normalizeMessageId` first.
   */
  messageId: Schema.String.check(
    Schema.makeFilter(
      (value) => normalizeMessageId(value) !== "" || "a Message-ID that is not blank",
    ),
  ),
  /**
   * When the mail was received: a UTC instant as `Date.toISOString()` writes it that names a
   * real moment (no 30 February) whose calendar date in the filing time zone has a year from
   * 1000 to 9999.
   */
  receivedAt: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    Schema.makeFilter((value) => {
      const date = new Date(value);
      return (
        (!Number.isNaN(date.getTime()) && date.toISOString() === value && isFilable(date)) ||
        `a real UTC instant whose year in ${FILING_TIME_ZONE} is 1000 to 9999`
      );
    }),
  ),
  /** The From address, if any. */
  sender: Schema.optionalKey(Schema.String),
  /** The Subject, decoded (RFC 2047), if any; untrusted. */
  subject: Schema.optionalKey(Schema.String),
  /** Content-IDs the HTML body references with `cid:` URLs. */
  cidReferences: Schema.Array(Schema.String),
  attachments: Schema.Array(IntakeAttachment),
});
export type Intake = typeof Intake.Type;

/** An `.eml` that can't become an Intake; the message names the file. */
export class IntakeReadError extends Data.TaggedError("IntakeReadError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Whether an instant can be filed: its calendar date in the filing time zone is valid. */
function isFilable(instant: Date): boolean {
  return isCalendarDate(calendarDateIn(instant, FILING_TIME_ZONE));
}

/** `value` without its comments; nested comments are not recognised. */
const withoutComments = (value: string) => value.replace(/\([^()]*\)/g, " ");

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Zone names with a defined offset, as minutes east of UTC (RFC 5322 §4.3). Every other
 * alphabetic zone (`UTC`, `Z`, `CET`, military letters) is read as `-0000`, i.e. UTC, as §4.3
 * says.
 */
const ZONES: Readonly<Record<string, number>> = {
  ut: 0,
  gmt: 0,
  edt: -4 * 60,
  est: -5 * 60,
  cdt: -5 * 60,
  cst: -6 * 60,
  mdt: -6 * 60,
  mst: -7 * 60,
  pdt: -7 * 60,
  pst: -8 * 60,
};

/**
 * The date-time forms accepted: `[Day,] D Mon YYYY HH:MM[:SS] zone`, a four-digit year, two-digit
 * hours, the zone `±HHMM` or a name. Comments without nested parentheses, such as `(CET)`, are
 * removed before matching; two-digit years and nested comments are not accepted.
 */
const MAIL_DATE =
  /^(?:[a-z]{3},\s*)?(\d{1,2})\s+([a-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+(?:([+-])(\d{2})(\d{2})|([a-z]+))$/i;

/**
 * The instant a mail header date-time names (see {@link MAIL_DATE}), or undefined unless it has
 * that shape with a zone (so it never depends on the host's time zone), a header year of 1000 or
 * later, a valid time (hours up to 23, minutes up to 59, seconds up to 60, a leap second `:60`
 * read as `:59`; zone offsets up to 23:59), a day that exists in its month, and a calendar year
 * in the filing time zone from 1000 to 9999.
 */
function parseMailDate(value: string): Date | undefined {
  const match = MAIL_DATE.exec(withoutComments(value).replace(/\s+/g, " ").trim());
  if (!match) return undefined;
  const [
    ,
    day,
    monthName,
    year,
    hour,
    minute,
    second = "0",
    sign,
    offsetHours,
    offsetMinutes,
    name,
  ] = match;
  const month = MONTHS.indexOf(monthName!.toLowerCase());
  const [y, d, h, m, s] = [year, day, hour, minute, second].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const [zoneHours, zoneMinutes] = [Number(offsetHours ?? 0), Number(offsetMinutes ?? 0)];
  // Below 1000 also keeps Date.UTC from reading years 0-99 as 1900-1999.
  if (
    month === -1 ||
    y < 1000 ||
    h > 23 ||
    m > 59 ||
    s > 60 ||
    zoneHours > 23 ||
    zoneMinutes > 59
  ) {
    return undefined;
  }
  const offset =
    name === undefined
      ? (sign === "-" ? -1 : 1) * (zoneHours * 60 + zoneMinutes)
      : Object.hasOwn(ZONES, name.toLowerCase())
        ? ZONES[name.toLowerCase()]!
        : 0;
  const local = new Date(Date.UTC(y, month, d, h, m, Math.min(s, 59)));
  // Date.UTC rolls 31 February over into March; such a day does not exist.
  if (local.getUTCMonth() !== month || local.getUTCDate() !== d) return undefined;
  const instant = new Date(local.getTime() - offset * 60_000);
  return isFilable(instant) ? instant : undefined;
}

/**
 * Reads an `.eml` into an Intake. The received date is the date after the last `;` of the
 * topmost `Received:` header (added by the receiving server) when that parses
 * ({@link parseMailDate}), else the `Date:` header. An attached mail (`message/rfc822`) stays one
 * attachment, never unpacked. Fails, naming `source`, when the bytes are no mail, or the mail
 * has no usable Message-ID (missing, or blank without its brackets and comments) or no usable date.
 */
export function readEml(bytes: Uint8Array, source: string): Effect.Effect<Intake, IntakeReadError> {
  return Effect.gen(function* () {
    const email = yield* Effect.tryPromise({
      // Base64 straight from the parser: the content's form in the Intake.
      try: () =>
        PostalMime.parse(bytes, { attachmentEncoding: "base64", forceRfc822Attachments: true }),
      catch: (cause) =>
        new IntakeReadError({
          message: `${source}: not a readable email (${messageOf(cause)})`,
          cause,
        }),
    });
    if (email.headers.length === 0) {
      return yield* new IntakeReadError({ message: `${source}: not an email (no headers)` });
    }
    const messageId = normalizeMessageId(withoutMessageIdComments(email.messageId ?? ""));
    if (!messageId) {
      return yield* new IntakeReadError({
        message: `${source}: no usable Message-ID (missing or blank), so the Intake can't be processed exactly once`,
      });
    }
    // Comments first: a `;` inside a trailing comment must not split the header.
    const topmostReceived = withoutComments(
      email.headers.find(({ key }) => key === "received")?.value ?? "",
    );
    const separator = topmostReceived.lastIndexOf(";");
    const dateHeader = email.headers.find(({ key }) => key === "date")?.value;
    const received =
      (separator === -1 ? undefined : parseMailDate(topmostReceived.slice(separator + 1))) ??
      (dateHeader === undefined ? undefined : parseMailDate(dateHeader));
    if (!received) {
      return yield* new IntakeReadError({
        message: `${source}: no Received or Date header with a usable date ([Day,] D Mon YYYY HH:MM[:SS] zone), so no received date`,
      });
    }
    const sender = email.from?.address;
    return {
      messageId,
      receivedAt: received.toISOString(),
      ...(sender ? { sender } : {}),
      ...(email.subject ? { subject: email.subject } : {}),
      cidReferences: [...contentIdReferences(email.html ?? "")],
      attachments: email.attachments.map((attachment) => ({
        ...(attachment.filename ? { fileName: attachment.filename } : {}),
        mimeType: attachment.mimeType,
        ...(attachment.disposition ? { disposition: attachment.disposition } : {}),
        ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
        content: attachment.content as string, // attachmentEncoding: "base64"
      })),
    };
  });
}
