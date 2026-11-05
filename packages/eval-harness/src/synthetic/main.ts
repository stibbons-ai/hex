/**
 * `bun run fixtures:generate [folder]`: (re-)writes the synthetic fixture set, by default the
 * committed one. Run it from the repo root or a folder below it outside the workspace packages
 * (inside one, the package manager finds that package's manifest, which has no such script).
 * The script starts in the repo root, so a relative `folder` resolves against the directory you
 * ran it from: npm passes it as `INIT_CWD`, bun as `npm_config_local_prefix` (npm sets that one to
 * the repo root instead). Bun never sets `INIT_CWD`, so under `bun run` one inherited from a parent
 * npm process wins. Run directly (`bun main.ts`), it resolves against the current directory.
 */
import { resolve } from "node:path";
import { syntheticFolder, writeFixtureSet } from "./generate.ts";

const argument = Bun.argv[2];
const { npm_lifecycle_event, INIT_CWD, npm_config_local_prefix } = process.env;
const callerDirectory =
  npm_lifecycle_event === "fixtures:generate"
    ? (INIT_CWD ?? npm_config_local_prefix ?? process.cwd())
    : process.cwd();
const folder = argument === undefined ? syntheticFolder : resolve(callerDirectory, argument);
await writeFixtureSet(folder);
console.log(`synthetic fixtures written to ${folder}`);
