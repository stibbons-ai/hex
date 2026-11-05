import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EntityType } from "@mastra/core/observability";

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-bundle-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** The installed package directory of `name`, resolved as the module at URL `from` would. */
function packageDirectory(name: string, from: string): string {
  return dirname(fileURLToPath(import.meta.resolve(`${name}/package.json`, from)));
}

test("DuckDB stores traces under the Bun JS bundle, its native addon kept external", async () => {
  const out = join(directory, "out");
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "bundle-entry.ts")],
    outdir: out,
    target: "bun",
    // The native addons and their loaders stay out of the bundle; they are installed next to it.
    // DuckDB's (traces) is under test; LibSQL's (everything else) has to come along too.
    external: ["@duckdb/*", "libsql"],
  });
  expect(build.success).toBe(true);
  expect(await readdir(out)).toEqual(["bundle-entry.js"]);

  // Install the external packages beside the bundle, as a deployment would: @duckdb/node-api and
  // libsql, each bringing its platform binding along. Nothing else from node_modules is reachable.
  const libsqlClient = import.meta.resolve("@libsql/client", import.meta.resolve("@mastra/libsql"));
  const installed = {
    "@duckdb/node-api": packageDirectory("@duckdb/node-api", import.meta.resolve("@mastra/duckdb")),
    libsql: packageDirectory("libsql", libsqlClient),
  };
  await mkdir(join(out, "node_modules", "@duckdb"), { recursive: true });
  for (const [name, path] of Object.entries(installed)) {
    await symlink(path, join(out, "node_modules", name));
  }

  const bundled = Bun.spawn(["bun", join(out, "bundle-entry.js"), join(directory, "data")], {
    cwd: directory,
    env: { ...process.env, MASTRA_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(bundled.stdout).text(),
    new Response(bundled.stderr).text(),
    bundled.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual({
    status: "success",
    traces: [{ entityType: EntityType.WORKFLOW_RUN, entityName: "bundled" }],
  });
}, 60_000);
