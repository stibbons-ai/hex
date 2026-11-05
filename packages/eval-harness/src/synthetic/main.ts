/**
 * `bun run fixtures:generate [folder]`: (re-)writes the synthetic fixture set, by default the
 * committed one. `bun run` starts scripts in the repo root, so a relative `folder` resolves against
 * the caller's directory, which bun passes as `npm_config_local_prefix`.
 */
import { resolve } from "node:path";
import { syntheticFolder, writeFixtureSet } from "./generate.ts";

const argument = Bun.argv[2];
const folder =
  argument === undefined
    ? syntheticFolder
    : resolve(process.env.npm_config_local_prefix ?? process.cwd(), argument);
await writeFixtureSet(folder);
console.log(`synthetic fixtures written to ${folder}`);
