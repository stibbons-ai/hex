// Adapted from stibbons-ai/iconograph `scripts/build-server.ts` (MIT): hex has no ONNX, sharp or
// HEIC externals, and DuckDB's native addon instead.
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readBunLock } from "./bun-lock.ts";
import { externalsManifest, type Target } from "./externals-manifest.ts";

/**
 * Packages the server bundle leaves external (ADR 0002, ADR 0005): the loaders of the native
 * addons, LibSQL's (`libsql`, under `@libsql/client`) and DuckDB's (`@duckdb/node-api`, under
 * `@mastra/duckdb`). Each brings its platform's binding package along when installed.
 */
export const SERVER_EXTERNALS = ["libsql", "@duckdb/node-api"];

/** The bundle's entry points in packages/server/src; each becomes `<name>.js` in the output. */
const ENTRYPOINTS = ["main.ts", "smoke.ts", "healthcheck.ts"];

const help = `Build the server for one platform (ADR 0005)

Usage:
  bun scripts/build-server.ts [--os OS] [--cpu CPU] [--libc glibc|musl] [--out DIR]

Bundles packages/server's server (main.js), smoke test (smoke.js) and health
check (healthcheck.js) with Bun, leaving ${SERVER_EXTERNALS.join(" and ")} external,
then installs only those externals, production-only, from a manifest generated
from bun.lock and pruned to the target platform (default: this machine), and
copies Mastra's model-capability metadata beside them. Run DIR/main.js with bun.
Default DIR: dist/server.
`;

const root = fileURLToPath(new URL("../", import.meta.url));
const serverSource = join(root, "packages/server/src");

function hostLibc(): Target["libc"] {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } };
  return process.platform === "linux" && !report?.header?.glibcVersionRuntime ? "musl" : "glibc";
}

async function buildServer(out: string, target: Target) {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const build = await Bun.build({
    entrypoints: ENTRYPOINTS.map((file) => join(serverSource, file)),
    outdir: out,
    target: "bun",
    external: SERVER_EXTERNALS,
    // The server and the smoke test share most of their code: one chunk instead of two copies.
    splitting: true,
  });
  if (!build.success) throw new AggregateError(build.logs, "Bundling the server failed");

  const manifest = externalsManifest(await readBunLock(root), SERVER_EXTERNALS, target);
  await Bun.write(join(out, "package.json"), `${JSON.stringify(manifest.packageJson, null, 2)}\n`);
  await Bun.write(join(out, "bun.lock"), `${JSON.stringify(manifest.lock, null, 2)}\n`);
  // Exactly the locked versions and integrity hashes; no lifecycle scripts.
  const install = Bun.spawn(
    [
      process.execPath,
      "install",
      "--production",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--linker=hoisted",
      `--os=${target.os}`,
      `--cpu=${target.cpu}`,
    ],
    { cwd: out, stdout: "inherit", stderr: "inherit" },
  );
  if ((await install.exited) !== 0) throw new Error(`Installing the externals in ${out} failed`);

  // Mastra resolves model capabilities from JSON beside its own package.json, which the
  // bundle no longer has; without them every capability is silently undefined.
  const mastraCore = dirname(Bun.resolveSync("@mastra/core/package.json", serverSource));
  const mastraOut = join(out, "node_modules/@mastra/core");
  await mkdir(join(mastraOut, "dist"), { recursive: true });
  await cp(join(mastraCore, "package.json"), join(mastraOut, "package.json"));
  await cp(join(mastraCore, "dist/capabilities"), join(mastraOut, "dist/capabilities"), {
    recursive: true,
  });
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      os: { type: "string", default: process.platform },
      cpu: { type: "string", default: process.arch },
      libc: { type: "string", default: hostLibc() },
      out: { type: "string", default: join(root, "dist/server") },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(help);
  } else {
    if (values.libc !== "glibc" && values.libc !== "musl") {
      throw new Error(`--libc must be glibc or musl, got ${values.libc}`);
    }
    await buildServer(values.out, { os: values.os, cpu: values.cpu, libc: values.libc });
    console.log(`Built ${values.out} for ${values.os}-${values.cpu}-${values.libc}`);
  }
}
