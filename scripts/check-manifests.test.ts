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
      lint: "MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 oxlint --deny-warnings .",
      check: "bun run lint && bun run start",
      fix: "bun run lint -- --fix",
      bare: "bun src/main.ts",
      half: "DO_NOT_TRACK=1 bun src/main.ts",
      swapped: "DO_NOT_TRACK=1 MASTRA_TELEMETRY_DISABLED=1 bun src/main.ts",
      chained: "bun run lint && bun src/main.ts",
    };
    const message =
      'must start with "MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1" or only chain this manifest\'s scripts with "bun run <name>"';
    expect(manifestViolations(root({ scripts }), [pkg("server", { scripts })])).toEqual(
      ["package.json", "packages/server/package.json"].flatMap((path) =>
        ["bare", "half", "swapped", "chained"].map((name) => `${path}: scripts.${name} ${message}`),
      ),
    );
  });

  test.each(["bun run lint -- $(bun x.ts)", "bun run lint -- `bun x.ts`", "bun run lint -- 'x'"])(
    "rejects a chain whose arguments aren't plain words: %s",
    (script) => {
      const scripts = { lint: "MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 oxlint .", run: script };
      expect(manifestViolations(root({ scripts }), [])).toEqual([
        `package.json: scripts.run must start with "MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1" or only chain this manifest's scripts with "bun run <name>"`,
      ]);
    },
  );

  test.each(["oxlint", "check:all", "lint && bun run oxlint"])(
    "rejects chaining bun run %s when it is not a script in the same manifest",
    (chain) => {
      const scripts = {
        lint: "MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 oxlint .",
        check: `bun run ${chain}`,
      };
      expect(manifestViolations(root({ scripts }), [])).toEqual([
        expect.stringMatching(
          /^package\.json: scripts\.check chains "bun run .*", which is not a script in this manifest$/,
        ),
      ]);
    },
  );

  test.each([
    "bun a.ts && bun b.ts",
    "bun a.ts || bun b.ts",
    "bun a.ts; bun b.ts",
    "echo x | bun b.ts",
    "bun a.ts\nbun b.ts",
    "bun a.ts & bun b.ts",
    "bun $(echo a.ts)",
    "bun `echo a.ts`",
    "(bun a.ts)",
    "bun a.ts > out.log",
    "cat <(bun a.ts)",
    'bun "a.ts"',
    "bun  a.ts",
  ])("rejects a prefixed script that isn't one command of plain words: %j", (command) => {
    const scripts = { run: `MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 ${command}` };
    expect(manifestViolations(root({ scripts }), [])).toEqual([
      "package.json: scripts.run must be one command of plain words after the telemetry opt-out (no &, |, ;, $( ), backticks, parentheses, quotes or redirections)",
    ]);
  });

  test.each([
    "MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 MASTRA_TELEMETRY_DISABLED=0 bun a.ts",
    "MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 DO_NOT_TRACK=0 bun a.ts",
    "MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 env DO_NOT_TRACK= bun a.ts",
    "MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 env -u DO_NOT_TRACK bun a.ts",
    "bun run lint -- DO_NOT_TRACK=0",
  ])("rejects a script that sets or unsets telemetry again: %j", (script) => {
    const scripts = { lint: "MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 oxlint .", run: script };
    expect(manifestViolations(root({ scripts }), [])).toEqual([
      "package.json: scripts.run must not set or unset the telemetry variables again",
    ]);
  });

  const prefix = "MASTRA_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 ";

  test.each([
    ["bunx --minimum-release-age 259200 mastra dev", "mastra"],
    ["bunx --minimum-release-age 259200 mastra@latest dev", "mastra@latest"],
    ["bunx --minimum-release-age 259200 mastra@1.36 dev", "mastra@1.36"],
    ["bunx --bun --minimum-release-age 259200 mastra@1 dev", "mastra@1"],
    ["bun x --minimum-release-age 259200 @mastra/cli dev", "@mastra/cli"],
  ])("rejects bunx without an exact version: %j", (command, spec) => {
    const scripts = { studio: `${prefix}${command}` };
    expect(manifestViolations(root({ scripts }), [])).toEqual([
      `package.json: scripts.studio runs bunx ${spec}, which must name an exact version (<package>@<x.y.z>)`,
    ]);
  });

  test.each([
    "bunx mastra@1.36.0 dev",
    "bunx --minimum-release-age 86400 mastra@1.36.0 dev",
    "bunx --minimum-release-age mastra@1.36.0 dev",
  ])("rejects bunx without a 3-day minimum release age: %j", (command) => {
    const scripts = { studio: `${prefix}${command}` };
    expect(manifestViolations(root({ scripts }), [])).toEqual([
      expect.stringMatching(
        /^package\.json: scripts\.studio runs bunx mastra@1\.36\.0 without --minimum-release-age 259200 or more/,
      ),
    ]);
  });

  test.each([
    "bunx --minimum-release-age 259200 mastra@1.36.0 dev",
    "bunx --bun --minimum-release-age 604800 @mastra/cli@1.36.0-alpha.1 dev",
  ])("accepts bunx pinned exactly, with the release age: %j", (command) => {
    const scripts = { studio: `${prefix}${command}` };
    expect(manifestViolations(root({ scripts }), [])).toEqual([]);
  });

  test("scripts running the same package with bunx run the same version", () => {
    const bunx = `${prefix}bunx --minimum-release-age 259200`;
    const scripts = {
      "studio:build": `${bunx} mastra@1.36.0 build`,
      "studio:start": `${bunx} mastra@1.37.0 start`,
      other: `${bunx} cowsay@1.6.0 hi`,
    };
    expect(manifestViolations(root({ scripts }), [])).toEqual([
      "package.json: scripts run bunx mastra at different versions: 1.36.0, 1.37.0",
    ]);
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

  test("names the package.json that isn't readable JSON", async () => {
    const directory = await repository({ workspaces: ["packages/*"] }, ["domain"]);
    await writeFile(join(directory, "packages", "domain", "package.json"), "{ not json");
    await expect(readManifests(directory)).rejects.toThrow(
      /^packages\/domain\/package\.json: not readable JSON: /,
    );
    await writeFile(join(directory, "package.json"), "");
    await expect(readManifests(directory)).rejects.toThrow(/^package\.json: not readable JSON: /);
  });
});
