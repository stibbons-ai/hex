import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));

// Real tsc on the real domain tsconfig: the probe has to sit inside packages/domain/src for the
// include globs to pick it up, so it gets a unique directory and is removed afterwards.
test("the domain type-check covers every scanned extension and has no Bun or Node globals", async () => {
  const probe = join(repository, "packages/domain/src", `probe-${crypto.randomUUID()}`);
  const extensions = ["ts", "tsx", "mts", "cts", "js", "mjs", "cjs"];
  try {
    await mkdir(probe);
    for (const extension of extensions) {
      await writeFile(
        join(probe, `leak-${extension}.${extension}`),
        "export const leak = Bun.version;\n",
      );
    }
    const tsc = Bun.spawn(["bun", "run", "typecheck:domain"], {
      cwd: repository,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(tsc.stdout).text();
    expect(await tsc.exited).not.toBe(0);
    for (const extension of extensions) {
      expect(output).toMatch(
        new RegExp(String.raw`leak-${extension}\.${extension}\(1,21\): error TS2868`),
      );
    }
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
});
