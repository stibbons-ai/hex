import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
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
    const run = Bun.spawnSync(["bun", "run", "fixtures:generate", viaScript], {
      cwd: repoRoot,
      stderr: "pipe",
    });
    expect({
      exitCode: run.exitCode,
      stderr: run.exitCode === 0 ? "" : run.stderr.toString(),
    }).toEqual({
      exitCode: 0,
      stderr: "",
    });
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

  /** An `.eml` as this generator writes them, recognisable by its `Message-ID`. */
  const generatedEml = (slug: string) =>
    `From: x <x@x.example>\r\nMessage-ID: <synthetic-${slug}@hex-fixtures.example>\r\n\r\nbody\r\n`;

  test("regenerating replaces earlier generated Intakes but keeps unrelated files", async () => {
    const dir = await temp();
    await Bun.write(join(dir, "99-stale.eml"), generatedEml("99-stale"));
    await Bun.write(join(dir, "notes.md"), "kept");
    await writeFixtureSet(dir);
    const names = await readdir(dir);
    expect(names).not.toContain("99-stale.eml");
    expect(names).toContain("notes.md");
    expect(names).toContain("expected.json");
  });

  const realMail =
    "From: Bank <bank@example.com>\r\nMessage-ID: <abc@bank.example>\r\n\r\nreal\r\n";
  test.each([
    ["a real .eml", "my-real-mail.eml", realMail],
    ["a real .eml named like the set", "01-bank-statement.eml", realMail],
    ["an upper-case .EML", "01-scan.EML", realMail],
    ["an Expected.json with foreign content", "Expected.json", "REAL LABELS"],
    ["an expected.json that is not JSON", "expected.json", "{"],
  ])("refuses a folder holding %s and leaves it untouched", async (_, name, content) => {
    const dir = await temp();
    await Bun.write(join(dir, name), content);
    await Bun.write(join(dir, "02-generated.eml"), generatedEml("02-generated"));
    await expect(writeFixtureSet(dir)).rejects.toThrow(name);
    expect((await readdir(dir)).sort()).toEqual(["02-generated.eml", name].sort());
    expect(await Bun.file(join(dir, name)).text()).toBe(content);
  });

  test("refuses labels that list a real .eml", async () => {
    const dir = await temp();
    const labels = JSON.stringify({ intakes: [{ file: "01-real.eml", documents: [] }] });
    await Bun.write(join(dir, "expected.json"), labels);
    await Bun.write(join(dir, "01-real.eml"), realMail);
    await expect(writeFixtureSet(dir)).rejects.toThrow("expected.json (lists 01-real.eml");
    expect(await Bun.file(join(dir, "expected.json")).text()).toBe(labels);
    expect(await Bun.file(join(dir, "01-real.eml")).text()).toBe(realMail);
  });

  test("refuses a directory named like an Intake, deleting nothing", async () => {
    const dir = await temp();
    await mkdir(join(dir, "01-x.eml"));
    await Bun.write(join(dir, "02-generated.eml"), generatedEml("02-generated"));
    await expect(writeFixtureSet(dir)).rejects.toThrow("01-x.eml (not a regular file)");
    expect((await readdir(dir)).sort()).toEqual(["01-x.eml", "02-generated.eml"]);
  });
});
