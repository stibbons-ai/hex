import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { catalogViolations, readManifests } from "./check-catalog.ts";

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

describe("catalog policy (ADR 0003)", () => {
  test("accepts catalog: externals and workspace:* internals in every dependency kind", () => {
    const server = pkg("server", {
      dependencies: { "@hex/domain": "workspace:*", "@mastra/core": "catalog:" },
      devDependencies: { effect: "catalog:" },
      peerDependencies: { "@mastra/core": "catalog:" },
      optionalDependencies: { effect: "catalog:" },
    });
    expect(catalogViolations(root(), [domain, server])).toEqual([]);
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
      catalogViolations(root(), [pkg("domain", { dependencies: { effect: specifier } })]),
    ).toEqual([
      `packages/domain/package.json: dependencies.effect must use "catalog:", not "${specifier}"`,
    ]);
  });

  test("rejects a version in the root's own dependencies", () => {
    expect(catalogViolations(root({ devDependencies: { effect: "4.1.0" } }), [domain])).toEqual([
      'package.json: devDependencies.effect must use "catalog:", not "4.1.0"',
    ]);
  });

  test.each(["workspace:^", "workspace:packages/domain", "catalog:", "0.0.0"])(
    "rejects internal specifier %s",
    (specifier) => {
      const server = pkg("server", { peerDependencies: { "@hex/domain": specifier } });
      expect(catalogViolations(root(), [domain, server])).toEqual([
        `packages/server/package.json: peerDependencies.@hex/domain is a workspace package; use "workspace:*", not "${specifier}"`,
      ]);
    },
  );

  test("rejects catalog: for a name the catalog lacks", () => {
    expect(
      catalogViolations(root(), [pkg("domain", { dependencies: { hono: "catalog:" } })]),
    ).toEqual([
      'packages/domain/package.json: dependencies.hono uses "catalog:" but the root catalog has no hono',
    ]);
  });

  test("requires the catalog at the top level, not nested under workspaces or named", () => {
    const { catalog: _, ...withoutCatalog } = root().manifest;
    expect(
      catalogViolations(
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
      expect(catalogViolations(root({ catalog }), [])).toEqual([
        `package.json: catalog.@mastra/hono must be an exact version, not ${version}`,
      ]);
    },
  );

  test("reports malformed manifests instead of skipping them", () => {
    const failures = catalogViolations(root(), [
      pkg("domain", { dependencies: { effect: 4 } }),
      { path: "packages/broken/package.json", manifest: [] },
      { path: "packages/anonymous/package.json", manifest: {} },
    ]);
    expect(failures).toHaveLength(3);
    expect(failures[0]).toStartWith("packages/domain/package.json: invalid manifest:");
    expect(failures[1]).toStartWith("packages/broken/package.json: invalid manifest:");
    expect(failures[2]).toBe('packages/anonymous/package.json: workspace package needs a "name"');
  });

  test("the repository passes", async () => {
    const { root, packages } = await readManifests(fileURLToPath(new URL("../", import.meta.url)));
    expect(packages.map((entry) => entry.path)).toEqual([
      "packages/adapters/package.json",
      "packages/domain/package.json",
      "packages/eval-harness/package.json",
      "packages/server/package.json",
    ]);
    expect(catalogViolations(root, packages)).toEqual([]);
  });
});
