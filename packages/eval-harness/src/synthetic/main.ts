/** `bun run fixtures:generate [folder]`: (re-)writes the synthetic fixture set, by default the committed one. */
import { syntheticFolder, writeFixtureSet } from "./generate.ts";

const folder = Bun.argv[2] ?? syntheticFolder;
await writeFixtureSet(folder);
console.log(`synthetic fixtures written to ${folder}`);
