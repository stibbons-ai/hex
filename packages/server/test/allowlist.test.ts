// The domain package's lint override bans `bun:test` under packages/domain, so its table test
// lives here.
import { expect, test } from "bun:test";
import { decideSender } from "@hex/domain";

const allowlists = { slack: ["U0DANIEL"], signal: [] };

test.each([
  ["allowlisted sender", "slack", "U0DANIEL", "allow"],
  ["foreign sender", "slack", "U0STRANGER", "deny"],
  ["sender allowlisted on another channel only", "discord", "U0DANIEL", "deny"],
  ["unknown channel", "telegram", "U0DANIEL", "deny"],
  ["inherited object key as channel", "toString", "U0DANIEL", "deny"],
  ["empty allowlist", "signal", "U0DANIEL", "deny"],
  ["empty sender ID", "slack", "", "deny"],
  ["missing sender ID", "slack", undefined, "deny"],
  ["sender ID with other case", "slack", "u0daniel", "deny"],
  ["sender ID with surrounding whitespace", "slack", " U0DANIEL ", "deny"],
  ["sender ID prefix", "slack", "U0DAN", "deny"],
] as const)("%s", (_case, channel, sender, decision) => {
  expect(decideSender(allowlists, channel, sender)).toBe(decision);
});
