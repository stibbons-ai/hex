import { contentIdReferences, normalizeMessageId } from "@hex/domain";
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
  /** Decoded content, base64; its size is what detection goes by. */
  content: Schema.String,
});
export type IntakeAttachment = typeof IntakeAttachment.Type;

/** One incoming email: what the Intake workflow processes once, keyed by its Message-ID. */
export const Intake = Schema.Struct({
  messageId: Schema.String.check(Schema.isNonEmpty()),
  /**
   * When the mail was received: a UTC instant as `Date.toISOString()` writes it, year 1000 or
   * later, that names a real moment (no 30 February).
   */
  receivedAt: Schema.String.check(
    Schema.isPattern(/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    Schema.makeFilter((value) => {
      const date = new Date(value);
      return (
        (!Number.isNaN(date.getTime()) && date.toISOString() === value) || "a real UTC instant"
      );
    }),
  ),
  /** The From address, if any. */
  sender: Schema.optionalKey(Schema.String),
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

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** RFC 5322 obsolete zone names, as minutes east of UTC. */
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
 * `[Day,] D Mon YYYY HH:MM[:SS] zone`, the zone `±HHMM` or an obsolete name. Comments such as
 * `(CET)` are removed before matching.
 */
const RFC5322_DATE =
  /^(?:[a-z]{3},\s*)?(\d{1,2})\s+([a-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+([+-]\d{4}|[a-z]+)$/i;

/**
 * The instant an RFC 5322 date-time names, or undefined unless it has that exact shape with a
 * zone (so it never depends on the host's time zone), a year from 1000 to 9999 and a day that
 * exists in its month.
 */
function parseMailDate(value: string): Date | undefined {
  const match = RFC5322_DATE.exec(
    value
      .replace(/\([^()]*\)/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  if (!match) return undefined;
  const [, day, monthName, year, hour, minute, second = "0", zone] = match;
  const month = MONTHS.indexOf(monthName!.toLowerCase());
  const offset = /^[+-]\d{4}$/.test(zone!)
    ? (zone!.startsWith("-") ? -1 : 1) * (Number(zone!.slice(1, 3)) * 60 + Number(zone!.slice(3)))
    : ZONES[zone!.toLowerCase()];
  const [y, d, h, m, s] = [year, day, hour, minute, second].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (month === -1 || offset === undefined || y < 1000 || h > 23 || m > 59 || s > 60) {
    return undefined;
  }
  const local = new Date(Date.UTC(y, month, d, h, m, Math.min(s, 59)));
  // Date.UTC rolls 31 February over into March; such a day does not exist.
  if (local.getUTCMonth() !== month || local.getUTCDate() !== d) return undefined;
  return new Date(local.getTime() - offset * 60_000);
}

/**
 * Reads an `.eml` into an Intake. The received date is the date after the last `;` of the
 * topmost `Received:` header (added by the receiving server) when that parses
 * ({@link parseMailDate}), else the `Date:` header. An attached mail (`message/rfc822`) stays one
 * attachment, never unpacked. Fails, naming `source`, when the bytes are no mail, or the mail
 * has no Message-ID or no usable date.
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
    const messageId = normalizeMessageId(email.messageId ?? "");
    if (!messageId) {
      return yield* new IntakeReadError({
        message: `${source}: no Message-ID, so the Intake can't be processed exactly once`,
      });
    }
    const topmostReceived = email.headers.find(({ key }) => key === "received")?.value ?? "";
    const separator = topmostReceived.lastIndexOf(";");
    const dateHeader = email.headers.find(({ key }) => key === "date")?.value;
    const received =
      (separator === -1 ? undefined : parseMailDate(topmostReceived.slice(separator + 1))) ??
      (dateHeader === undefined ? undefined : parseMailDate(dateHeader));
    if (!received) {
      return yield* new IntakeReadError({
        message: `${source}: no Received or Date header with a valid RFC 5322 date, so no received date`,
      });
    }
    const sender = email.from?.address;
    return {
      messageId,
      receivedAt: received.toISOString(),
      ...(sender ? { sender } : {}),
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
