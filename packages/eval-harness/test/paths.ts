import { fileURLToPath } from "node:url";

export { syntheticFolder } from "../src/synthetic/generate.ts";
export const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
