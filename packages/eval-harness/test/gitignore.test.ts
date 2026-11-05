/** Real fixtures and eval results must never be committed by accident (issue #11). */
import { describe, expect, test } from "bun:test";
import { repoRoot } from "./paths.ts";

function git(...args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], { cwd: repoRoot, stderr: "pipe" });
  // check-ignore exits 1 when no path is ignored.
  if (run.exitCode !== 0 && run.exitCode !== 1) throw new Error(run.stderr.toString());
  return run.stdout.toString();
}

/** The subset of `paths` the ignore rules exclude, whether or not the paths are tracked. */
const ignored = (...paths: string[]) =>
  git("check-ignore", "--no-index", "--", ...paths)
    .split("\n")
    .filter(Boolean);

describe("fixture gitignore safeguard", () => {
  test("ignores real Intakes, labels and eval results anywhere", () => {
    const paths = [
      "fixtures/real/a.eml",
      "fixtures/real/scan.pdf",
      "packages/eval-harness/fixtures/private/notes.md",
      "some/dir/x.eml",
      "x.eml",
      "private/expected.json",
      "packages/eval-harness/fixtures/real/expected.json",
      "eval-results/run.json",
      "packages/eval-harness/eval-results/2026-11-05/report.md",
    ];
    expect(ignored(...paths)).toEqual(paths);
  });

  test("keeps the synthetic set committable", () => {
    expect(
      ignored(
        "packages/eval-harness/fixtures/synthetic/01-de-pdf-invoice.eml",
        "packages/eval-harness/fixtures/synthetic/99-new.eml",
        "packages/eval-harness/fixtures/synthetic/expected.json",
      ),
    ).toEqual([]);
  });

  test("tracks .eml files and expected.json only in the synthetic folder", () => {
    const tracked = git("ls-files", "--", "*.eml", "expected.json", "*/expected.json")
      .split("\n")
      .filter(Boolean);
    const outside = tracked.filter(
      (path) => !path.startsWith("packages/eval-harness/fixtures/synthetic/"),
    );
    expect(outside).toEqual([]);
  });
});
