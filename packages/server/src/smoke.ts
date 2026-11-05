/**
 * The built image's smoke test (issue #5): the bundle with its external packages, as shipped.
 * Each check prints one JSON line; the first failure exits 1 with its error on stderr. Opens
 * throwaway databases in a temporary directory, never the data volume. Adapted from
 * stibbons-ai/iconograph `packages/server/src/smoke.ts` (MIT).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalStore } from "@hex/adapters";
import { modelSupportsStructuredOutput } from "@mastra/core/llm";
import { DuckDBStore } from "@mastra/duckdb";

const directory = await mkdtemp(join(tmpdir(), "hex-smoke-"));

/**
 * `use(store)`, then the store closed. When `use` fails, its error is the one thrown; a close
 * failing after it is logged, so it can't hide the cause.
 */
async function thenClose<S extends { close(): Promise<void> }, T>(
  store: S,
  use: (store: S) => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await use(store);
  } catch (error) {
    await store.close().catch((closeError: unknown) => {
      console.error("closing the store after the failure also failed:", closeError);
    });
    throw error;
  }
  await store.close();
  return result;
}

const checks: Record<string, () => Promise<object>> = {
  // Mastra reads these from JSON beside its package.json, which bundling breaks silently.
  "mastra-capabilities": async () => {
    // The shipped capability data lists gpt-4.1 with structured output; a missing or truncated
    // file gives false or undefined.
    const supported = modelSupportsStructuredOutput("openai/gpt-4.1");
    if (supported !== true) throw new Error(`capability resolved to ${supported}`);
    return { "openai/gpt-4.1": { structuredOutput: supported } };
  },
  // LibSQL's native addon: the store creates its tables in a new file.
  "libsql-opens": async () =>
    thenClose(await createLocalStore(join(directory, "mastra.db")), async (store) => {
      await store.init();
      return {};
    }),
  // DuckDB's native addon: the observability tables are created and read back.
  "duckdb-opens": () =>
    thenClose(new DuckDBStore({ path: join(directory, "observability.duckdb") }), async (store) => {
      await store.init();
      const { spans } = await store.observability.listTraces({});
      return { traces: spans.length };
    }),
};

let failed = false;
for (const [check, run] of Object.entries(checks)) {
  try {
    console.log(JSON.stringify({ check, ok: true, ...(await run()) }));
  } catch (error) {
    console.log(JSON.stringify({ check, ok: false }));
    console.error(error);
    failed = true;
    break;
  }
}
await rm(directory, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
