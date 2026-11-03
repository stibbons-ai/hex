// The domain package's lint override bans `bun:test` under packages/domain, so its table test
// lives here.
import { expect, test } from "bun:test";
import { decideSender } from "@hex/domain";

const allowlists = { slack: ["U0DANIEL"], signal: ["S0DANIEL"], discord: [] };

test.each([
  ["allowlisted sender", "slack", "U0DANIEL", "allow"],
  ["foreign sender", "slack", "U0STRANGER", "deny"],
  ["sender allowlisted on another platform only", "signal", "U0DANIEL", "deny"],
  ["another platform's sender ID", "slack", "S0DANIEL", "deny"],
  ["unknown platform", "telegram", "U0DANIEL", "deny"],
  ["inherited object key as platform", "toString", "U0DANIEL", "deny"],
  ["empty allowlist", "discord", "U0DANIEL", "deny"],
  ["empty sender ID", "slack", "", "deny"],
  ["missing sender ID", "slack", undefined, "deny"],
  ["sender ID with other case", "slack", "u0daniel", "deny"],
  ["sender ID with surrounding whitespace", "slack", " U0DANIEL ", "deny"],
  ["sender ID prefix", "slack", "U0DAN", "deny"],
] as const)("%s", (_case, platform, sender, decision) => {
  expect(decideSender(allowlists, platform, sender)).toBe(decision);
});
