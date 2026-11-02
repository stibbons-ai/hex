import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const serverPackage = fileURLToPath(new URL("..", import.meta.url));
const lockfile = fileURLToPath(new URL("../../../bun.lock", import.meta.url));

// @mastra/server statically imports Mastra's enterprise (ee) auth code (ADR 0004).
test.each(["@mastra/server", "@mastra/hono"])(
  "%s is neither resolvable from @hex/server nor in the lockfile",
  async (name) => {
    expect(() => Bun.resolveSync(name, serverPackage)).toThrow();
    expect(await Bun.file(lockfile).text()).not.toContain(`"${name}`);
  },
);
