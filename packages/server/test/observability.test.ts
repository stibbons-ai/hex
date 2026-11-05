import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toMastraSchema } from "@hex/adapters";
import { EntityType } from "@mastra/core/observability";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { DuckDBStore } from "@mastra/duckdb";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { Schema } from "effect";
import { type RunningServer, contract, startServer } from "../src";
import { FakeChatAdapter } from "./fake-chat-adapter";
import { REPLY, mockModel } from "./mock-model";
import { serverOptions, stored } from "./server-helpers";

const DANIEL = "U0DANIEL";
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

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-observability-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** A server with the echo workflow and the chat agent on a fake channel, in `<directory>/<name>`. */
async function start(name: string) {
  const adapter = new FakeChatAdapter();
  const options = serverOptions(directory, name, {
    workflows: { echo },
    chat: { model: mockModel(), channels: { fake: { adapter, allowlist: [DANIEL] } } },
  });
  return { server: await startServer(options), adapter, options };
}

/** Runs the echo workflow through the API and has Daniel ask the chat agent something. */
async function runWorkflowAndAgent(server: RunningServer, adapter: FakeChatAdapter) {
  const api = createORPCClient<ContractRouterClient<typeof contract>>(
    new RPCLink({ url: new URL("/rpc", server.url) }),
  );
  const run = await api.workflows.start({ workflowId: "echo", inputData: { message: "hi" } });
  expect(run).toMatchObject({ status: "success" });
  await adapter.receive({ conversation: "dm-daniel", sender: DANIEL, text: "hello?" });
  expect(adapter.posted.map(({ text }) => text)).toEqual([REPLY]);
}

/** The root spans (one per trace) in the DuckDB file at `path`, read with a fresh store. */
async function rootSpans(path: string) {
  const duckdb = new DuckDBStore({ path });
  try {
    const { spans } = await duckdb.observability.listTraces({ pagination: { perPage: 100 } });
    return spans.map(({ entityType, entityName }) => ({ entityType, entityName }));
  } finally {
    await duckdb.close();
  }
}

test("traces of a workflow run and an agent call land in the DuckDB file; memory and workflow state stay in LibSQL", async () => {
  const { server, adapter, options } = await start("traces");
  await runWorkflowAndAgent(server, adapter);
  await server.stop();

  expect(await rootSpans(options.observabilityPath)).toEqual(
    expect.arrayContaining([
      { entityType: EntityType.WORKFLOW_RUN, entityName: "echo" },
      { entityType: EntityType.AGENT, entityName: "hex" },
    ]),
  );
  // The chat exchange and the workflow run are in the LibSQL file, no span is.
  expect((await stored(options.databasePath)).threads).toHaveLength(1);
  const libsql = new Database(options.databasePath, { readonly: true });
  try {
    const runs = libsql.query("SELECT workflow_name FROM mastra_workflow_snapshot").all();
    expect(runs).toEqual([{ workflow_name: "echo" }]);
    const spanTables = libsql
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%span%'")
      .all() as { name: string }[];
    for (const { name } of spanTables) {
      expect(libsql.query(`SELECT count(*) AS n FROM "${name}"`).get()).toEqual({ n: 0 });
    }
  } finally {
    libsql.close();
  }
});

test("traces go to storage only: no exporter calls out, even with platform credentials set", async () => {
  const credentials = ["MASTRA_CLOUD_ACCESS_TOKEN", "MASTRA_PLATFORM_ACCESS_TOKEN"] as const;
  const saved = credentials.map((name) => process.env[name]);
  for (const name of credentials) process.env[name] = "test-token";
  const fetchSpy = spyOn(globalThis, "fetch");
  try {
    const { server, adapter, options } = await start("no-export");
    await runWorkflowAndAgent(server, adapter);
    await server.stop();
    // The oRPC client's own calls to the server are the only requests.
    const outside = fetchSpy.mock.calls
      .map(([input]) => (input instanceof Request ? input.url : String(input)))
      .filter((url) => !url.startsWith(server.url.origin));
    expect(outside).toEqual([]);
    expect((await rootSpans(options.observabilityPath)).length).toBeGreaterThanOrEqual(2);
  } finally {
    fetchSpy.mockRestore();
    credentials.forEach((name, index) => {
      const value = saved[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
});
