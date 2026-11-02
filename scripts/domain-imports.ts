import { dirname, relative, resolve, sep } from "node:path";

/** Whitespace and comments, which may sit between `from`/`import(` and the specifier. */
const gap = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\n]*\n)*`;
/**
 * Module specifiers in TypeScript source: static and type-only imports, re-exports, side-effect
 * imports, `import("x")` (including type queries) and `require("x")`. Matches inside comments and
 * strings count too, which fails closed; together with `computed` below, every import a parser
 * would find is a match here, so no parser runs.
 */
const specifiers = new RegExp(
  String.raw`(?:\bfrom|\bimport|\brequire)${gap}\(?${gap}["']([^"']+)["']`,
  "g",
);
/** `import(...)`/`require(...)` whose argument isn't a string literal can't be checked. */
const computed = new RegExp(String.raw`\b(?:import|require)\s*\((?!${gap}["'])`);

/** `/// <reference types="bun" />` and friends would bring globals back into the domain. */
const referenceDirective = /^\s*\/\/\/\s*<reference\b/m;

/**
 * The domain is pure: its source (`packages/domain/src`) may import only `effect`, `effect/*` and
 * relative paths that stay inside that directory, may not pull in globals with a triple-slash
 * reference, and may not live in dot directories (TypeScript's include globs skip those, so the
 * domain type-check wouldn't see them). Domain tests may use the test runner, so they are not
 * scanned. Returns one message per violation.
 */
export function domainImportViolations(
  sourceDirectory: string,
  files: readonly { path: string; source: string }[],
): string[] {
  const root = resolve(sourceDirectory);
  const failures: string[] = [];
  for (const { path, source } of files) {
    const where = relative(root, resolve(root, path));
    if (where.split(sep).some((segment) => segment.startsWith("."))) {
      failures.push(`${where}: dot directories and files are not type-checked; move it`);
    }
    if (referenceDirective.test(source)) failures.push(`${where}: triple-slash reference`);
    const found = new Set(Array.from(source.matchAll(specifiers), (match) => match[1]!));
    for (const specifier of found) {
      if (specifier === "effect" || specifier.startsWith("effect/")) continue;
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(resolve(root, path)), specifier);
        if (target === root || target.startsWith(root + sep)) continue;
        failures.push(`${where}: "${specifier}" leaves the domain source`);
      } else {
        failures.push(`${where}: "${specifier}" is not effect; the domain imports Effect only`);
      }
    }
    if (computed.test(source)) failures.push(`${where}: computed import() or require()`);
  }
  return failures;
}

/** Every .ts, .tsx, .mts, .cts, .js, .mjs and .cjs file under a directory, dot dirs too. */
export async function readDomainSources(
  sourceDirectory: string,
): Promise<{ path: string; source: string }[]> {
  const files: { path: string; source: string }[] = [];
  const glob = new Bun.Glob("**/*.{ts,tsx,mts,cts,js,mjs,cjs}");
  for await (const path of glob.scan({ cwd: sourceDirectory, onlyFiles: true, dot: true })) {
    if (path.split("/").includes("node_modules")) continue;
    files.push({ path, source: await Bun.file(resolve(sourceDirectory, path)).text() });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
