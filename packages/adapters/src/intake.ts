import { contentIdReferences, normalizeMessageId } from "@hex/domain";
import { Data, Effect, Schema } from "effect";
import PostalMime from "postal-mime";

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
  /** Decoded size in bytes. */
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Decoded content, base64. */
  content: Schema.String,
});
export type IntakeAttachment = typeof IntakeAttachment.Type;

/** One incoming email: what the Intake workflow processes once, keyed by its Message-ID. */
export const Intake = Schema.Struct({
  messageId: Schema.String.check(Schema.isNonEmpty()),
  /** When the mail was received, a UTC ISO 8601 instant (`Date.toISOString()`). */
  receivedAt: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  ),
  /** The From address, if any. */
  sender: Schema.optionalKey(Schema.String),
  /** Content-IDs the HTML body references with `cid:` URLs, normalised. */
  cidReferences: Schema.Array(Schema.String),
  attachments: Schema.Array(IntakeAttachment),
});
export type Intake = typeof Intake.Type;

/** An `.eml` that can't become an Intake; the message names the file. */
export class IntakeReadError extends Data.TaggedError("IntakeReadError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The instant a date header names, or undefined; RFC 5322 comments like `(CET)` are ignored. */
function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value.replace(/\([^()]*\)/g, " ").trim());
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Reads an `.eml` into an Intake. The received date is the date of the topmost `Received:` header
 * (added by the receiving server) when it parses, else the `Date:` header. Fails, naming `source`,
 * when the mail can't be parsed or has no Message-ID or no usable date.
 */
export function readEml(bytes: Uint8Array, source: string): Effect.Effect<Intake, IntakeReadError> {
  return Effect.gen(function* () {
    const email = yield* Effect.tryPromise({
      // Base64 straight from the parser: the content's form in the Intake.
      try: () => PostalMime.parse(bytes, { attachmentEncoding: "base64" }),
      catch: (cause) =>
        new IntakeReadError({
          message: `${source}: not a readable email (${(cause as Error).message})`,
          cause,
        }),
    });
    const messageId = normalizeMessageId(email.messageId ?? "");
    if (!messageId) {
      return yield* new IntakeReadError({
        message: `${source}: no Message-ID, so the Intake can't be processed exactly once`,
      });
    }
    const topmostReceived = email.headers.find(({ key }) => key === "received")?.value;
    const received =
      parseDate(topmostReceived?.slice(topmostReceived.lastIndexOf(";") + 1)) ??
      parseDate(email.date);
    if (!received) {
      return yield* new IntakeReadError({
        message: `${source}: no parsable Received or Date header, so no received date`,
      });
    }
    const sender = email.from?.address;
    return {
      messageId,
      receivedAt: received.toISOString(),
      ...(sender ? { sender } : {}),
      cidReferences: [...contentIdReferences(email.html ?? "")],
      attachments: email.attachments.map((attachment) => {
        const content = attachment.content as string; // attachmentEncoding: "base64"
        return {
          ...(attachment.filename ? { fileName: attachment.filename } : {}),
          mimeType: attachment.mimeType,
          ...(attachment.disposition ? { disposition: attachment.disposition } : {}),
          ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
          size: Buffer.byteLength(content, "base64"),
          content,
        };
      }),
    };
  });
}
