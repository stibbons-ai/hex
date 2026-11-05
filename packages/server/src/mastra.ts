// The Mastra wiring shared by hex's server (`startServer`) and Mastra Studio (`studio/index.ts`),
// which `mastra build` bundles for Node: no Bun-only APIs here.
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createLocalStore } from "@hex/adapters";
import type { Agent } from "@mastra/core/agent";
import type { IMastraLogger } from "@mastra/core/logger";
import { Mastra } from "@mastra/core/mastra";
import { MastraCompositeStore } from "@mastra/core/storage";
import type { AnyWorkflow } from "@mastra/core/workflows";
import { DuckDBStore } from "@mastra/duckdb";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import { closeInOrder } from "./close";
import type { DataPaths } from "./paths";

/**
 * hex's Mastra storage: the LibSQL store for every domain (memory, workflow state, ...) except
 * observability, which lives in the DuckDB file. close() closes both files: the composite only
 * forwards to its LibSQL parent, since the DuckDB domain has no close() of its own. Its private
 * field keeps any other store (a plain LibSQL one, say) from passing for it.
 */
class HexStore extends MastraCompositeStore {
  readonly #duckdb: DuckDBStore;

  constructor(libsql: MastraCompositeStore, duckdb: DuckDBStore) {
    super({ id: "hex", default: libsql, domains: { observability: duckdb.observability } });
    this.#duckdb = duckdb;
  }

  override async close(): Promise<void> {
    await closeInOrder([() => super.close(), () => this.#duckdb.close()]);
  }
}

export type { HexStore };

/**
 * The store on the local files at `paths`, their directories created if missing. LibSQL opens its
 * file here, DuckDB on first use (`init()`) and then holds the file's lock, which only one process
 * can hold.
 */
export async function createHexStore({
  databasePath,
  observabilityPath,
}: Pick<DataPaths, "databasePath" | "observabilityPath">): Promise<HexStore> {
  // First: a failure here leaves no LibSQL handle open.
  await mkdir(dirname(observabilityPath), { recursive: true });
  const libsql = await createLocalStore(databasePath);
  return new HexStore(
    libsql,
    new DuckDBStore({ id: "hex-observability", path: observabilityPath }),
  );
}

export interface HexMastraOptions {
  storage: HexStore;
  /** Mastra's logger; omitted keeps Mastra's default. `false` silences it (tests only). */
  logger?: IMastraLogger | false | undefined;
  workflows?: Record<string, AnyWorkflow> | undefined;
  agents?: Record<string, Agent> | undefined;
}

/**
 * hex's Mastra on `storage`, tracing every agent and workflow run into the store's observability
 * domain (the DuckDB file) and nowhere else: the storage exporter is the only exporter.
 */
export function createHexMastra({ storage, logger, workflows, agents }: HexMastraOptions): Mastra {
  return new Mastra({
    storage,
    observability: new Observability({
      configs: { hex: { serviceName: "hex", exporters: [new MastraStorageExporter()] } },
    }),
    ...(logger === undefined ? {} : { logger }),
    ...(workflows ? { workflows } : {}),
    ...(agents ? { agents } : {}),
  });
}
