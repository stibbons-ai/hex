import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
export const syntheticFolder = fileURLToPath(new URL("../fixtures/synthetic", import.meta.url));
