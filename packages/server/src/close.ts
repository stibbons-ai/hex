/**
 * Runs every closer in order, even after a failure. One failure is rethrown as is; several are
 * rethrown together as an AggregateError.
 */
export async function closeInOrder(closers: readonly (() => Promise<unknown>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const close of closers) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Several shutdown steps failed");
}
