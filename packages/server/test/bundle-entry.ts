// Entry of the bundle test (bundle.test.ts): runs a workflow through hex's Mastra wiring with the
// trace stored in the DuckDB file at argv[2], then prints the root spans read back from that file.
import { join } from "node:path";
import { toMastraSchema } from "@hex/adapters";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { DuckDBStore } from "@mastra/duckdb";
import { Schema } from "effect";
import { createHexMastra, createHexStore } from "../src/mastra";

const directory = process.argv[2];
if (!directory) throw new Error("usage: bundle-entry <data directory>");
const observabilityPath = join(directory, "observability.duckdb");
const Message = toMastraSchema(Schema.Struct({ message: Schema.String }));
const echo = createWorkflow({ id: "bundled", inputSchema: Message, outputSchema: Message })
  .then(
    createStep({
      id: "bundled",
      inputSchema: Message,
      outputSchema: Message,
      execute: async ({ inputData }) => inputData,
    }),
  )
  .commit();

const mastra = createHexMastra({
  storage: await createHexStore({ databasePath: join(directory, "mastra.db"), observabilityPath }),
  logger: false,
  workflows: { echo },
});
const run = await mastra.getWorkflow("echo").createRun();
const result = await run.start({ inputData: { message: "bundled" } });
await mastra.shutdown();

const duckdb = new DuckDBStore({ path: observabilityPath });
const { spans } = await duckdb.observability.listTraces({});
await duckdb.close();
console.log(
  JSON.stringify({
    status: result.status,
    traces: spans.map(({ entityType, entityName }) => ({ entityType, entityName })),
  }),
);
