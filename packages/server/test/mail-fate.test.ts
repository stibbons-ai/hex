import { expect, test } from "bun:test";
import { moved, notInMailbox, notMoved } from "../src/mail-fate";

test("each constructor's fate is its own variant, its fields readable without narrowing", () => {
  const copies: number = moved("failed", 2).copies;
  const reason: string = notMoved("failed", "refused").reason;
  const status: "not-in-mailbox" = notInMailbox("failed").status;
  expect([copies, reason, status]).toEqual([2, "refused", "not-in-mailbox"]);
});

test("a move of one copy is a fate", () => {
  expect(moved("processed", 1)).toEqual({ status: "moved", to: "processed", copies: 1 });
});

test.each([0, -1, 1.5])("a move of %p copies is a defect", (copies) => {
  expect(() => moved("processed", copies)).toThrow();
});
