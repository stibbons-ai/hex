import { expect, test } from "bun:test";
import { isCyclic } from "../src/cyclic";

test("finds a cycle through a Map key", () => {
  const key: { map?: Map<unknown, unknown> } = {};
  key.map = new Map([[key, "value"]]);
  expect(isCyclic(key)).toBe(true);
});

test("tracks the path from the root, not every value seen: a shared value is no cycle", () => {
  const leaf = { leaf: true };
  const diamond = { left: { leaf }, right: { leaf }, both: [leaf, leaf] };
  expect(isCyclic(diamond)).toBe(false);
});

test("treats a class instance as a leaf, as oRPC's serializer does", () => {
  class Box {
    self: Box = this;
  }
  expect(isCyclic({ box: new Box() })).toBe(false);
});
