import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { toMastraSchema } from "@hex/adapters";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { LibSQLStore } from "@mastra/libsql";
import { Schema } from "effect";
import { type RunningServer, type ServerOptions, startServer } from "../src";

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((address) => address && address.family === "IPv4" && !address.internal)?.address;

const Message = toMastraSchema(Schema.Struct({ message: Schema.String }));
const echo = createWorkflow({ id: "echo", inputSchema: Message, outputSchema: Message })
  .then(
    createStep({
      id: "echo",
      inputSchema: Message,
      outputSchema: Message,
      execute: async ({ inputData }) => inputData,
    }),
  )
  .commit();

let directory: string;
const servers: RunningServer[] = [];

async function start(options: Partial<ServerOptions> = {}): Promise<RunningServer> {
  const server = await startServer({
    databasePath: join(directory, "data", "mastra.db"),
    port: 0,
    logger: false,
    workflows: { echo },
    ...options,
  });
  servers.push(server);
  return server;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-server-"));
});

afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop()));
  await rm(directory, { recursive: true, force: true });
});

describe("hex server", () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await start();
  });

  test("binds Bun.serve to 127.0.0.1 on an ephemeral port", () => {
    expect(server.hostname).toBe("127.0.0.1");
    expect(server.url.hostname).toBe("127.0.0.1");
    expect(Number(server.url.port)).toBeGreaterThan(0);
  });

  test("answers the health route", async () => {
    const response = await fetch(new URL("/health", server.url));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("mounts Mastra's routes through the Hono adapter", async () => {
    const workflows = await fetch(new URL("/api/workflows", server.url));
    expect(workflows.status).toBe(200);
    expect(Object.keys((await workflows.json()) as object)).toEqual(["echo"]);
    expect((await fetch(new URL("/api/no-such-route", server.url))).status).toBe(404);
  });

  test.each(["/health", "/api/workflows"])(
    "serves %s only to a loopback Host header",
    async (path) => {
      const url = new URL(path, server.url);
      for (const host of [`127.0.0.1:${server.url.port}`, `localhost:${server.url.port}`]) {
        expect((await fetch(url, { headers: { host } })).status).toBe(200);
      }
      for (const host of [
        "evil.example",
        `evil.example:${server.url.port}`,
        `0.0.0.0:${server.url.port}`,
        `[::1]:${server.url.port}`,
        "127.0.0.1:1",
        "localhost",
      ]) {
        expect((await fetch(url, { headers: { host } })).status).toBe(403);
      }
    },
  );

  test.skipIf(lanAddress === undefined)(
    "refuses connections on a non-loopback address",
    async () => {
      const url = new URL("/health", server.url);
      url.hostname = lanAddress!;
      await expect(fetch(url)).rejects.toThrow();
    },
  );
});

test("persists workflow runs through Mastra into the LibSQL file", async () => {
  const databasePath = join(directory, "persist", "mastra.db");
  const first = await start({ databasePath });
  const started = await fetch(new URL("/api/workflows/echo/start-async", first.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputData: { message: "hello" } }),
  });
  expect(started.status).toBe(200);
  expect(await started.json()).toMatchObject({ status: "success", result: { message: "hello" } });
  await first.stop();
  servers.splice(servers.indexOf(first), 1);

  // A fresh server on the same file sees the run, so it went through the store, not memory.
  const second = await start({ databasePath });
  const runs = await fetch(new URL("/api/workflows/echo/runs", second.url));
  expect(runs.status).toBe(200);
  const body = (await runs.json()) as { runs: { workflowName: string }[]; total: number };
  expect(body.total).toBe(1);
  expect(body.runs[0]?.workflowName).toBe("echo");
});

test("keeps Mastra's default logger unless told otherwise", async () => {
  // Mastra's default logger writes errors with console.error; the noop logger writes nothing.
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  try {
    const server = await startServer({
      databasePath: join(directory, "logger", "mastra.db"),
      port: 0,
    });
    servers.push(server);
    server.mastra.getLogger().error("default-logger-probe");
    expect(consoleError).toHaveBeenCalledWith("default-logger-probe");

    consoleError.mockClear();
    const silenced = await start({ databasePath: join(directory, "silenced", "mastra.db") });
    silenced.mastra.getLogger().error("silenced-logger-probe");
    expect(consoleError).not.toHaveBeenCalled();
  } finally {
    consoleError.mockRestore();
  }
});

describe("stop()", () => {
  test("closes a held-open stream after the grace period and still shuts down", async () => {
    const release = Promise.withResolvers<void>();
    const hang = createWorkflow({ id: "hang", inputSchema: Message, outputSchema: Message })
      .then(
        createStep({
          id: "hang",
          inputSchema: Message,
          outputSchema: Message,
          execute: async ({ inputData }) => {
            await release.promise;
            return inputData;
          },
        }),
      )
      .commit();
    const shutdown = Promise.withResolvers<void>();
    const server = await startServer({
      databasePath: join(directory, "stream", "mastra.db"),
      port: 0,
      logger: false,
      workflows: { hang },
      stopGraceMs: 200,
    });
    const originalShutdown = server.mastra.shutdown.bind(server.mastra);
    server.mastra.shutdown = async (...args) => {
      shutdown.resolve();
      return originalShutdown(...args);
    };
    try {
      const response = await fetch(new URL("/api/workflows/hang/stream?runId=held", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inputData: { message: "hold" } }),
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      await reader.read(); // the stream is open and the step is waiting

      const started = performance.now();
      await server.stop();
      expect(performance.now() - started).toBeLessThan(3000);
      await shutdown.promise; // Mastra's shutdown ran after the forced close
      reader.releaseLock();
    } finally {
      // The step outlives shutdown and then fails against the closed store; keep that out of the
      // test output.
      const quiet = (["error", "warn", "log"] as const).map((level) =>
        spyOn(console, level).mockImplementation(() => {}),
      );
      release.resolve();
      await Bun.sleep(100);
      for (const spy of quiet) spy.mockRestore();
    }
  });

  test("rejects with a failing Mastra shutdown and still closes the store", async () => {
    const close = spyOn(LibSQLStore.prototype, "close");
    try {
      const server = await startServer({
        databasePath: join(directory, "shutdown-fails", "mastra.db"),
        port: 0,
        logger: false,
      });
      const failure = new Error("mastra shutdown failed");
      server.mastra.shutdown = async () => {
        throw failure;
      };
      close.mockClear();
      await expect(server.stop()).rejects.toBe(failure);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });

  test("a failed start closes the store and keeps the original error", async () => {
    const taken = await start({ databasePath: join(directory, "taken", "mastra.db") });
    const close = spyOn(LibSQLStore.prototype, "close");
    try {
      const failed = startServer({
        databasePath: join(directory, "port-in-use", "mastra.db"),
        port: Number(taken.url.port),
        logger: false,
      });
      await expect(failed).rejects.toThrow(/EADDRINUSE|in use/i);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });
});
