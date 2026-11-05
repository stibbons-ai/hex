/** The message of a thrown value: an Error's message, anything else as a string. */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
