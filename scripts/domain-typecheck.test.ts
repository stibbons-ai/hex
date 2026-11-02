import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const extensions = ["ts", "tsx", "mts", "cts", "js", "mjs", "cjs"];
let copy: string;
let output: string;
let exitCode: number;

// Real tsc on copies of the root and domain tsconfigs in a temp tree with the same layout, so the
// probes never touch packages/domain/src.
beforeAll(async () => {
  copy = await mkdtemp(join(tmpdir(), "hex-domain-typecheck-"));
  const source = join(copy, "packages/domain/src");
  await mkdir(source, { recursive: true });
  await copyFile(join(repository, "tsconfig.json"), join(copy, "tsconfig.json"));
  await copyFile(
    join(repository, "packages/domain/tsconfig.json"),
    join(copy, "packages/domain/tsconfig.json"),
  );
  for (const extension of extensions) {
    await writeFile(
      join(source, `leak-${extension}.${extension}`),
      "export const version = Bun.version;\nexport const environment = process.env;\n",
    );
  }
  const tsc = Bun.spawn(
    [join(repository, "node_modules/.bin/tsc"), "--noEmit", "-p", join(copy, "packages/domain")],
    { cwd: copy, stdout: "pipe", stderr: "pipe" },
  );
  output = await new Response(tsc.stdout).text();
  exitCode = await tsc.exited;
});

afterAll(async () => {
  await rm(copy, { recursive: true, force: true });
});

test.each(extensions)(
  "the domain type-check sees .%s files and rejects Bun and Node globals",
  (extension) => {
    expect(exitCode).not.toBe(0);
    const file = String.raw`leak-${extension}\.${extension}`;
    expect(output).toMatch(
      new RegExp(String.raw`${file}\(1,24\): error TS\d+: Cannot find name 'Bun'`),
    );
    expect(output).toMatch(
      new RegExp(String.raw`${file}\(2,28\): error TS\d+: Cannot find name 'process'`),
    );
  },
);
