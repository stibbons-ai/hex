import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { domainImportViolations, readDomainSources } from "./domain-imports.ts";

const domain = "/repo/packages/domain/src";
const check = (source: string, path = "index.ts") =>
  domainImportViolations(domain, [{ path, source }]);

describe("domain purity (allow-list)", () => {
  test("allows effect, effect/* and relative imports inside the domain", () => {
    expect(
      check(
        [
          'import { Schema } from "effect";',
          'import type { Option } from "effect/Option";',
          'import { a } from "./a";',
          'export * from "../src/b.ts";',
          'export { c } from "./nested/c";',
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(check('import { a } from "../a";', "nested/y.ts")).toEqual([]);
  });

  test.each([
    ['import { readFile } from "fs";', '"fs" is not effect'],
    ['import { join } from "node:path";', '"node:path" is not effect'],
    ['import { Pool } from "pg";', '"pg" is not effect'],
    ['import "bun:test";', '"bun:test" is not effect'],
    ['import type { Mastra } from "@mastra/core";', '"@mastra/core" is not effect'],
    ['export { x } from "@hex/adapters";', '"@hex/adapters" is not effect'],
    ['import { x } from "effectful";', '"effectful" is not effect'],
    ['const fs = await import("fs");', '"fs" is not effect'],
    ['const fs = require("fs");', '"fs" is not effect'],
    ['type T = import("hono").Hono;', '"hono" is not effect'],
    ['import { x } from "../../adapters/src/index.ts";', "leaves the domain source"],
    ['import { x } from "../../domain-evil/x";', "leaves the domain source"],
    ["const m = await import(name);", "computed import() or require()"],
    ["const m = require(name);", "computed import() or require()"],
    ['import { hostname } from /* why */ "os";', '"os" is not effect'],
    ['import type { Pool } from // line comment\n "pg";', '"pg" is not effect'],
    ['const os = await import(/* lazy */ "os");', '"os" is not effect'],
    ['const fs = await import ( "fs" );', '"fs" is not effect'],
    ['/// <reference types="bun" />\nexport const v = Bun.version;', "triple-slash reference"],
    ['  ///<reference lib="dom" />', "triple-slash reference"],
    ['export const a = 1;\n\n/// <reference types="bun" />', "triple-slash reference"],
    ["const m = await import(`fs`);", "computed import() or require()"],
  ])("rejects %s", (source, message) => {
    const failures = check(source);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toStartWith("index.ts: ");
    expect(failures[0]).toContain(message);
  });

  test("a string-literal import() split over lines is not a computed import", () => {
    expect(check('const e = await import(\n  "effect"\n);')).toEqual([]);
  });

  test("reads files in dot directories too", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hex-domain-"));
    try {
      await mkdir(join(directory, ".hidden"), { recursive: true });
      await writeFile(join(directory, ".hidden", "probe.ts"), 'import "fs";\n');
      await mkdir(join(directory, "sub", ".hidden"), { recursive: true });
      await writeFile(join(directory, "sub", ".hidden", "x.ts"), 'import "os";\n');
      const sources = await readDomainSources(directory);
      expect(sources.map((file) => file.path)).toEqual([".hidden/probe.ts", "sub/.hidden/x.ts"]);
      expect(domainImportViolations(directory, sources)).toEqual([
        ".hidden/probe.ts: dot directories and files are not type-checked; move it",
        '.hidden/probe.ts: "fs" is not effect; the domain imports Effect only',
        "sub/.hidden/x.ts: dot directories and files are not type-checked; move it",
        'sub/.hidden/x.ts: "os" is not effect; the domain imports Effect only',
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("the repository's domain package passes", async () => {
    const directory = fileURLToPath(new URL("../packages/domain/src", import.meta.url));
    const sources = await readDomainSources(directory);
    expect(sources.map((file) => file.path)).toContain("index.ts");
    expect(domainImportViolations(directory, sources)).toEqual([]);
  });
});
