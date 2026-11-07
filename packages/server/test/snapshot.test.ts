import { expect, test } from "bun:test";
import { StandardRPCJsonSerializer, StandardRPCSerializer } from "@orpc/client/standard";
import { snapshotOutput } from "../src/snapshot";

const serializer = new StandardRPCSerializer(new StandardRPCJsonSerializer());
/** What hex's RPC handler sends for `value`. */
const encode = (value: unknown): string => JSON.stringify(serializer.serialize(value));
const snapshot = (value: unknown): unknown => snapshotOutput(value, "test.procedure");
const rejects = (value: unknown): void => {
  expect(() => snapshot(value)).toThrow("hex: the output of test.procedure is cyclic or too deep");
};

test("encodes as the output would, without oRPC touching the output again", () => {
  const shared = { leaf: true };
  const sparse: unknown[] = [1];
  sparse[2] = undefined;
  sparse[4] = "after a hole";
  const date = new Date(0);
  const output = {
    nested: { list: [1, "two", null, { deep: [shared] }] },
    map: new Map<unknown, unknown>([
      [{ key: 1 }, new Set([1, shared])],
      ["date", date],
    ]),
    sparse,
    missing: undefined,
    special: [Number.NaN, 12n, new URL("https://example.com/x"), /re/g],
    both: [shared, shared],
    toJSON: () => "skipped",
  };
  const encoded = encode(output);
  const copy = snapshot(output);
  expect(encode(copy)).toBe(encoded);
  expect(copy).not.toBe(output);
  expect((copy as typeof output).both[0]).not.toBe(shared);
  expect((copy as typeof output).map.get("date")).toBe(date);
});

test("reads each getter once per occurrence, and the copy no more", () => {
  let reads = 0;
  const counted = {
    get value() {
      return ++reads;
    },
  };
  const copy = snapshot({ first: counted, second: [counted] }) as {
    first: { value: number };
    second: [{ value: number }];
  };
  expect(reads).toBe(2);
  expect(copy.first.value).toBe(1);
  expect(copy.second[0].value).toBe(2);
  expect(reads).toBe(2);
});

test("reads a `toJSON` key twice, as oRPC's serializer does", () => {
  let reads = 0;
  const output = {
    get toJSON() {
      reads++;
      return "data";
    },
  };
  encode(output);
  const byEncoder = reads;
  reads = 0;
  expect(encode(snapshot(output))).toBe(encode({ toJSON: "data" }));
  expect(reads).toBe(byEncoder);
});

test("finds a cycle through a Map key", () => {
  const key: { map?: Map<unknown, unknown> } = {};
  key.map = new Map([[key, "value"]]);
  rejects(key);
});

test("tracks the path from the root, not every value seen: a shared value is no cycle", () => {
  const leaf = { leaf: true };
  const diamond = { left: { leaf }, right: { leaf }, both: [leaf, leaf] };
  expect(encode(snapshot(diamond))).toBe(encode(diamond));
});

test("keeps a class instance as a leaf, as oRPC's serializer does", () => {
  class Box {
    self: Box = this;
  }
  const box = new Box();
  expect((snapshot({ box }) as { box: Box }).box).toBe(box);
});

test("accepts an acyclic chain deeper than oRPC's serializer can encode", () => {
  let value: unknown = 1;
  for (let i = 0; i < 25_000; i++) value = { n: value };
  let copy = snapshot(value);
  for (let i = 0; i < 25_000; i++) copy = (copy as { n: unknown }).n;
  expect(copy).toBe(1);
});

test("walks into objects without a prototype, or whose prototype has no constructor", () => {
  const bare = Object.create(null) as Record<string, unknown>;
  bare.self = bare;
  rejects({ bare });
  const orphan = Object.create(Object.create(null) as object) as Record<string, unknown>;
  orphan.self = orphan;
  rejects({ orphan });
});

test("gives up on a value that hands out a fresh object on every read, fast", () => {
  const fresh = (): object => ({
    get next() {
      return fresh();
    },
  });
  const started = performance.now();
  rejects(fresh());
  expect(performance.now() - started).toBeLessThan(1000);
});

/** `value` with an own Symbol.iterator yielding `items`, which oRPC's serializer never calls. */
function iterating<T extends object>(value: T, items: unknown[]): T {
  return Object.defineProperty(value, Symbol.iterator, {
    *value() {
      yield* items;
    },
  });
}

/** `value` with an own `map`, which oRPC's serializer calls. */
function mapping<T extends unknown[]>(
  value: T,
  map: (visit: (item: unknown) => unknown) => unknown,
): T {
  return Object.defineProperty(value, "map", { value: map });
}

test("walks an array through its own map, as oRPC does, not its indices or iterator", () => {
  const hidden: unknown[] = [];
  hidden.push(hidden);
  rejects(iterating(hidden, []));
  const iterated: unknown[] = [1, 2];
  expect(encode(snapshot(iterating(iterated, [iterated])))).toBe(encode([1, 2]));

  const exposed: unknown[] = [];
  rejects(mapping(exposed, (visit) => [visit(exposed)]));
  const unmapped: unknown[] = [];
  unmapped.push(unmapped);
  const safe = mapping(unmapped, () => ["safe"]);
  const encoded = encode(snapshot(safe));
  expect(encoded).toBe(encode(safe));
  expect(encoded).toBe(encode(["safe"]));
});

test("unwraps a `map` callback's result wherever the override nests it", () => {
  const nested: unknown[] = [];
  rejects(mapping(nested, (visit) => [[visit(nested)]]));
  const item = { x: 1 };
  const wrapped = mapping([item], (visit) => ({ wrapped: visit(item) }));
  const encoded = encode(snapshot(wrapped));
  expect(encoded).toBe(encode(wrapped));
  expect(encoded).toBe(encode({ wrapped: { x: 1 } }));
});

test("walks a Map by its entries, as oRPC does, not by its own iterator", () => {
  const hidden = new Map<unknown, unknown>();
  hidden.set("self", hidden);
  rejects(iterating(hidden, []));
  const encodable = new Map<unknown, unknown>([["x", 1]]);
  const iterated = iterating(encodable, [["self", encodable]]);
  expect(encode(snapshot(iterated))).toBe(encode(iterated));
});

test("fails on a Map entry that isn't one, naming the procedure", () => {
  const broken = Object.defineProperty(new Map(), "entries", { value: () => [5].values() });
  expect(() => snapshot(broken)).toThrow(
    "hex: the output of test.procedure has a Map entry that isn't a [key, value] pair",
  );
  try {
    snapshot(broken);
  } catch (error) {
    expect((error as Error).cause).toBeInstanceOf(TypeError);
  }
});
