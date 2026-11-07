import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { toMastraSchema } from "@hex/adapters";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { DuckDBStore } from "@mastra/duckdb";
import { LibSQLStore } from "@mastra/libsql";
import { ORPCError, safe } from "@orpc/client";
import { Schema } from "effect";
import { type RunningServer, type ServerOptions, startServer } from "../src";
import { Message, client, echo, oneStep } from "./server-helpers";

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((address) => address && address.family === "IPv4" && !address.internal)?.address;

/** A one-step workflow whose step calls `entered`, then waits for `release`. */
function gated(id: string, entered: () => void, release: Promise<void>) {
  return oneStep(id, async (input) => {
    entered();
    await release;
    return input;
  });
}

let directory: string;
const servers: RunningServer[] = [];
let observed = 0;

/** The data files of a server in `<directory>/<name>`. */
function dataFiles(name: string) {
  return {
    databasePath: join(directory, name, "mastra.db"),
    observabilityPath: join(directory, name, "observability.duckdb"),
  };
}

async function start(options: Partial<ServerOptions> = {}): Promise<RunningServer> {
  const server = await startServer({
    databasePath: join(directory, "data", "mastra.db"),
    // A DuckDB file per running server, as in production, where only one process can hold one.
    observabilityPath: join(directory, `observability-${observed++}.duckdb`),
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

  test.each(["GET", "HEAD"])("answers %s /health", async (method) => {
    const response = await fetch(new URL("/health", server.url), { method });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("application/json");
    if (method === "GET") expect(await response.json()).toEqual({ status: "ok" });
  });

  test("serves the oRPC API under /rpc, and nothing else but GET/HEAD /health", async () => {
    const api = client(server);
    expect(await api.health()).toEqual({ status: "ok" });
    expect(await api.workflows.list()).toEqual(["echo"]);
    for (const path of ["/rpc/no-such-procedure", "/api/workflows", "/rpc-other", "/health"]) {
      expect((await fetch(new URL(path, server.url), { method: "POST" })).status).toBe(404);
    }
  });

  test("runs a workflow and returns its result", async () => {
    const started = await client(server).workflows.start({
      workflowId: "echo",
      inputData: { message: "hi" },
    });
    expect(started).toEqual({
      runId: expect.any(String),
      status: "success",
      result: { message: "hi" },
    });
  });

  test("answers an unknown workflow with NOT_FOUND", async () => {
    const api = client(server);
    // `constructor` is inherited by every object, so it also checks the lookup is own-key only.
    for (const call of [
      safe(api.workflows.start({ workflowId: "constructor", inputData: {} })),
      safe(api.workflows.runs({ workflowId: "constructor" })),
    ]) {
      const { error, isDefined } = await call;
      expect(isDefined).toBe(true);
      expect(error).toBeInstanceOf(ORPCError);
      expect(error).toMatchObject({ code: "NOT_FOUND", status: 404 });
    }
  });

  test("rejects input the workflow's schema rejects as BAD_REQUEST with Effect's issue", async () => {
    const { error } = await safe(
      client(server).workflows.start({ workflowId: "echo", inputData: { message: 42 } }),
    );
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
      data: { issues: [{ message: "Expected string", path: ["message"] }] },
    });
  });

  test("rejects a call the contract's own input schema rejects as BAD_REQUEST", async () => {
    const { error } = await safe(
      // Deliberately off the static contract, as a hand-written caller could send.
      client(server).workflows.start({ workflowId: 42 as unknown as string }),
    );
    expect(error).toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
      message: "Input validation failed",
      data: { issues: [{ path: ["workflowId"] }] },
    });
  });

  test.each([
    ["/health", "GET"],
    ["/rpc/health", "POST"],
  ])("serves %s only to a loopback Host header", async (path, method) => {
    const url = new URL(path, server.url);
    for (const host of [`127.0.0.1:${server.url.port}`, `localhost:${server.url.port}`]) {
      expect((await fetch(url, { method, headers: { host } })).status).toBe(200);
    }
    for (const host of [
      "evil.example",
      `evil.example:${server.url.port}`,
      `0.0.0.0:${server.url.port}`,
      `[::1]:${server.url.port}`,
      "127.0.0.1:1",
      "localhost",
    ]) {
      for (const verb of ["GET", "POST"]) {
        expect((await fetch(url, { method: verb, headers: { host } })).status).toBe(403);
      }
    }
  });

  test.skipIf(lanAddress === undefined)(
    "refuses connections on a non-loopback address",
    async () => {
      const url = new URL("/health", server.url);
      url.hostname = lanAddress!;
      await expect(fetch(url)).rejects.toThrow();
    },
  );
});

test("refuses a hostname that isn't an IP address before opening any file", async () => {
  const files = dataFiles("named-host");
  await expect(startServer({ ...files, port: 0, hostname: "localhost" })).rejects.toThrow(
    'hex: the server listens on an IP address only, got "localhost"',
  );
  expect(await Bun.file(files.databasePath).exists()).toBe(false);
});

test("persists workflow runs through Mastra into the LibSQL file", async () => {
  const databasePath = join(directory, "persist", "mastra.db");
  const other = oneStep("other", async (input) => input);
  const workflows = { echo, other };
  const first = await start({ databasePath, workflows });
  const started = await client(first).workflows.start({
    workflowId: "echo",
    inputData: { message: "hello" },
  });
  await client(first).workflows.start({ workflowId: "other", inputData: { message: "else" } });
  expect(started).toMatchObject({ status: "success", result: { message: "hello" } });
  await first.stop();
  servers.splice(servers.indexOf(first), 1);

  // A fresh server on the same file sees the run, so it went through the store, not memory.
  const second = await start({ databasePath, workflows });
  const { total, runs } = await client(second).workflows.runs({ workflowId: "echo" });
  // Only echo's run: the other workflow's run in the same file is not listed.
  expect(total).toBe(1);
  expect(runs).toEqual([
    {
      runId: started.runId,
      workflowName: "echo",
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    },
  ]);
});

test("follows the workflow's own input options: no input, no validation, no schema", async () => {
  const noInput = createWorkflow({
    id: "noInput",
    inputSchema: toMastraSchema(Schema.Unknown),
    outputSchema: Message,
  })
    .then(
      createStep({
        id: "noInput",
        inputSchema: toMastraSchema(Schema.Unknown),
        outputSchema: Message,
        execute: async ({ inputData }) => ({ message: String(inputData) }),
      }),
    )
    .commit();
  const unchecked = createWorkflow({
    id: "unchecked",
    inputSchema: Message,
    outputSchema: Message,
    options: { validateInputs: false },
  })
    .then(
      createStep({
        id: "unchecked",
        inputSchema: Message,
        outputSchema: Message,
        execute: async ({ inputData }) => inputData,
      }),
    )
    .commit();
  const schemaless = createWorkflow({
    id: "schemaless",
    inputSchema: toMastraSchema(Schema.Unknown),
    outputSchema: Message,
  })
    .then(
      createStep({
        id: "schemaless",
        inputSchema: toMastraSchema(Schema.Unknown),
        outputSchema: Message,
        execute: async ({ inputData }) => ({ message: typeof inputData }),
      }),
    )
    .commit();
  // The types require an input schema; a workflow built without one has none at runtime.
  Reflect.set(schemaless, "inputSchema", undefined);
  const server = await start({
    databasePath: join(directory, "input-options", "mastra.db"),
    workflows: { noInput, unchecked, schemaless },
  });
  const api = client(server);
  expect(await api.workflows.start({ workflowId: "noInput" })).toMatchObject({
    status: "success",
    result: { message: "undefined" },
  });
  expect(
    await api.workflows.start({ workflowId: "unchecked", inputData: { message: 42 } }),
  ).toMatchObject({ status: "success", result: { message: 42 } });
  expect(await api.workflows.start({ workflowId: "schemaless", inputData: 7 })).toMatchObject({
    status: "success",
    result: { message: "number" },
  });
});

test("reports a failed run, and logs server faults but not caller errors", async () => {
  const failing = oneStep("failing", async () => {
    throw new Error("step broke");
  });
  const server = await start({
    databasePath: join(directory, "faults", "mastra.db"),
    workflows: { failing },
  });
  const api = client(server);
  expect(await api.workflows.start({ workflowId: "failing", inputData: { message: "x" } })).toEqual(
    { runId: expect.any(String), status: "failed", error: "step broke" },
  );

  const logged = spyOn(server.mastra.getLogger(), "error");
  try {
    await safe(api.workflows.runs({ workflowId: "missing" }));
    const malformed = await fetch(new URL("/rpc/workflows/list", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    expect(logged).not.toHaveBeenCalled();

    const failure = new Error("registry broke");
    server.mastra.listWorkflows = () => {
      throw failure;
    };
    const { error } = await safe(api.workflows.list());
    expect(error).toMatchObject({ code: "INTERNAL_SERVER_ERROR", status: 500 });
    expect(logged).toHaveBeenCalledWith("hex: oRPC call failed", failure);
  } finally {
    logged.mockRestore();
  }
});

test("answers a response that fails to encode with a plain, logged 500", async () => {
  class Box {
    constructor(readonly value: bigint) {}
  }
  // Mastra doesn't check step output, so the BigInt inside a class instance reaches the encoder,
  // which oRPC's serializer doesn't walk into.
  const unencodable = oneStep(
    "unencodable",
    async () => ({ box: new Box(1n) }) as unknown as typeof Message.Type,
  );
  const server = await start({
    databasePath: join(directory, "unencodable", "mastra.db"),
    workflows: { unencodable },
  });
  const logged = spyOn(server.mastra.getLogger(), "error");
  try {
    const response = await fetch(new URL("/rpc/workflows/start", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: { workflowId: "unencodable", inputData: { message: "x" } } }),
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal server error");
    expect(logged).toHaveBeenCalledWith("hex: request failed", expect.any(TypeError));
  } finally {
    logged.mockRestore();
  }
});

describe("a cyclic output", () => {
  /** A one-step workflow whose step returns `output`; Mastra doesn't check step output. */
  function returning(id: string, output: unknown) {
    return oneStep(id, async () => output as typeof Message.Type);
  }
  /** `wrap(holder)`, where `holder.value` is that same result. */
  function cyclic<T extends object>(wrap: (self: unknown) => T): T {
    const holder: { value?: unknown } = {};
    const value = wrap(holder);
    holder.value = value;
    return value;
  }
  const shared = { message: "shared" };
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  // A leaf to the cycle check, but oRPC's serializer calls its getTime, so it fails only in the
  // encoder, after the procedure returned. Mastra hands the step output back by identity, and its
  // snapshot store dates it through toJSON, which doesn't call getTime.
  const unencodableDate = Object.assign(new Date(0), {
    getTime(): number {
      throw new TypeError("no time");
    },
  });
  // Arrays whose Symbol.iterator disagrees with their indices: oRPC's serializer reads indices.
  const hiddenCycle: unknown[] = [];
  hiddenCycle.push(hiddenCycle);
  Object.defineProperty(hiddenCycle, Symbol.iterator, { value: function* () {} });
  const iteratesItself: unknown[] = [1, 2];
  Object.defineProperty(iteratesItself, Symbol.iterator, {
    *value() {
      yield iteratesItself;
    },
  });
  let server: RunningServer;
  beforeAll(async () => {
    server = await start({
      databasePath: join(directory, "cyclic", "mastra.db"),
      workflows: {
        self: returning("self", circular),
        array: returning(
          "array",
          cyclic((self) => ({ list: [1, self] })),
        ),
        map: returning(
          "map",
          cyclic((self) => ({ map: new Map([["key", self]]) })),
        ),
        set: returning(
          "set",
          cyclic((self) => ({ set: new Set([self]) })),
        ),
        dag: returning("dag", { message: "x", first: shared, second: [shared] }),
        hiddenCycle: returning("hiddenCycle", hiddenCycle),
        iteratesItself: returning("iteratesItself", iteratesItself),
        encoder: returning("encoder", { date: unencodableDate }),
      },
    });
    // Warm up, so the timed calls below don't pay for the first Mastra run.
    await client(server).workflows.start({ workflowId: "dag", inputData: { message: "x" } });
  });

  // The bound stands in for a concurrent GET /health: oRPC's serializer found the cycle only by
  // recursing until the stack overflowed, blocking the server for 0.5 s to 6.5 s. Locally the
  // message and logged-once assertions are what pin the check; on a slow CI runner the bound is
  // what tells the fix from the stall.
  test.each(["self", "array", "map", "set", "hiddenCycle"])(
    "is rejected fast as a 500, logged once (%s)",
    async (workflowId) => {
      const logged = spyOn(server.mastra.getLogger(), "error");
      try {
        const started = performance.now();
        const { error } = await safe(
          client(server).workflows.start({ workflowId, inputData: { message: "x" } }),
        );
        expect(performance.now() - started).toBeLessThan(200);
        expect(error).toMatchObject({ code: "INTERNAL_SERVER_ERROR", status: 500 });
        expect(logged).toHaveBeenCalledTimes(1);
        const [message, fault] = logged.mock.calls[0]!;
        expect(message).toBe("hex: oRPC call failed");
        expect(fault).toBeInstanceOf(Error);
        expect((fault as Error).message).toBe(
          "hex: the output of workflows.start is cyclic or too deep",
        );
      } finally {
        logged.mockRestore();
      }
    },
  );

  test("is told apart from a value shared by two parents, which is returned as is", async () => {
    const started = await client(server).workflows.start({
      workflowId: "dag",
      inputData: { message: "x" },
    });
    expect(started).toEqual({
      runId: expect.any(String),
      status: "success",
      result: { message: "x", first: shared, second: [shared] } as typeof Message.Type,
    });
  });

  test("walks an array by index, as oRPC does, not by its own iterator", async () => {
    const started = await client(server).workflows.start({
      workflowId: "iteratesItself",
      inputData: { message: "x" },
    });
    expect(started).toEqual({
      runId: expect.any(String),
      status: "success",
      result: [1, 2] as unknown as typeof Message.Type,
    });
  });

  test("is told apart from an output the encoder rejects after the check, logged once", async () => {
    const logged = spyOn(server.mastra.getLogger(), "error");
    try {
      const { error } = await safe(
        client(server).workflows.start({ workflowId: "encoder", inputData: { message: "x" } }),
      );
      expect(error).toMatchObject({ code: "INTERNAL_SERVER_ERROR", status: 500 });
      expect(logged).toHaveBeenCalledTimes(1);
      const [message, fault] = logged.mock.calls[0]!;
      expect(message).toBe("hex: oRPC call failed");
      expect(fault).toEqual(new TypeError("no time"));
    } finally {
      logged.mockRestore();
    }
  });
});

test("keeps Mastra's default logger unless told otherwise", async () => {
  // Mastra's default logger writes errors with console.error; the noop logger writes nothing.
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  try {
    const server = await startServer({ ...dataFiles("logger"), port: 0 });
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
  test("closes a held-open request after the grace period and still shuts down", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const shutdown = Promise.withResolvers<void>();
    const server = await startServer({
      ...dataFiles("held"),
      port: 0,
      logger: false,
      workflows: { hang: gated("hang", entered.resolve, release.promise) },
      stopGraceMs: 200,
    });
    const originalShutdown = server.mastra.shutdown.bind(server.mastra);
    server.mastra.shutdown = async (...args) => {
      shutdown.resolve();
      return originalShutdown(...args);
    };
    try {
      const call = safe(
        client(server).workflows.start({ workflowId: "hang", inputData: { message: "hold" } }),
      );
      await entered.promise; // the request is in flight and the step is waiting

      const warn = spyOn(server.mastra.getLogger(), "warn");
      const started = performance.now();
      try {
        await server.stop();
        // The cut-off is logged, even without chat.
        expect(warn).toHaveBeenCalledWith(
          "hex: stop: requests and chat replies still running after 200 ms were cut off",
        );
      } finally {
        warn.mockRestore();
      }
      expect(performance.now() - started).toBeLessThan(3000);
      await shutdown.promise; // Mastra's shutdown ran after the forced close
      // The forced close ended the client's request: it fails instead of waiting.
      expect((await call).isSuccess).toBe(false);
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

  test("lets an in-flight request finish within the grace period", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = await startServer({
      ...dataFiles("in-flight"),
      port: 0,
      logger: false,
      workflows: { slow: gated("slow", entered.resolve, release.promise) },
    });
    const call = client(server).workflows.start({
      workflowId: "slow",
      inputData: { message: "finish me" },
    });
    await entered.promise;
    const stopping = server.stop();
    release.resolve();
    expect(await call).toMatchObject({ status: "success", result: { message: "finish me" } });
    await stopping;
  });

  test("rejects with a failing Mastra shutdown and still closes both stores", async () => {
    const closeLibSQL = spyOn(LibSQLStore.prototype, "close");
    const closeDuckDB = spyOn(DuckDBStore.prototype, "close");
    try {
      const server = await startServer({ ...dataFiles("shutdown-fails"), port: 0, logger: false });
      const failure = new Error("mastra shutdown failed");
      server.mastra.shutdown = async () => {
        throw failure;
      };
      closeLibSQL.mockClear();
      closeDuckDB.mockClear();
      await expect(server.stop()).rejects.toBe(failure);
      expect(closeLibSQL).toHaveBeenCalledTimes(1);
      expect(closeDuckDB).toHaveBeenCalledTimes(1);
    } finally {
      closeLibSQL.mockRestore();
      closeDuckDB.mockRestore();
    }
  });

  test("a failed start closes both stores and keeps the original error", async () => {
    const taken = await start({ databasePath: join(directory, "taken", "mastra.db") });
    const closeLibSQL = spyOn(LibSQLStore.prototype, "close");
    const closeDuckDB = spyOn(DuckDBStore.prototype, "close");
    try {
      const failed = startServer({
        ...dataFiles("port-in-use"),
        port: Number(taken.url.port),
        logger: false,
      });
      await expect(failed).rejects.toThrow(/EADDRINUSE|in use/i);
      expect(closeLibSQL).toHaveBeenCalledTimes(1);
      expect(closeDuckDB).toHaveBeenCalledTimes(1);
    } finally {
      closeLibSQL.mockRestore();
      closeDuckDB.mockRestore();
    }
  });
});
