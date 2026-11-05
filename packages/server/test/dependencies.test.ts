import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const serverPackage = fileURLToPath(new URL("..", import.meta.url));
const lockfile = await Bun.file(
  fileURLToPath(new URL("../../../bun.lock", import.meta.url)),
).text();

// @mastra/server statically imports Mastra's enterprise (ee) auth code (ADR 0004). The mastra CLI
// and its @mastra/deployer bring it along: `bun run studio` runs them with bunx, outside the
// workspace.
test.each(["@mastra/server", "@mastra/hono", "@mastra/deployer", "mastra"])(
  "%s is neither resolvable from @hex/server nor in the lockfile",
  (name) => {
    expect(() => Bun.resolveSync(name, serverPackage)).toThrow();
    // A lockfile key or resolution names the package in quotes, followed by `"` or `@<version>`.
    expect(lockfile).not.toMatch(new RegExp(`"${name}["@]`));
  },
);
