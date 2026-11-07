import { expect, test } from "bun:test";
import { isCyclicOrTooDeep } from "../src/cyclic";

test("finds a cycle through a Map key", () => {
  const key: { map?: Map<unknown, unknown> } = {};
  key.map = new Map([[key, "value"]]);
  expect(isCyclicOrTooDeep(key)).toBe(true);
});

test("tracks the path from the root, not every value seen: a shared value is no cycle", () => {
  const leaf = { leaf: true };
  const diamond = { left: { leaf }, right: { leaf }, both: [leaf, leaf] };
  expect(isCyclicOrTooDeep(diamond)).toBe(false);
});

test("treats a class instance as a leaf, as oRPC's serializer does", () => {
  class Box {
    self: Box = this;
  }
  expect(isCyclicOrTooDeep({ box: new Box() })).toBe(false);
});

test("walks into objects without a prototype, or whose prototype has no constructor", () => {
  const bare = Object.create(null) as Record<string, unknown>;
  bare.self = bare;
  expect(isCyclicOrTooDeep({ bare })).toBe(true);
  const orphan = Object.create(Object.create(null) as object) as Record<string, unknown>;
  orphan.self = orphan;
  expect(isCyclicOrTooDeep({ orphan })).toBe(true);
});

test("gives up on a value that hands out a fresh object on every read, fast", () => {
  const fresh = (): object => ({
    get next() {
      return fresh();
    },
  });
  const started = performance.now();
  expect(isCyclicOrTooDeep(fresh())).toBe(true);
  expect(performance.now() - started).toBeLessThan(1000);
});
