/** Runs every closer in order, even after a failure, then rethrows the first failure. */
export async function closeInOrder(closers: readonly (() => Promise<unknown>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const close of closers) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
}
