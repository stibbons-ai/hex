/** The message of a thrown value: an Error's message, anything else as a string. */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Whether `error` is a Node system error with errno `code` (`ENOENT`, `EEXIST`, …). */
export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
