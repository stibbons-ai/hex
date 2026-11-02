import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";

const Dependencies = Schema.optionalKey(Schema.Record(Schema.String, Schema.String));

/** The package.json fields the catalog policy reads; other fields pass through unchecked. */
const Manifest = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  workspaces: Schema.optionalKey(
    Schema.Union([
      Schema.Array(Schema.String),
      Schema.Struct({
        packages: Schema.Array(Schema.String),
        catalog: Schema.optionalKey(Schema.Unknown),
        catalogs: Schema.optionalKey(Schema.Unknown),
      }),
    ]),
  ),
  catalog: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  catalogs: Schema.optionalKey(Schema.Unknown),
  dependencies: Dependencies,
  devDependencies: Dependencies,
  optionalDependencies: Dependencies,
  peerDependencies: Dependencies,
});
type Manifest = typeof Manifest.Type;
const decodeManifest = Schema.decodeUnknownSync(Manifest);

/** A package.json as read from disk, before its shape is trusted. */
export interface ManifestFile {
  path: string;
  manifest: unknown;
}

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * ADR 0003: external versions live only in the root package.json's top-level `catalog`;
 * every manifest (root included) depends on externals via `catalog:` and on workspace
 * packages via `workspace:*`. ADR 0002: `@mastra/*` catalog entries are exact versions.
 * Returns one message per violation.
 */
export function catalogViolations(root: ManifestFile, packages: readonly ManifestFile[]): string[] {
  const failures: string[] = [];
  const decoded: { path: string; manifest: Manifest }[] = [];
  for (const { path, manifest } of [root, ...packages]) {
    try {
      decoded.push({ path, manifest: decodeManifest(manifest, { errors: "all" }) });
    } catch (error) {
      failures.push(`${path}: invalid manifest: ${(error as Error).message}`);
    }
  }
  const rootManifest = decoded.find((entry) => entry.path === root.path)?.manifest;
  if (!rootManifest) return failures;

  const { catalog, catalogs, workspaces } = rootManifest;
  if (!catalog) failures.push(`${root.path}: missing top-level "catalog"`);
  if (catalogs !== undefined) failures.push(`${root.path}: named "catalogs" are not used`);
  if (
    workspaces &&
    "packages" in workspaces &&
    ("catalog" in workspaces || "catalogs" in workspaces)
  ) {
    failures.push(`${root.path}: catalog must be top-level, not nested under "workspaces"`);
  }
  for (const [name, version] of Object.entries(catalog ?? {})) {
    if (name.startsWith("@mastra/") && !exactVersion.test(version)) {
      failures.push(`${root.path}: catalog.${name} must be an exact version, not ${version}`);
    }
  }

  const workspaceNames = new Set<string>();
  for (const { path, manifest } of decoded) {
    if (path === root.path) continue;
    if (manifest.name === undefined) failures.push(`${path}: workspace package needs a "name"`);
    else workspaceNames.add(manifest.name);
  }

  for (const { path, manifest } of decoded) {
    for (const field of dependencyFields) {
      for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
        const where = `${path}: ${field}.${name}`;
        if (workspaceNames.has(name)) {
          if (specifier !== "workspace:*") {
            failures.push(`${where} is a workspace package; use "workspace:*", not "${specifier}"`);
          }
        } else if (specifier !== "catalog:") {
          failures.push(`${where} must use "catalog:", not "${specifier}"`);
        } else if (!catalog || !(name in catalog)) {
          failures.push(`${where} uses "catalog:" but the root catalog has no ${name}`);
        }
      }
    }
  }
  return failures;
}

/** Reads the root manifest and every manifest its `workspaces` globs match. */
export async function readManifests(
  rootDirectory: string,
): Promise<{ root: ManifestFile; packages: ManifestFile[] }> {
  const read = async (path: string): Promise<ManifestFile> => ({
    path,
    manifest: JSON.parse(await readFile(join(rootDirectory, path), "utf8")),
  });
  const root = await read("package.json");
  const { workspaces = [] } = decodeManifest(root.manifest);
  const patterns = "packages" in workspaces ? workspaces.packages : workspaces;
  const paths = new Set<string>();
  for (const pattern of patterns) {
    const glob = new Bun.Glob(`${pattern}/package.json`);
    for await (const path of glob.scan({ cwd: rootDirectory, onlyFiles: true })) paths.add(path);
  }
  const packages = await Promise.all([...paths].sort().map(read));
  return { root, packages };
}

if (import.meta.main) {
  const { root, packages } = await readManifests(fileURLToPath(new URL("../", import.meta.url)));
  if (packages.length === 0) throw new Error("No workspace packages found");
  const failures = catalogViolations(root, packages);
  if (failures.length > 0) {
    throw new Error(`Dependency catalog policy failed (ADR 0003):\n${failures.join("\n")}`);
  }
  console.log(`Catalog policy passed for the root and ${packages.length} workspace packages.`);
}
