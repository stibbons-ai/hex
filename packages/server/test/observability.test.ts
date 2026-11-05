import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EntityType } from "@mastra/core/observability";
import { type RunningServer, startServer } from "../src";
import { FakeChatAdapter } from "./fake-chat-adapter";
import { REPLY, mockModel } from "./mock-model";
import { client, echo, rootSpans, serverOptions, setEnv, stored } from "./server-helpers";

const DANIEL = "U0DANIEL";

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
  const run = await client(server).workflows.start({
    workflowId: "echo",
    inputData: { message: "hi" },
  });
  expect(run).toMatchObject({ status: "success" });
  await adapter.receive({ conversation: "dm-daniel", sender: DANIEL, text: "hello?" });
  expect(adapter.posted.map(({ text }) => text)).toEqual([REPLY]);
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
  const restoreEnv = setEnv({
    MASTRA_CLOUD_ACCESS_TOKEN: "test-token",
    MASTRA_PLATFORM_ACCESS_TOKEN: "test-token",
  });
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
    restoreEnv();
  }
});
