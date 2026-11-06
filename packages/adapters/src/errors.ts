/** The message of a thrown value: an Error's message, anything else as a string. */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * `message` with each pair's secret replaced by its replacement, in the order given; empty
 * secrets are skipped.
 */
export function redact(
  message: string,
  replacements: readonly (readonly [secret: string, replacement: string])[],
): string {
  return replacements.reduce(
    (text, [secret, replacement]) => (secret ? text.replaceAll(secret, replacement) : text),
    message,
  );
}

/**
 * The redactions (each form paired with `***`) that keep a mail server login out of an error,
 * should the server echo it back: the credentials in base64, as AUTH PLAIN and LOGIN send them,
 * then `passwordForms` (the password as is by default; IMAP adds its quoted form) and the user as
 * is. Base64 forms come first, so none is half-replaced. The user's forms only from 8 characters,
 * as `withoutApiKeys` does: a shorter one is too likely to match ordinary text.
 */
export function credentialRedactions(
  user: string,
  password: string,
  passwordForms: readonly string[] = [password],
): (readonly [string, string])[] {
  const base64 = (text: string) => Buffer.from(text).toString("base64");
  const userForms = (form: string) => (form.length >= 8 ? [form] : []);
  return [
    base64(`\u0000${user}\u0000${password}`),
    base64(password),
    ...userForms(base64(user)),
    ...passwordForms,
    ...userForms(user),
  ].map((form) => [form, "***"] as const);
}

/**
 * How much of a provider's or server's error message an error keeps: some quote the rejected
 * request, a Document's content included, and the workflow persists its failure.
 */
const MAX_FOREIGN_MESSAGE = 300;

/** `reason` trimmed and cut to {@link MAX_FOREIGN_MESSAGE} characters; `no message` when empty. */
export function excerpt(reason: string): string {
  const trimmed = reason.trim() || "no message";
  return trimmed.length > MAX_FOREIGN_MESSAGE
    ? `${trimmed.slice(0, MAX_FOREIGN_MESSAGE)}…`
    : trimmed;
}

/** Whether `error` is a Node system error with errno `code` (`ENOENT`, `EEXIST`, …). */
export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
