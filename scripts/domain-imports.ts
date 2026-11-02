import { dirname, relative, resolve, sep } from "node:path";

/**
 * Module specifiers in TypeScript source: static and type-only imports, re-exports, side-effect
 * imports, `import("x")` (including type queries) and `require("x")`. Matches inside comments and
 * strings count too, which fails closed.
 */
const specifiers = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;
/** `import(...)`/`require(...)` whose argument isn't a string literal can't be checked. */
const computed = /\b(?:import|require)\s*\(\s*(?!["'])/;

/**
 * The domain is pure (R1-1): its source may import only `effect`, `effect/*` and relative paths
 * that stay inside the domain package. Returns one message per violation.
 */
export function domainImportViolations(
  domainDirectory: string,
  files: readonly { path: string; source: string }[],
): string[] {
  const root = resolve(domainDirectory);
  const failures: string[] = [];
  for (const { path, source } of files) {
    const where = relative(root, resolve(root, path));
    for (const [, specifier] of source.matchAll(specifiers)) {
      if (specifier === "effect" || specifier!.startsWith("effect/")) continue;
      if (specifier!.startsWith(".")) {
        const target = resolve(dirname(resolve(root, path)), specifier!);
        if (target === root || target.startsWith(root + sep)) continue;
        failures.push(`${where}: "${specifier}" leaves the domain package`);
      } else {
        failures.push(`${where}: "${specifier}" is not effect; the domain imports Effect only`);
      }
    }
    if (computed.test(source)) failures.push(`${where}: computed import() or require()`);
  }
  return failures;
}

/** Every TypeScript file under the domain package, relative to it. */
export async function readDomainSources(
  domainDirectory: string,
): Promise<{ path: string; source: string }[]> {
  const files: { path: string; source: string }[] = [];
  const glob = new Bun.Glob("**/*.{ts,tsx,mts,cts,js,mjs,cjs}");
  for await (const path of glob.scan({ cwd: domainDirectory, onlyFiles: true })) {
    if (path.split("/").includes("node_modules")) continue;
    files.push({ path, source: await Bun.file(resolve(domainDirectory, path)).text() });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
