// Adapted from stibbons-ai/iconograph `scripts/externals-manifest.test.ts` (MIT).
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { type BunLock, readBunLock } from "./bun-lock.ts";
import { externalsManifest } from "./externals-manifest.ts";
import { SERVER_EXTERNALS, SERVER_NATIVES } from "./build-server.ts";

const entry = (identity: string, metadata: Record<string, unknown> = {}) =>
  [identity, "", metadata, `sha512-${identity}`] as BunLock["packages"][string];

/**
 * A bun.lock shaped like the repository's: LibSQL's natives named by libc, DuckDB's carrying a
 * `libc` field, and a nested `detect-libc` version.
 */
const lock: BunLock = {
  lockfileVersion: 2,
  configVersion: 1,
  workspaces: {
    "": { name: "app", devDependencies: { typescript: "7.0.2" } },
    "packages/server": { name: "@app/server", dependencies: { "@mastra/duckdb": "catalog:" } },
  },
  packages: {
    "@app/server": entry("@app/server@workspace:packages/server"),
    typescript: entry("typescript@7.0.2"),
    libsql: entry("libsql@0.5.29", {
      dependencies: { "@neon-rs/load": "^0.0.4", "detect-libc": "2.0.2" },
      optionalDependencies: {
        "@libsql/linux-arm64-gnu": "0.5.29",
        "@libsql/linux-arm64-musl": "0.5.29",
        "@libsql/linux-x64-gnu": "0.5.29",
        "@libsql/darwin-arm64": "0.5.29",
      },
      os: ["darwin", "linux", "win32"],
      cpu: ["x64", "arm64", "wasm32", "arm"],
    }),
    "@neon-rs/load": entry("@neon-rs/load@0.0.4"),
    "detect-libc": entry("detect-libc@2.0.2"),
    "@libsql/linux-arm64-gnu": entry("@libsql/linux-arm64-gnu@0.5.29", {
      os: "linux",
      cpu: "arm64",
    }),
    "@libsql/linux-arm64-musl": entry("@libsql/linux-arm64-musl@0.5.29", {
      os: "linux",
      cpu: "arm64",
    }),
    "@libsql/linux-x64-gnu": entry("@libsql/linux-x64-gnu@0.5.29", { os: "linux", cpu: "x64" }),
    "@libsql/darwin-arm64": entry("@libsql/darwin-arm64@0.5.29", { os: "darwin", cpu: "arm64" }),
    "@duckdb/node-api": entry("@duckdb/node-api@1.5.2-r.2", {
      dependencies: { "@duckdb/node-bindings": "1.5.2-r.2" },
    }),
    "@duckdb/node-bindings": entry("@duckdb/node-bindings@1.5.2-r.2", {
      dependencies: { "detect-libc": "^2.1.2" },
      optionalDependencies: {
        "@duckdb/node-bindings-linux-arm64": "1.5.2-r.2",
        "@duckdb/node-bindings-linux-arm64-musl": "1.5.2-r.2",
        "@duckdb/node-bindings-darwin-arm64": "1.5.2-r.2",
      },
    }),
    "@duckdb/node-bindings/detect-libc": entry("detect-libc@2.1.2"),
    // The glibc build's name doesn't say so; only its `libc` field does.
    "@duckdb/node-bindings-linux-arm64": entry("@duckdb/node-bindings-linux-arm64@1.5.2-r.2", {
      os: "linux",
      cpu: "arm64",
      libc: "glibc",
    }),
    "@duckdb/node-bindings-linux-arm64-musl": entry(
      "@duckdb/node-bindings-linux-arm64-musl@1.5.2-r.2",
      { os: "linux", cpu: "arm64", libc: "musl" },
    ),
    "@duckdb/node-bindings-darwin-arm64": entry("@duckdb/node-bindings-darwin-arm64@1.5.2-r.2", {
      os: "darwin",
      cpu: "arm64",
    }),
  },
};

const linuxArm64Glibc = { os: "linux", cpu: "arm64", libc: "glibc" } as const;

describe("externalsManifest", () => {
  test("keeps the externals' locked closure for linux-arm64-glibc, with only that platform's native packages", () => {
    const { packageJson, lock: subset } = externalsManifest(
      lock,
      ["libsql", "@duckdb/node-api"],
      linuxArm64Glibc,
      ["libsql", "@duckdb/node-bindings"],
    );
    expect(packageJson.dependencies).toEqual({
      libsql: "0.5.29",
      "@duckdb/node-api": "1.5.2-r.2",
    });
    expect(Object.keys(subset.packages)).toEqual([
      "@duckdb/node-api",
      "@duckdb/node-bindings",
      "@duckdb/node-bindings-linux-arm64",
      "@duckdb/node-bindings/detect-libc",
      "@libsql/linux-arm64-gnu",
      "@neon-rs/load",
      "detect-libc",
      "libsql",
    ]);
    // Entries are copied verbatim, so the install checks the repository's integrity hashes.
    for (const [key, value] of Object.entries(subset.packages)) {
      expect(value).toEqual(lock.packages[key]!);
    }
    // Only the externals: no workspaces, dev tools or catalogs of the repository.
    expect(subset).toEqual({
      lockfileVersion: 2,
      configVersion: 1,
      workspaces: { "": { name: packageJson.name, dependencies: packageJson.dependencies } },
      packages: subset.packages,
    });
  });

  test("picks musl packages by name or by their libc field, and x64 by cpu", () => {
    const musl = externalsManifest(
      lock,
      ["libsql", "@duckdb/node-api"],
      { ...linuxArm64Glibc, libc: "musl" },
      ["libsql", "@duckdb/node-bindings"],
    );
    expect(Object.keys(musl.lock.packages).filter((key) => /linux/.test(key))).toEqual([
      "@duckdb/node-bindings-linux-arm64-musl",
      "@libsql/linux-arm64-musl",
    ]);
    const x64 = externalsManifest(lock, ["libsql"], { ...linuxArm64Glibc, cpu: "x64" }, ["libsql"]);
    expect(Object.keys(x64.lock.packages)).toEqual([
      "@libsql/linux-x64-gnu",
      "@neon-rs/load",
      "detect-libc",
      "libsql",
    ]);
  });

  test("fails on an external the target can't run or a dependency the lock lacks", () => {
    expect(() =>
      externalsManifest(lock, ["libsql"], { os: "freebsd", cpu: "x64", libc: "glibc" }, []),
    ).toThrow("External libsql doesn't support freebsd-x64-glibc");
    expect(() => externalsManifest(lock, ["sharp"], linuxArm64Glibc, [])).toThrow(
      "External sharp is not in bun.lock",
    );
    const { "@neon-rs/load": _, ...withoutLoad } = lock.packages;
    expect(() =>
      externalsManifest({ ...lock, packages: withoutLoad }, ["libsql"], linuxArm64Glibc, []),
    ).toThrow("libsql depends on @neon-rs/load, which is not in bun.lock");
    // Platform and dependency metadata are only read from registry entries.
    expect(() =>
      externalsManifest(
        {
          ...lock,
          packages: {
            ...lock.packages,
            // A git entry keeps its metadata at [1], not where registry entries do.
            "@neon-rs/load": ["@neon-rs/load@git+ssh://git@host/load.git#abc", {}, "abc"],
          },
        },
        ["libsql"],
        linuxArm64Glibc,
        [],
      ),
    ).toThrow(
      "@neon-rs/load (@neon-rs/load@git+ssh://git@host/load.git#abc) isn't a registry package",
    );
  });

  test("fails when a named native package has no binding for the target, instead of failing at startup", () => {
    // The fixture has DuckDB bindings for linux-arm64 and darwin-arm64 only.
    const x64 = { ...linuxArm64Glibc, cpu: "x64" };
    expect(() =>
      externalsManifest(lock, ["@duckdb/node-api"], x64, ["@duckdb/node-bindings"]),
    ).toThrow("@duckdb/node-bindings has no native binding for linux-x64-glibc");
    // A renamed or dropped native package fails too, instead of going unchecked.
    expect(() =>
      externalsManifest(lock, ["libsql"], linuxArm64Glibc, ["@duckdb/node-bindings"]),
    ).toThrow("Native package @duckdb/node-bindings isn't among the externals");
  });

  test("leaves out another package's platform-only optional dependency (an fsevents) without failing", () => {
    const watcher: BunLock = {
      ...lock,
      packages: {
        watcher: entry("watcher@1.0.0", { optionalDependencies: { fsevents: "2.3.3" } }),
        fsevents: entry("fsevents@2.3.3", { os: "darwin" }),
      },
    };
    expect(
      Object.keys(externalsManifest(watcher, ["watcher"], linuxArm64Glibc, []).lock.packages),
    ).toEqual(["watcher"]);
  });

  test("the repository's lock yields one LibSQL and one DuckDB binding for the image's platform", async () => {
    const repository = await readBunLock(fileURLToPath(new URL("../", import.meta.url)));
    const { packages } = externalsManifest(
      repository,
      SERVER_EXTERNALS,
      linuxArm64Glibc,
      SERVER_NATIVES,
    ).lock;
    expect(Object.keys(packages).filter((key) => /^@(libsql|duckdb)\/.*linux/.test(key))).toEqual([
      "@duckdb/node-bindings-linux-arm64",
      "@libsql/linux-arm64-gnu",
    ]);
  });
});
