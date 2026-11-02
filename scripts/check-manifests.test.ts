import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestViolations, readManifests } from "./check-manifests.ts";

const root = (manifest: Record<string, unknown> = {}) => ({
  path: "package.json",
  manifest: {
    name: "hex",
    workspaces: ["packages/*"],
    catalog: { "@mastra/core": "1.80.0", effect: "^4.1.0" },
    devDependencies: { effect: "catalog:" },
    ...manifest,
  },
});
const pkg = (name: string, manifest: Record<string, unknown> = {}) => ({
  path: `packages/${name}/package.json`,
  manifest: { name: `@hex/${name}`, ...manifest },
});
const domain = pkg("domain", { dependencies: { effect: "catalog:" } });

describe("manifest policy", () => {
  test("accepts catalog: externals and workspace:* internals in every dependency kind", () => {
    const server = pkg("server", {
      dependencies: { "@hex/domain": "workspace:*", "@mastra/core": "catalog:" },
      devDependencies: { effect: "catalog:" },
      peerDependencies: { "@mastra/core": "catalog:" },
      optionalDependencies: { effect: "catalog:" },
    });
    expect(manifestViolations(root(), [domain, server])).toEqual([]);
  });

  test.each([
    "^4.1.0",
    "4.1.0",
    "~4.1.0",
    "*",
    "latest",
    "npm:effect@4.1.0",
    "workspace:*",
    "catalog:named",
    "file:../effect",
    "github:Effect-TS/effect",
  ])("rejects external specifier %s in a workspace package", (specifier) => {
    expect(
      manifestViolations(root(), [pkg("domain", { dependencies: { effect: specifier } })]),
    ).toEqual([
      `packages/domain/package.json: dependencies.effect must use "catalog:", not "${specifier}"`,
    ]);
  });

  test("rejects a version in the root's own dependencies", () => {
    expect(manifestViolations(root({ devDependencies: { effect: "4.1.0" } }), [domain])).toEqual([
      'package.json: devDependencies.effect must use "catalog:", not "4.1.0"',
    ]);
  });

  test.each(["workspace:^", "workspace:packages/domain", "catalog:", "0.0.0"])(
    "rejects internal specifier %s",
    (specifier) => {
      const server = pkg("server", { peerDependencies: { "@hex/domain": specifier } });
      expect(manifestViolations(root(), [domain, server])).toEqual([
        `packages/server/package.json: peerDependencies.@hex/domain is a workspace package; use "workspace:*", not "${specifier}"`,
      ]);
    },
  );

  // Inherited object keys such as `constructor` are not catalog entries either.
  test.each(["hono", "constructor", "toString"])(
    "rejects catalog: for %s, which the catalog lacks",
    (name) => {
      expect(
        manifestViolations(root(), [pkg("adapters", { dependencies: { [name]: "catalog:" } })]),
      ).toEqual([
        `packages/adapters/package.json: dependencies.${name} uses "catalog:" but the root catalog has no ${name}`,
      ]);
    },
  );

  test("requires the catalog at the top level, not nested under workspaces or named", () => {
    const { catalog: _, ...withoutCatalog } = root().manifest;
    expect(
      manifestViolations(
        {
          path: "package.json",
          manifest: {
            ...withoutCatalog,
            workspaces: { packages: ["packages/*"], catalog: { effect: "4.1.0" } },
            catalogs: { legacy: { effect: "3.0.0" } },
            devDependencies: {},
          },
        },
        [],
      ),
    ).toEqual([
      'package.json: missing top-level "catalog"',
      'package.json: named "catalogs" are not used',
      'package.json: catalog must be top-level, not nested under "workspaces"',
    ]);
  });

  test.each(["^1.80.0", "~1.80.0", ">=1.80.0", "1.x", "latest"])(
    "requires exact @mastra pins, rejecting %s",
    (version) => {
      const catalog = { "@mastra/hono": version, effect: "^4.1.0" };
      expect(manifestViolations(root({ catalog }), [])).toEqual([
        `package.json: catalog.@mastra/hono must be an exact version, not ${version}`,
      ]);
    },
  );

  test("reports malformed manifests instead of skipping them", () => {
    const failures = manifestViolations(root(), [
      pkg("domain", { dependencies: { effect: 4 } }),
      { path: "packages/broken/package.json", manifest: [] },
      { path: "packages/anonymous/package.json", manifest: {} },
    ]);
    expect(failures).toHaveLength(3);
    expect(failures[0]).toStartWith("packages/domain/package.json: invalid manifest:");
    expect(failures[1]).toStartWith("packages/broken/package.json: invalid manifest:");
    expect(failures[2]).toBe('packages/anonymous/package.json: workspace package needs a "name"');
  });

  test.each(["overrides", "resolutions"])("rejects %s in the root and in packages", (field) => {
    const pins = { [field]: { hono: "4.0.0" } };
    expect(manifestViolations(root(pins), [domain, pkg("server", pins)])).toEqual([
      `package.json: "${field}" is not allowed; versions live only in the root catalog`,
      `packages/server/package.json: "${field}" is not allowed; versions live only in the root catalog`,
    ]);
  });

  test("requires the telemetry opt-out on every script that runs code", () => {
    const scripts = {
      start: "MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 bun src/main.ts",
      check: "bun run lint && bun run test",
      bare: "bun src/main.ts",
      half: "DO_NOT_TRACK=1 bun src/main.ts",
      swapped: "DO_NOT_TRACK=1 MASTRA_TELEMETRY_DISABLED=1 bun src/main.ts",
      chained: "bun run lint && bun src/main.ts",
      tool: "oxlint .",
    };
    const message = 'must start with "MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1"';
    expect(manifestViolations(root({ scripts }), [pkg("server", { scripts })])).toEqual(
      ["package.json", "packages/server/package.json"].flatMap((path) =>
        ["bare", "half", "swapped", "chained", "tool"].map(
          (name) => `${path}: scripts.${name} ${message}`,
        ),
      ),
    );
  });

  test.each([
    [
      { dependencies: { effect: "catalog:", hono: "catalog:" } },
      "dependencies.effect, dependencies.hono",
    ],
    [
      { dependencies: { effect: "catalog:" }, devDependencies: { effect: "catalog:" } },
      "dependencies.effect, devDependencies.effect",
    ],
    [{ peerDependencies: { effect: "catalog:" } }, "peerDependencies.effect"],
    [{}, "nothing"],
  ])("the domain depends on effect only: rejects %j", (manifest, found) => {
    const catalog = { effect: "^4.1.0", hono: "4.13.14" };
    expect(manifestViolations(root({ catalog }), [pkg("domain", manifest)])).toEqual([
      `packages/domain/package.json: the domain depends on dependencies.effect only, not ${found}`,
    ]);
  });

  test("the repository passes", async () => {
    const { root, packages } = await readManifests(fileURLToPath(new URL("../", import.meta.url)));
    expect(packages.map((entry) => entry.path)).toEqual([
      "packages/adapters/package.json",
      "packages/domain/package.json",
      "packages/eval-harness/package.json",
      "packages/server/package.json",
    ]);
    expect(manifestViolations(root, packages)).toEqual([]);
  });
});

describe("reading manifests", () => {
  const directories: string[] = [];
  afterAll(async () => {
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
  });

  async function repository(rootManifest: unknown, packages: string[] = []) {
    const directory = await mkdtemp(join(tmpdir(), "hex-manifests-"));
    directories.push(directory);
    await writeFile(join(directory, "package.json"), JSON.stringify(rootManifest));
    for (const name of packages) {
      await mkdir(join(directory, "packages", name), { recursive: true });
      await writeFile(join(directory, "packages", name, "package.json"), JSON.stringify({ name }));
    }
    return directory;
  }

  test("fails when a workspace pattern matches no package", async () => {
    const directory = await repository({ workspaces: ["packages/*", "apps/*"] }, ["domain"]);
    await expect(readManifests(directory)).rejects.toThrow(
      'package.json: workspace pattern "apps/*" matches no package.json',
    );
  });

  test("fails when workspaces lists nothing", async () => {
    const directory = await repository({ workspaces: [] });
    await expect(readManifests(directory)).rejects.toThrow('"workspaces" lists no packages');
  });

  test("reports a malformed root with the policy message", async () => {
    const directory = await repository({ workspaces: "packages/*" });
    await expect(readManifests(directory)).rejects.toThrow(/^package\.json: invalid manifest: /);
  });
});
