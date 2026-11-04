/**
 * Settles like `promise`, or rejects naming `what` after `ms`: a regression then fails fast with
 * a cause instead of hanging until the test runner's own timeout.
 */
export async function within<T>(promise: Promise<T>, what: string, ms = 2000): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => timeout.reject(new Error(`timed out after ${ms} ms waiting for ${what}`)),
    ms,
  );
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/** A loopback port nothing listens on right now, so a test can prove a server never bound it. */
export async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}
