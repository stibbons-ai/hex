/** The message of a thrown value: an Error's message, anything else as a string. */
export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
