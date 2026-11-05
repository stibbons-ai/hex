import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Result, Schema } from "effect";

const StringMap = Schema.optionalKey(Schema.Record(Schema.String, Schema.String));

/** The package.json fields the policy reads; other fields are ignored. */
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
  scripts: StringMap,
  catalog: StringMap,
  catalogs: Schema.optionalKey(Schema.Unknown),
  overrides: Schema.optionalKey(Schema.Unknown),
  resolutions: Schema.optionalKey(Schema.Unknown),
  dependencies: StringMap,
  devDependencies: StringMap,
  optionalDependencies: StringMap,
  peerDependencies: StringMap,
});
const decodeManifest = Schema.decodeUnknownResult(Manifest);

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
const telemetryOff = "MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 ";
/** One plain shell word: no operators, substitutions, quotes, redirections or globs. */
const plainWord = String.raw`[\w./:@=+-]+`;
const plainCommand = new RegExp(String.raw`^${plainWord}(?: ${plainWord})*$`);
const chainedScript = new RegExp(String.raw`^bun run ([\w:-]+)(?: ${plainWord})*$`);
const telemetryVariable = /\b(?:MASTRA_TELEMETRY_DISABLED|DO_NOT_TRACK)\b/;
/** `bunx` (or `bun x`), its flags (a flag may take a number), then the package it runs. */
const bunxCommand = /^(?:bunx|bun x)((?: -[\w-]+(?: \d+)?)*) (\S+)/;
const versionedPackage = /^(@?[^@]+)@(.+)$/;
const releaseAgeFlag = / --minimum-release-age (\d+)\b/;
/** bunfig.toml's `minimumReleaseAge`, which doesn't reach the packages bunx installs. */
const minimumReleaseAge = 259_200;

/** The package spec a prefixed script runs with bunx, and its flags; undefined for other scripts. */
function bunxRun(script: string): { flags: string; spec: string } | undefined {
  if (!script.startsWith(telemetryOff)) return undefined;
  const [, flags = "", spec] = bunxCommand.exec(script.slice(telemetryOff.length)) ?? [];
  return spec === undefined ? undefined : { flags, spec };
}

/**
 * Telemetry stays off in every script (issue #2). A script is either
 * - a chain of this manifest's own scripts, `bun run <name> [args] && …`, each checked in turn, or
 * - the opt-out prefix followed by exactly one command made of plain words (letters, digits and
 *   `_ . / : @ = + -`, separated by single spaces): no `&`, `|`, `;`, `$( )`, backticks,
 *   parentheses, quotes or redirections.
 *
 * Neither form may mention the telemetry variables again (`DO_NOT_TRACK=0`, `env -u DO_NOT_TRACK`).
 * A package run with `bunx` sits outside the catalog, the lockfile and `bunfig.toml`, so it names
 * an exact version (`bunx mastra@1.36.0`), checked like a catalog pin, and passes
 * `--minimum-release-age` of at least the bunfig's three days for the dependencies bunx resolves.
 */
export function scriptViolation(
  script: string,
  scriptNames: ReadonlySet<string>,
): string | undefined {
  const reset = "must not set or unset the telemetry variables again";
  if (script.startsWith(telemetryOff)) {
    const command = script.slice(telemetryOff.length);
    if (telemetryVariable.test(command)) return reset;
    if (!plainCommand.test(command)) {
      return "must be one command of plain words after the telemetry opt-out (no &, |, ;, $( ), backticks, parentheses, quotes or redirections)";
    }
    const bunx = bunxRun(script);
    if (bunx) {
      const version = versionedPackage.exec(bunx.spec)?.[2];
      if (!(version && exactVersion.test(version))) {
        return `runs bunx ${bunx.spec}, which must name an exact version (<package>@<x.y.z>)`;
      }
      if (Number(releaseAgeFlag.exec(bunx.flags)?.[1] ?? 0) < minimumReleaseAge) {
        return `runs bunx ${bunx.spec} without --minimum-release-age ${minimumReleaseAge} or more (bunfig.toml doesn't apply to bunx's install)`;
      }
    }
    return undefined;
  }
  const steps = script.split(" && ").map((step) => chainedScript.exec(step)?.[1]);
  if (steps.some((name) => name === undefined)) {
    return `must start with "${telemetryOff.trim()}" or only chain this manifest's scripts with "bun run <name>"`;
  }
  if (telemetryVariable.test(script)) return reset;
  const unknown = steps.filter((name) => !scriptNames.has(name!));
  return unknown.length > 0
    ? `chains "bun run ${unknown.join('", "bun run ')}", which is not a script in this manifest`
    : undefined;
}

/**
 * - ADR 0003: external versions live only in the root package.json's top-level `catalog`;
 *   every manifest (root included) depends on externals via `catalog:` and on workspace
 *   packages via `workspace:*`; no `overrides` or `resolutions`, which would pin versions
 *   outside the catalog.
 * - Issue #2: every script keeps Mastra and Bun telemetry off (`scriptViolation`).
 * - ADR 0002: `@mastra/*` catalog entries are exact versions.
 * - `@hex/domain` depends on `effect` and nothing else.
 *
 * Returns one message per violation.
 */
export function manifestViolations(
  root: ManifestFile,
  packages: readonly ManifestFile[],
): string[] {
  const failures: string[] = [];
  const decode = ({ path, manifest }: ManifestFile) => {
    const result = decodeManifest(manifest, { errors: "all" });
    if (Result.isSuccess(result)) return [{ path, manifest: result.success }];
    failures.push(`${path}: invalid manifest: ${result.failure.message}`);
    return [];
  };
  const [decodedRoot] = decode(root);
  const workspaceManifests = packages.flatMap(decode);
  if (!decodedRoot) return failures;

  const { catalog = {}, catalogs, workspaces } = decodedRoot.manifest;
  if (!decodedRoot.manifest.catalog) failures.push(`${root.path}: missing top-level "catalog"`);
  if (catalogs !== undefined) failures.push(`${root.path}: named "catalogs" are not used`);
  if (workspaces && ("catalog" in workspaces || "catalogs" in workspaces)) {
    failures.push(`${root.path}: catalog must be top-level, not nested under "workspaces"`);
  }
  for (const [name, version] of Object.entries(catalog)) {
    if (name.startsWith("@mastra/") && !exactVersion.test(version)) {
      failures.push(`${root.path}: catalog.${name} must be an exact version, not ${version}`);
    }
  }

  const workspaceNames = new Set<string>();
  for (const { path, manifest } of workspaceManifests) {
    if (manifest.name === undefined) failures.push(`${path}: workspace package needs a "name"`);
    else workspaceNames.add(manifest.name);
  }

  for (const { path, manifest } of [decodedRoot, ...workspaceManifests]) {
    for (const field of ["overrides", "resolutions"] as const) {
      if (manifest[field] !== undefined) {
        failures.push(`${path}: "${field}" is not allowed; versions live only in the root catalog`);
      }
    }
    const scripts = manifest.scripts ?? {};
    const scriptNames = new Set(Object.keys(scripts));
    for (const [name, script] of Object.entries(scripts)) {
      const violation = scriptViolation(script, scriptNames);
      if (violation) failures.push(`${path}: scripts.${name} ${violation}`);
    }
    // Scripts that run the same package with bunx (a build and its start) run the same version.
    const bunxPins = new Map<string, Set<string>>();
    for (const script of Object.values(scripts)) {
      const [, packageName, version] = versionedPackage.exec(bunxRun(script)?.spec ?? "") ?? [];
      if (packageName && version) {
        bunxPins.set(packageName, (bunxPins.get(packageName) ?? new Set()).add(version));
      }
    }
    for (const [packageName, versions] of bunxPins) {
      if (versions.size > 1) {
        failures.push(
          `${path}: scripts run bunx ${packageName} at different versions: ${[...versions].join(", ")}`,
        );
      }
    }
    for (const field of dependencyFields) {
      for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
        const where = `${path}: ${field}.${name}`;
        if (workspaceNames.has(name)) {
          if (specifier !== "workspace:*") {
            failures.push(`${where} is a workspace package; use "workspace:*", not "${specifier}"`);
          }
        } else if (specifier !== "catalog:") {
          failures.push(`${where} must use "catalog:", not "${specifier}"`);
        } else if (!Object.hasOwn(catalog, name)) {
          failures.push(`${where} uses "catalog:" but the root catalog has no ${name}`);
        }
      }
    }
    if (manifest.name === "@hex/domain") {
      const dependencies = dependencyFields.flatMap((field) =>
        Object.keys(manifest[field] ?? {}).map((name) => `${field}.${name}`),
      );
      if (dependencies.join() !== "dependencies.effect") {
        failures.push(
          `${path}: the domain depends on dependencies.effect only, not ${dependencies.join(", ") || "nothing"}`,
        );
      }
    }
  }
  return failures;
}

/**
 * Reads the root manifest and every manifest its `workspaces` globs match. Throws with a policy
 * message naming the file when a manifest isn't readable JSON, the root is malformed, or a
 * pattern matches no package.
 */
export async function readManifests(
  rootDirectory: string,
): Promise<{ root: ManifestFile; packages: ManifestFile[] }> {
  const read = async (path: string): Promise<ManifestFile> => {
    const manifest: unknown = await Bun.file(join(rootDirectory, path))
      .json()
      .catch((error: Error) => {
        throw new Error(`${path}: not readable JSON: ${error.message}`);
      });
    return { path, manifest };
  };
  const root = await read("package.json");
  const decoded = decodeManifest(root.manifest, { errors: "all" });
  if (Result.isFailure(decoded)) {
    throw new Error(`package.json: invalid manifest: ${decoded.failure.message}`);
  }
  const { workspaces = [] } = decoded.success;
  const patterns = "packages" in workspaces ? workspaces.packages : workspaces;
  if (patterns.length === 0) throw new Error('package.json: "workspaces" lists no packages');
  const paths = new Set<string>();
  for (const pattern of patterns) {
    let matched = false;
    const glob = new Bun.Glob(`${pattern}/package.json`);
    for await (const path of glob.scan({ cwd: rootDirectory, onlyFiles: true })) {
      matched = true;
      paths.add(path);
    }
    if (!matched) {
      throw new Error(`package.json: workspace pattern "${pattern}" matches no package.json`);
    }
  }
  const packages = await Promise.all([...paths].sort().map(read));
  return { root, packages };
}

if (import.meta.main) {
  const failures = await readManifests(fileURLToPath(new URL("../", import.meta.url))).then(
    ({ root, packages }) => manifestViolations(root, packages),
    (error: Error) => [error.message],
  );
  if (failures.length > 0) {
    console.error(`Manifest policy failed (ADR 0003, issue #2):\n${failures.join("\n")}`);
    process.exit(1);
  }
  console.log("Manifest policy passed for the root and every workspace package.");
}
