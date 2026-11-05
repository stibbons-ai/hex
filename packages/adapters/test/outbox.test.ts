import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { Outbox, outboxLayer } from "../src";

let directory: string;
let outboxes = 0;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-outbox-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** A fresh, empty Outbox root (not created yet) and a `file` bound to it. */
function freshOutbox() {
  const root = join(directory, `outbox-${outboxes++}`);
  const layer = outboxLayer(root);
  const file = (folder: string, name: string, content: string) =>
    Effect.runPromiseExit(
      Outbox.use((outbox) => outbox.file(folder, name, new TextEncoder().encode(content))).pipe(
        Effect.provide(layer),
      ),
    );
  return { root, file };
}

/** Every file under `root`, relative, with its content. */
async function contents(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  const files: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[path.slice(root.length + 1)] = await readFile(path, "utf8");
  }
  return files;
}

const success = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
  return exit.value;
};

describe("Outbox", () => {
  test("files into the folder, creating it, and leaves no .partial behind", async () => {
    const { root, file } = freshOutbox();
    expect(success(await file("2026-11/ER", "Rechnung.pdf", "pdf"))).toBe(
      "2026-11/ER/Rechnung.pdf",
    );
    expect(await contents(root)).toEqual({ "2026-11/ER/Rechnung.pdf": "pdf" });
  });

  test("never overwrites: an existing file keeps its content, the new one gets (1), (2)", async () => {
    const { root, file } = freshOutbox();
    success(await file("2026-11/ER", "Rechnung.pdf", "first"));
    expect(success(await file("2026-11/ER", "Rechnung.pdf", "second"))).toBe(
      "2026-11/ER/Rechnung (1).pdf",
    );
    expect(success(await file("2026-11/ER", "Rechnung.pdf", "third"))).toBe(
      "2026-11/ER/Rechnung (2).pdf",
    );
    expect(await contents(root)).toEqual({
      "2026-11/ER/Rechnung.pdf": "first",
      "2026-11/ER/Rechnung (1).pdf": "second",
      "2026-11/ER/Rechnung (2).pdf": "third",
    });
  });

  test("a directory with the target name counts as taken", async () => {
    const { root, file } = freshOutbox();
    await mkdir(join(root, "2026-11/ER/scan.pdf"), { recursive: true });
    expect(success(await file("2026-11/ER", "scan.pdf", "x"))).toBe("2026-11/ER/scan (1).pdf");
  });

  test("a leftover .partial of the same name is left alone", async () => {
    const { root, file } = freshOutbox();
    await mkdir(join(root, "2026-11/ER"), { recursive: true });
    await writeFile(join(root, "2026-11/ER/scan.pdf.partial"), "leftover");
    expect(success(await file("2026-11/ER", "scan.pdf", "new"))).toBe("2026-11/ER/scan.pdf");
    expect(await contents(root)).toEqual({
      "2026-11/ER/scan.pdf.partial": "leftover",
      "2026-11/ER/scan.pdf": "new",
    });
  });

  test("concurrent writes of the same name all survive under distinct names", async () => {
    const { root, file } = freshOutbox();
    const count = 20;
    const paths = await Promise.all(
      Array.from({ length: count }, async (_, index) =>
        success(await file("2026-11/ER", "same.pdf", `content ${index}`)),
      ),
    );
    expect(new Set(paths).size).toBe(count);
    const files = await contents(root);
    expect(Object.keys(files)).toHaveLength(count);
    // Each write's returned path holds exactly what that write sent.
    paths.forEach((path, index) => expect(files[path]).toBe(`content ${index}`));
  });

  test.each(["../../x.pdf", "a/b.pdf", "a\\b.pdf", "", ".", "..", "x.pdf.partial", "x\0.pdf"])(
    "refuses the unsafe name %j and writes nothing",
    async (name) => {
      const { root, file } = freshOutbox();
      const exit = await file("2026-11/ER", name, "x");
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain("not a safe file name in the Outbox");
      // Nothing anywhere in the test tree, inside this Outbox or outside it.
      expect(await contents(root)).toEqual({});
      expect(Object.keys(await contents(directory)).filter((path) => /x\.pdf/.test(path))).toEqual(
        [],
      );
    },
  );

  test("refuses a folder outside the Outbox", async () => {
    const { file } = freshOutbox();
    const exit = await file("../escaped", "x.pdf", "x");
    expect(Exit.isFailure(exit)).toBe(true);
    expect(Object.keys(await contents(directory)).filter((path) => /x\.pdf/.test(path))).toEqual(
      [],
    );
  });
});
