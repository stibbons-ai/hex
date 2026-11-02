import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { domainImportViolations, readDomainSources } from "./domain-imports.ts";

const domain = "/repo/packages/domain";
const check = (source: string, path = "src/index.ts") =>
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
    expect(check('import { x } from "../src/x";', "test/x.test.ts")).toEqual([]);
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
    ['import { x } from "../../adapters/src/index.ts";', "leaves the domain package"],
    ['import { x } from "../../domain-evil/x";', "leaves the domain package"],
    ["const m = await import(name);", "computed import() or require()"],
    ["const m = require(name);", "computed import() or require()"],
  ])("rejects %s", (source, message) => {
    const failures = check(source);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toStartWith("src/index.ts: ");
    expect(failures[0]).toContain(message);
  });

  test("the repository's domain package passes", async () => {
    const directory = fileURLToPath(new URL("../packages/domain", import.meta.url));
    const sources = await readDomainSources(directory);
    expect(sources.map((file) => file.path)).toContain("src/index.ts");
    expect(domainImportViolations(directory, sources)).toEqual([]);
  });
});
