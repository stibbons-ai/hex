import { expect, test } from "bun:test";
import { StandardRPCJsonSerializer, StandardRPCSerializer } from "@orpc/client/standard";
import { snapshotOutput } from "../src/snapshot";

const serializer = new StandardRPCSerializer(new StandardRPCJsonSerializer());
/** What hex's RPC handler sends for `value`. */
const encode = (value: unknown): string => JSON.stringify(serializer.serialize(value));
const snapshot = (value: unknown): unknown => snapshotOutput(value, "test.procedure");
/** Expects `value` rejected with `reason`, by default a cycle at any depth. */
const rejects = (
  value: unknown,
  reason: string | RegExp = /^hex: the output of test\.procedure is cyclic at depth \d+$/,
): void => {
  expect(() => snapshot(value)).toThrow(reason);
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
  rejects(key, "hex: the output of test.procedure is cyclic at depth 3");
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

test.each([
  ["Date", () => new Date(0)],
  ["URL", () => new URL("https://example.com/x")],
  ["RegExp", () => /re/g],
  ["Blob", () => new Blob(["x"])],
])("keeps a %s as a leaf even when its prototype has no constructor, as oRPC does", (_, make) => {
  const value = make();
  // Shadows `constructor` between the value and its own prototype, which stays in the chain.
  const prototype = Object.create(Object.getPrototypeOf(value) as object, {
    constructor: { value: undefined },
  }) as object;
  Object.setPrototypeOf(value, prototype);
  const output = { list: [value] };
  expect(encode(snapshot(output))).toBe(encode(output));
  expect((snapshot(output) as typeof output).list[0]).toBe(value);
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
  rejects({ bare }, "hex: the output of test.procedure is cyclic at depth 2");
  const orphan = Object.create(Object.create(null) as object) as Record<string, unknown>;
  orphan.self = orphan;
  rejects({ orphan }, "hex: the output of test.procedure is cyclic at depth 2");
});

test("gives up on a value that hands out a fresh object on every read, fast", () => {
  const fresh = (): object => ({
    get next() {
      return fresh();
    },
  });
  const started = performance.now();
  rejects(fresh(), "hex: the output of test.procedure is deeper than 100000 values");
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

test("copies a `map` callback's result wherever the override puts it, even inside a leaf", () => {
  const nested: unknown[] = [];
  rejects(mapping(nested, (visit) => [[visit(nested)]]));
  const item = { x: 1 };
  const wrapped = mapping([item], (visit) => ({ wrapped: visit(item) }));
  const encoded = encode(snapshot(wrapped));
  expect(encoded).toBe(encode(wrapped));
  expect(encoded).toBe(encode({ wrapped: { x: 1 } }));
  class Box {
    constructor(readonly v: unknown) {}
  }
  const boxedItem = { x: 1 };
  const boxed = mapping([boxedItem], (visit) => [new Box(visit(boxedItem))]);
  const encodedBox = encode(snapshot(boxed));
  expect(encodedBox).toBe(encode(boxed));
  expect(encodedBox).toBe(encode([{ v: { x: 1 } }]));
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
  let thrown: unknown;
  try {
    snapshot(broken);
  } catch (error) {
    thrown = error;
  }
  expect((thrown as Error).cause).toBeInstanceOf(TypeError);
});

test("returns an async iterator output as is, which oRPC streams instead of encoding", () => {
  const iterator = {
    next: async () => ({ done: true, value: undefined }),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  expect(snapshot(iterator)).toBe(iterator);
});

test("walks a complete async iterator below the root, which oRPC encodes as a record", () => {
  const nested: Record<PropertyKey, unknown> = {
    next: async () => ({ done: true, value: undefined }),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  nested.self = nested;
  rejects({ result: nested });
});

/** Root shapes oRPC's codec encodes whole, each with what a caller decodes beside `data`. */
const incompleteIterators: [string, Record<PropertyKey, unknown>, object][] = [
  ["no next", { [Symbol.asyncIterator]: (): undefined => undefined }, {}],
  [
    "a next that isn't a function",
    { next: 1, [Symbol.asyncIterator]: (): undefined => undefined },
    { next: 1 },
  ],
  ["no Symbol.asyncIterator", { next: async (): Promise<undefined> => undefined }, {}],
  [
    "a Symbol.asyncIterator that isn't a function",
    { next: async (): Promise<undefined> => undefined, [Symbol.asyncIterator]: 1 },
    {},
  ],
];

test.each(incompleteIterators)(
  "walks an incomplete async iterator with %s, which oRPC encodes",
  (_, members) => {
    const half: Record<PropertyKey, unknown> = { ...members };
    half.self = half;
    rejects(half);
  },
);

test.each(incompleteIterators)(
  "leaves oRPC's codec to encode an incomplete async iterator with %s whole",
  (_, members, decoded) => {
    const half = { ...members, data: "whole" };
    const wire = JSON.parse(encode(snapshot(half))) as Parameters<typeof serializer.deserialize>[0];
    expect(serializer.deserialize(wire)).toEqual({ ...decoded, data: "whole" });
  },
);

test("leaves oRPC's codec to stream a complete async iterator output", async () => {
  // A plain object, which the walk would descend into: an async generator is a leaf either way.
  const events = [{ event: 1 }];
  const stream = {
    next: async () => ({ done: events.length === 0, value: events.shift() }),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  const decoded: unknown[] = [];
  // Iterating needs the stream itself: an encoded copy keeps `next` but loses the iterator symbol.
  const streamed = serializer.deserialize(serializer.serialize(snapshot(stream)));
  for await (const event of streamed as AsyncIterable<unknown>) decoded.push(event);
  expect(decoded).toEqual([{ event: 1 }]);
});

test("hands an array's own map a detached copy, as oRPC does, and checks what it returns", () => {
  const record = { v: "original" };
  let calls = 0;
  const output = {
    list: mapping([record], (visit) => {
      calls++;
      const mapped = visit(record) as typeof record;
      mapped.v = "changed";
      return [mapped];
    }),
    sibling: record,
  };
  const encoded = encode(output);
  expect(encoded).toBe(encode({ list: [{ v: "changed" }], sibling: { v: "original" } }));
  expect(record.v).toBe("original");
  calls = 0;
  expect(encode(snapshot(output))).toBe(encoded);
  expect(record.v).toBe("original");
  expect(calls).toBe(1);

  const linked = { v: 1 };
  rejects(
    mapping([linked], (visit) => {
      const mapped = visit(linked) as Record<string, unknown>;
      mapped.self = mapped;
      return [mapped];
    }),
  );
  const looped: unknown[] = mapping([{ v: 1 }], (visit) => {
    const mapped = visit({ v: 1 }) as Record<string, unknown>;
    mapped.back = looped;
    return [mapped];
  });
  rejects(looped);
});

test("replays a species map's copy as is when an override walks it again", () => {
  // Native map builds its result through the species, which here appends a tail: encoded, it is
  // { v: 1 }; left raw, JSON calls its `toJSON`.
  class Tailed extends Array {
    constructor(length: number) {
      super(length);
      this.push({ v: 1, toJSON: () => "raw" });
    }
  }
  const make = () => {
    const tailed = new Tailed(1);
    tailed[0] = "head";
    return mapping([tailed], (visit) => [visit(tailed)]);
  };
  const encoded = encode(make());
  // oRPC's one species map encodes the two items it visits and leaves the tail it appended raw.
  // A second map, or one encoding that tail, would differ.
  expect(encoded).toBe(encode([["head", { v: 1 }, "raw"]]));
  expect(encode(snapshot(make()))).toBe(encoded);
});

test("leaves the path as found when an array's own map catches a failed walk", () => {
  // A getter that throws once fails the walk with `shared` and `inner` still on the path.
  const make = () => {
    let thrown = false;
    const shared = {
      inner: {
        get once() {
          if (thrown) return 1;
          thrown = true;
          throw new Error("first read");
        },
      },
    };
    const list = mapping([shared], (visit) => {
      try {
        visit(shared);
      } catch {}
      return ["safe"];
    });
    return { list, sibling: shared };
  };
  const encoded = encode(make());
  expect(encoded).toBe(encode({ list: ["safe"], sibling: { inner: { once: 1 } } }));
  expect(encode(snapshot(make()))).toBe(encoded);
});

test("fails fast and by name on custom maps nested deeper than it recurses", () => {
  let value: unknown = [];
  for (let i = 0; i < 20_000; i++) {
    const inner = value;
    value = mapping([inner], (visit) => [visit(inner)]);
  }
  const started = performance.now();
  rejects(
    value,
    /^hex: the output of test\.procedure nests more than 1000 custom array maps at depth \d+$/,
  );
  expect(performance.now() - started).toBeLessThan(1000);
});
