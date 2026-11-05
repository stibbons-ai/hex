import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EntityType } from "@mastra/core/observability";
import { DuckDBStore } from "@mastra/duckdb";

// The Studio entry reads its settings once, on import, from the environment `mastra start` gives
// it: the project root as MASTRA_PROJECT_ROOT, and the caller's own variables.
const SETTINGS = ["MASTRA_PROJECT_ROOT", "HEX_CONFIG", "HEX_DATA_DIR", "HEX_OUTBOX_DIR"] as const;
const saved = SETTINGS.map((name) => process.env[name]);
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "hex-studio-"));
  await writeFile(
    join(root, "hex.json"),
    JSON.stringify({ chat: { model: "openai/gpt-test", channels: {} } }),
  );
  process.env["MASTRA_PROJECT_ROOT"] = root;
  process.env["HEX_CONFIG"] = "hex.json";
  delete process.env["HEX_DATA_DIR"];
  delete process.env["HEX_OUTBOX_DIR"];
});

afterAll(async () => {
  SETTINGS.forEach((name, index) => {
    const value = saved[index];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  });
  await rm(root, { recursive: true, force: true });
});

test("Studio's Mastra is hex's: the chat agent without channels, and the Intake workflow traced into the project's data files", async () => {
  // Imported here, not statically: the entry reads the environment set above on import.
  const { mastra } = await import("../src/studio");
  const agent = mastra.getAgent("hex");
  expect(agent.getChannels()).toBeNull();

  const run = await mastra.getWorkflow("intake").createRun();
  const result = await run.start({
    inputData: {
      messageId: "<studio@x>",
      receivedAt: "2026-11-05T12:00:00.000Z",
      cidReferences: [],
      attachments: [],
    },
  });
  expect(result.status).toBe("success");
  await mastra.shutdown();

  // Relative to the project root, not to `.mastra/output` where `mastra start` runs the entry.
  const data = join(root, ".data");
  const duckdb = new DuckDBStore({ path: join(data, "observability.duckdb") });
  try {
    const { spans } = await duckdb.observability.listTraces({});
    expect(spans.map(({ entityType, entityName }) => ({ entityType, entityName }))).toEqual([
      { entityType: EntityType.WORKFLOW_RUN, entityName: "intake" },
    ]);
  } finally {
    await duckdb.close();
  }
  const libsql = new Database(join(data, "mastra.db"), { readonly: true });
  try {
    expect(libsql.query("SELECT message_id FROM hex_intake_ledger").all()).toEqual([
      { message_id: "studio@x" },
    ]);
  } finally {
    libsql.close();
  }
});
