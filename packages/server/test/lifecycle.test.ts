import { describe, expect, test } from "bun:test";
import { type Stoppable, shutdownOnce } from "../src/lifecycle";

function effects() {
  const exits: number[] = [];
  const errors: unknown[] = [];
  const { promise: exited, resolve } = Promise.withResolvers<void>();
  return {
    exits,
    errors,
    exited,
    effects: {
      exit: (code: number) => {
        exits.push(code);
        resolve();
      },
      error: (_message: string, cause: unknown) => errors.push(cause),
    },
  };
}

describe("shutdownOnce", () => {
  test("stops once and exits 0, however many signals arrive", async () => {
    let stops = 0;
    const server: Stoppable = { stop: async () => void stops++ };
    const run = effects();
    const handler = shutdownOnce(Promise.resolve(server), run.effects);
    handler();
    handler();
    await run.exited;
    expect(stops).toBe(1);
    expect(run.exits).toEqual([0]);
  });

  test("a signal during startup waits for the server, then stops it", async () => {
    const starting = Promise.withResolvers<Stoppable>();
    let stops = 0;
    const run = effects();
    shutdownOnce(starting.promise, run.effects)();
    for (let turn = 0; turn < 10; turn++) await Promise.resolve(); // let any premature stop run
    expect(run.exits).toEqual([]);
    starting.resolve({ stop: async () => void stops++ });
    await run.exited;
    expect(stops).toBe(1);
    expect(run.exits).toEqual([0]);
  });

  test("a failing stop is logged and exits 1", async () => {
    const failure = new Error("stop failed");
    const run = effects();
    shutdownOnce(Promise.resolve({ stop: async () => Promise.reject(failure) }), run.effects)();
    await run.exited;
    expect(run.errors).toEqual([failure]);
    expect(run.exits).toEqual([1]);
  });

  test("a failed startup is logged and exits 1", async () => {
    const failure = new Error("port in use");
    const run = effects();
    const starting = Promise.reject(failure);
    starting.catch(() => {}); // main.ts also awaits it; this test only exercises the handler
    shutdownOnce(starting, run.effects)();
    await run.exited;
    expect(run.errors).toEqual([failure]);
    expect(run.exits).toEqual([1]);
  });
});
