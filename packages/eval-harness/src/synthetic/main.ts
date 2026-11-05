/** `bun run fixtures:generate [folder]`: (re-)writes the synthetic fixture set, by default the committed one. */
import { fileURLToPath } from "node:url";
import { writeFixtureSet } from "./generate.ts";

const folder = Bun.argv[2] ?? fileURLToPath(new URL("../../fixtures/synthetic", import.meta.url));
await writeFixtureSet(folder);
console.log(`synthetic fixtures written to ${folder}`);
