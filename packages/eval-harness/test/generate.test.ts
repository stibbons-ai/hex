import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFixtureSet } from "../src/synthetic/generate.ts";
import { repoRoot, syntheticFolder } from "./paths.ts";

async function readTree(folder: string): Promise<Map<string, Uint8Array>> {
  const names = (await readdir(folder)).sort();
  const files = new Map<string, Uint8Array>();
  for (const name of names) files.set(name, await Bun.file(join(folder, name)).bytes());
  return files;
}

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
    for (const [name, bytes] of first) {
      expect({ name, same: Buffer.from(bytes).equals(second.get(name)!) }).toEqual({
        name,
        same: true,
      });
      // Drift: the committed files are exactly what the generator produces (rerun `bun run fixtures:generate`).
      expect({ name, same: Buffer.from(bytes).equals(committed.get(name)!) }).toEqual({
        name,
        same: true,
      });
    }
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
