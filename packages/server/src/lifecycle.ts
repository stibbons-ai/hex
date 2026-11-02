export interface Stoppable {
  stop(): Promise<void>;
}

export interface ShutdownEffects {
  exit(code: number): void;
  error(message: string, cause: unknown): void;
}

/**
 * Returns a signal handler that stops the server once, however many signals arrive. A signal
 * during startup waits for the server to finish starting, then stops it. Exits 0 after a clean
 * stop and 1 when stop fails. A failed startup is left to the caller awaiting `starting`, so it is
 * reported once.
 */
export function shutdownOnce(starting: Promise<Stoppable>, effects: ShutdownEffects): () => void {
  let stopping: Promise<void> | undefined;
  return () => {
    stopping ??= starting.then(
      (server) =>
        server.stop().then(
          () => effects.exit(0),
          (error: unknown) => {
            effects.error("hex: shutdown failed", error);
            effects.exit(1);
          },
        ),
      () => {},
    );
  };
}
