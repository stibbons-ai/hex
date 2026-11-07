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

test("accepts an acyclic chain deeper than oRPC's serializer can encode", () => {
  let value: unknown = 1;
  for (let i = 0; i < 25_000; i++) value = { n: value };
  expect(isCyclicOrTooDeep(value)).toBe(false);
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

/** `value` with an own Symbol.iterator yielding `items`, which oRPC's serializer never calls. */
function iterating<T extends object>(value: T, items: () => unknown[]): T {
  return Object.defineProperty(value, Symbol.iterator, {
    *value() {
      yield* items();
    },
  });
}

test("walks an array by index, as oRPC does, not by its own iterator", () => {
  const hidden: unknown[] = [];
  hidden.push(hidden);
  expect(isCyclicOrTooDeep(iterating(hidden, () => []))).toBe(true);
  const encodable: unknown[] = [1, 2];
  expect(isCyclicOrTooDeep(iterating(encodable, () => [encodable]))).toBe(false);
});

test("walks a Map by its entries, as oRPC does, not by its own iterator", () => {
  const hidden = new Map<unknown, unknown>();
  hidden.set("self", hidden);
  expect(isCyclicOrTooDeep(iterating(hidden, () => []))).toBe(true);
  const encodable = new Map<unknown, unknown>([["x", 1]]);
  expect(isCyclicOrTooDeep(iterating(encodable, () => [["self", encodable]]))).toBe(false);
});
