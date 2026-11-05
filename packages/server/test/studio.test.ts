import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EntityType } from "@mastra/core/observability";
import { rootSpans, setEnv } from "./server-helpers";

let root: string;
let restoreEnv: () => void;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "hex-studio-"));
  // Daniel's config, channels included; Studio gets none of their secrets.
  const channels = {
    slack: { options: { mode: "socket" }, allowlist: [] },
    signal: { options: {}, allowlist: [] },
  };
  await writeFile(
    join(root, "hex.json"),
    JSON.stringify({ chat: { model: "openai/gpt-test", channels } }),
  );
  // The Studio entry reads its settings once, on import, from the environment `mastra start`
  // gives it: the project root as MASTRA_PROJECT_ROOT, and the caller's own variables.
  restoreEnv = setEnv({
    MASTRA_PROJECT_ROOT: root,
    HEX_CONFIG: "hex.json",
    HEX_DATA_DIR: undefined,
    HEX_OUTBOX_DIR: undefined,
    SLACK_APP_TOKEN: undefined,
    SLACK_BOT_TOKEN: undefined,
    SIGNAL_ACCOUNT: undefined,
    SIGNAL_CLI_URL: undefined,
  });
});

afterAll(async () => {
  restoreEnv();
  await rm(root, { recursive: true, force: true });
});

test("Studio's Mastra is hex's: the chat agent without channels, and the Intake workflow traced into the project's data files", async () => {
  // Imported here, not statically: the entry reads the environment set above on import.
  const { mastra } = await import("../src/studio");
  const agent = mastra.getAgent("hex");
  expect(agent.id).toBe("hex");
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
  // As hex's stop() does: shutdown's final trace flush reopens DuckDB.
  await mastra.getStorage()?.close();

  // Relative to the project root, not to `.mastra/output` where `mastra start` runs the entry.
  const data = join(root, ".data");
  expect(await rootSpans(join(data, "observability.duckdb"))).toEqual([
    { entityType: EntityType.WORKFLOW_RUN, entityName: "intake" },
  ]);
  const libsql = new Database(join(data, "mastra.db"), { readonly: true });
  try {
    expect(libsql.query("SELECT message_id FROM hex_intake_ledger").all()).toEqual([
      { message_id: "studio@x" },
    ]);
  } finally {
    libsql.close();
  }
});

test("the Studio entry imports no chat channel code: not hex's channels module, no adapter package", async () => {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "../src/studio/index.ts")],
    target: "bun",
    metafile: true,
    external: ["@duckdb/*", "libsql"],
  });
  expect(build.success).toBe(true);
  const inputs = Object.entries(build.metafile?.inputs ?? {});
  expect(inputs.map(([path]) => path)).toContainEqual(
    expect.stringMatching(/src\/studio\/index\.ts$/),
  );
  // Every import edge, also to modules tree-shaking dropped: `mastra build` installs what any
  // module of the graph imports.
  const imported = inputs.flatMap(([path, { imports }]) => [
    path,
    ...imports.flatMap((edge) => [edge.path, edge.original ?? ""]),
  ]);
  expect(
    imported.filter((path) =>
      /src\/channels\.ts$|^\.\/channels$|@chat-adapter\/|@stibbons\/chat-adapter-signal/.test(path),
    ),
  ).toEqual([]);
}, 60_000);
