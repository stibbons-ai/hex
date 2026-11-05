import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syntheticFolder, writeFixtureSet } from "../src/synthetic/generate.ts";
import { repoRoot } from "./paths.ts";

async function readTree(folder: string): Promise<Map<string, Buffer>> {
  const names = (await readdir(folder)).sort();
  const files = new Map<string, Buffer>();
  for (const name of names)
    files.set(name, Buffer.from(await Bun.file(join(folder, name)).bytes()));
  return files;
}

/** Names of the files in `a` whose bytes differ from the same file in `b`. */
const differing = (a: Map<string, Buffer>, b: Map<string, Buffer>) =>
  [...a].filter(([name, bytes]) => !bytes.equals(b.get(name)!)).map(([name]) => name);

describe("synthetic fixture generator", () => {
  const temps: string[] = [];
  afterAll(() => Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true }))));
  const temp = async () => {
    const dir = await mkdtemp(join(tmpdir(), "hex-fixtures-"));
    temps.push(dir);
    return dir;
  };

  test("writes byte-identical trees on every run, equal to the committed set", async () => {
    const [viaScript, viaFunction] = [await temp(), await temp()];
    const run = Bun.spawnSync(["bun", "run", "fixtures:generate", viaScript], { cwd: repoRoot });
    expect(run.exitCode).toBe(0);
    await writeFixtureSet(viaFunction);

    const first = await readTree(viaScript);
    const second = await readTree(viaFunction);
    const committed = await readTree(syntheticFolder);
    expect([...first.keys()]).toEqual([...second.keys()]);
    expect([...first.keys()]).toEqual([...committed.keys()]);
    expect(differing(first, second)).toEqual([]);
    // Drift: the committed files are exactly what the generator produces (rerun `bun run fixtures:generate`).
    expect(differing(first, committed)).toEqual([]);
  });

  test("regenerating replaces stale Intakes but keeps unrelated files", async () => {
    const dir = await temp();
    await Bun.write(join(dir, "99-stale.eml"), "stale");
    await Bun.write(join(dir, "notes.md"), "kept");
    await writeFixtureSet(dir);
    const names = await readdir(dir);
    expect(names).not.toContain("99-stale.eml");
    expect(names).toContain("notes.md");
    expect(names).toContain("expected.json");
  });
});
