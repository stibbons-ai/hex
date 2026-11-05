import { afterAll, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
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
  const realMail =
    "From: Bank <bank@example.com>\r\nMessage-ID: <abc@bank.example>\r\n\r\nreal\r\n";

  /** Every entry of `dir` with its content (files) or kind (anything else), to prove nothing changed. */
  async function snapshot(dir: string): Promise<Record<string, string>> {
    const entries: Record<string, string> = {};
    for (const name of (await readdir(dir)).sort()) {
      const stats = await lstat(join(dir, name));
      if (stats.isFile()) entries[name] = await Bun.file(join(dir, name)).text();
      else if (stats.isDirectory()) entries[name] = "<dir>";
      else entries[name] = "<link>";
    }
    return entries;
  }

  test("writes into a missing folder", async () => {
    const dir = join(await temp(), "new", "set");
    await writeFixtureSet(dir);
    expect(await readdir(dir)).toContain("expected.json");
  });

  test("regenerates the committed folder in place: drops stale generated Intakes, same bytes again", async () => {
    const dir = await temp();
    await writeFixtureSet(dir);
    const first = await readTree(dir);
    await Bun.write(join(dir, "99-stale.eml"), generatedEml("99-stale"));
    await writeFixtureSet(dir, dir);
    const second = await readTree(dir);
    expect([...second.keys()]).toEqual([...first.keys()]);
    expect(differing(first, second)).toEqual([]);
  });

  test.each([
    [
      "labels listing absent mails",
      "expected.json",
      '{"intakes":[{"file":"sparkasse-okt.eml","description":"REAL","documents":[]}]}',
    ],
    ["empty labels", "expected.json", '{"intakes":[]}'],
    ["a real .eml", "my-real-mail.eml", realMail],
    ["a generated-looking .eml", "01-x.eml", generatedEml("01-x")],
  ])(
    "refuses a non-empty folder elsewhere holding %s and leaves it untouched",
    async (_, name, content) => {
      const dir = await temp();
      await Bun.write(join(dir, name), content);
      const before = await snapshot(dir);
      await expect(writeFixtureSet(dir)).rejects.toThrow(dir);
      expect(await snapshot(dir)).toEqual(before);
    },
  );

  test("refuses a path that is a file", async () => {
    const file = join(await temp(), "set");
    await Bun.write(file, "not a folder");
    await expect(writeFixtureSet(file)).rejects.toThrow(file);
    expect(await Bun.file(file).text()).toBe("not a folder");
  });

  test.each([
    ["a real .eml", "01-bank-statement.eml", (path: string) => Bun.write(path, realMail)],
    ["an upper-case .EML", "01-scan.EML", (path: string) => Bun.write(path, realMail)],
    [
      "an .eml with the synthetic id only in its body",
      "01-notes.eml",
      (path: string) =>
        Bun.write(path, `${realMail}Message-ID: <synthetic-x@hex-fixtures.example>\r\n`),
    ],
    [
      "an .eml without a blank line after its headers",
      "01-notes.eml",
      (path: string) =>
        Bun.write(path, "my notes\nMessage-ID: <synthetic-x@hex-fixtures.example>\n"),
    ],
    ["a directory named like an Intake", "01-x.eml", (path: string) => mkdir(path)],
    ["a symlinked .eml", "01-link.eml", (path: string) => symlink("01-de-pdf-invoice.eml", path)],
    ["an unrelated file", "notes.md", (path: string) => Bun.write(path, "kept")],
  ])("refuses the committed folder holding %s and leaves it untouched", async (_, name, add) => {
    const dir = await temp();
    await writeFixtureSet(dir);
    await add(join(dir, name));
    const before = await snapshot(dir);
    await expect(writeFixtureSet(dir, dir)).rejects.toThrow(name);
    expect(await snapshot(dir)).toEqual(before);
  });
});
