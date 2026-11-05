/**
 * `bun run fixtures:generate [folder]`: (re-)writes the synthetic fixture set, by default the
 * committed one. Run it from the repo root or a folder below it outside the workspace packages
 * (inside one, bun finds that package's manifest, which has no such script). `bun run` starts the
 * script in the repo root, so a relative `folder` resolves against the directory you ran it from,
 * which bun (unlike npm) passes as `npm_config_local_prefix`. Run directly (`bun main.ts`), it
 * resolves against the current directory.
 */
import { resolve } from "node:path";
import { syntheticFolder, writeFixtureSet } from "./generate.ts";

const argument = Bun.argv[2];
const callerDirectory =
  process.env.npm_lifecycle_event === "fixtures:generate"
    ? (process.env.npm_config_local_prefix ?? process.cwd())
    : process.cwd();
const folder = argument === undefined ? syntheticFolder : resolve(callerDirectory, argument);
await writeFixtureSet(folder);
console.log(`synthetic fixtures written to ${folder}`);
