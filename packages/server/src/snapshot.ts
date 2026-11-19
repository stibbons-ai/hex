/**
 * The deepest path walked before giving up. oRPC's recursive serializer overflows the stack long
 * before this (roughly 16-18k plain objects deep on Bun's default stack, depending on the caller's
 * stack, and fewer for arrays and Maps), so no output it could encode today is rejected.
 */
const MAX_DEPTH = 100_000;

/**
 * The most overridden array `map`s nested inside each other's callbacks: each callback walks its
 * item while the override waits, so each one nests a walk on the stack and walks its copy again.
 * About 50 ms at the bound for a bare chain; the work grows with the payload below each override.
 * oRPC's serializer encodes several thousand (measured 8,000).
 */
const MAX_MAP_NESTING = 1_000;

/** One output's walk: its procedure, the current path from the root, the nested map callbacks. */
interface Walk {
  name: string;
  path: Set<object>;
  maps: number;
}

const tooDeep = (walk: Walk) => new Error(`hex: the output of ${walk.name} is cyclic or too deep`);

/** The indices a copied array hands the encoder's callback, keyed by the copy, until it does. */
const replays = new WeakMap<object, number[]>();

/**
 * The `map` of a copied array, for the encoder's one call: removes itself, so a `toJSON` JSON then
 * calls sees the array's inherited `map`, and calls `encode` on the walked indices, in place.
 */
function replayMap(
  this: unknown[],
  encode: (item: unknown, index: number, array: unknown[]) => unknown,
): unknown[] {
  const indices = replays.get(this) ?? [];
  replays.delete(this);
  Reflect.deleteProperty(this, "map");
  for (const i of indices) this[i] = encode(this[i], i, this);
  return this;
}

/** What a custom array `map`'s callback returns for `item`: its checked, detached copy. */
function detach(item: unknown, walk: Walk): unknown {
  if (!isWalked(item)) return item;
  if (walk.maps >= MAX_MAP_NESTING) throw tooDeep(walk);
  walk.maps++;
  try {
    return copyWhole(item as object, walk);
  } finally {
    walk.maps--;
  }
}

/**
 * Whether oRPC's RPC serializer streams `value` as an event iterator instead of encoding it:
 * `isAsyncIteratorObject` from `@orpc/shared` 1.16.1, inlined because `@orpc/server` doesn't
 * re-export it and `@orpc/shared` isn't a dependency here.
 */
function isAsyncIteratorObject(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    "next" in value &&
    typeof value.next === "function" &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

/**
 * Whether the walk descends into `value`: what oRPC's RPC serializer descends into, tested in its
 * order: not a Blob, Date, URL or RegExp, but a Map, a Set, an array, or what its isObject accepts
 * (a plain object, one without a prototype, or one whose prototype has no constructor). Anything
 * else it encodes as a leaf: primitives, Date, URL, RegExp, Blob, class instances.
 */
function isWalked(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (
    value instanceof Blob ||
    value instanceof Date ||
    value instanceof URL ||
    value instanceof RegExp
  ) {
    return false;
  }
  if (value instanceof Map || value instanceof Set || Array.isArray(value)) return true;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype || !(prototype as object).constructor;
}

/**
 * Copies one walked value, reading it through exactly the protocols oRPC 1.16's RPC serializer
 * uses with no custom JSON serializers (hex's RPCHandler sets none; oRPC would try those first), so
 * an overridden one can't make the two disagree. It yields each walked child to the caller and is
 * sent back that child's copy (a leaf child is its own copy); it returns the value's copy.
 * - Set: the items of `Array.from(set)`. The copy is a Set of their copies; walked items are fresh
 *   copies, so only a leaf or primitive repeated by an overridden Set iterator collapses into one
 *   entry, where oRPC sends it twice (and its client keeps both of a repeated leaf object).
 * - Map: the items of `Array.from(map.entries())`, each walked as oRPC walks it (normally a
 *   `[key, value]` array). The copy is `new Map(itemCopies)`: an item that is no entry object (an
 *   overridden `entries`) fails the call there, naming the procedure, where oRPC's client would
 *   fail decoding it with the same `new Map(json)`. A short or long entry decodes the same either
 *   way, and so does a repeated key, except a leaf object key repeated by an overridden `entries`:
 *   like a Set's, it collapses into one entry here, where oRPC's client keeps both.
 * - Array, with the native `map`: called once with a callback that returns each item, as oRPC
 *   calls it with one that encodes each. Its result (an Array subclass's species instance, or
 *   whatever a species constructor returns, built once) is the copy: the visited indices get their
 *   items' copies in place, holes and any slots or own properties the species constructor added
 *   stay as they are. A copy with another prototype or a `toJSON` (so one JSON would call) gets an
 *   own `map` for the encoder's one call: it removes itself, then hands the encoder's callback only
 *   the visited indices and returns the copy, so the species constructor never runs again and the
 *   `toJSON` sees the copy with its inherited `map`. Other arrays get no such `map`. All items are
 *   read before any is walked into, where oRPC walks each as `map` reaches it: an index getter
 *   whose answer depends on what was read before it can decode differently. Only recursion could
 *   keep that order.
 * - Array, with an overridden `map`: called once, with a callback returning the checked, detached
 *   copy of each walked item, as oRPC's returns a fresh encoding, so an override that changes it
 *   leaves the output alone. That callback walks inside the override's call, so a cycle it meets
 *   throws there: an override that catches that, discards the item and returns safely passes, as
 *   with oRPC once its stack overflowed. Nested overrides past MAX_MAP_NESTING fail. What the
 *   override returns stands for oRPC's raw JSON for the array: if it is an array, every item is
 *   walked again, callback copies and changes to them included, and copied into a plain array (with
 *   that array's prototype and, for a subclass, the replaying `map` above); otherwise it is walked
 *   itself. Where the override returns raw values, moves callback results or passes its own index,
 *   the copy differs: the snapshot encodes each value at its real slot, where oRPC records meta at
 *   the override's path and index and passes raw values on unwalked; and a raw value referring
 *   back to the array counts as a cycle.
 * - Anything else: the values of its for...in keys, each read right before it is walked into, as
 *   oRPC does: once, but a `toJSON` key twice. A `toJSON` function is skipped. The copy has no
 *   prototype, so a `__proto__` key stays a key and oRPC re-encodes it as it would the original.
 *
 * The walk, and so the cycle check, reaches only what it descends into: a callback copy an
 * override hides inside a leaf (a class instance, say) is kept there by reference, unwalked again.
 */
function* copyOf(value: object, walk: Walk): Generator<unknown, unknown, unknown> {
  if (value instanceof Set) {
    const copy = new Set<unknown>();
    for (const item of Array.from(value)) copy.add(isWalked(item) ? yield item : item);
    return copy;
  }
  if (value instanceof Map) {
    const copies: unknown[] = [];
    for (const item of Array.from(value.entries())) {
      copies.push(isWalked(item) ? yield item : item);
    }
    try {
      // Not always pairs: an overridden `entries` can yield a primitive, which new Map rejects.
      return new Map(copies as [unknown, unknown][]);
    } catch (cause) {
      throw new Error(
        `hex: the output of ${walk.name} has a Map entry that isn't a [key, value] pair`,
        { cause },
      );
    }
  }
  if (Array.isArray(value)) {
    let mapped: unknown;
    // The indices native map visited, in mapped: its result (or a replay copy), copied in place.
    let visited = replays.get(value);
    if (visited) {
      mapped = value;
    } else {
      const map = (value as unknown[]).map;
      if (map === Array.prototype.map) {
        const indices: number[] = [];
        mapped = map.call(value, (item, i) => {
          indices.push(i);
          return item;
        });
        visited = indices;
      } else {
        mapped = map.call(value, (item) => detach(item, walk));
      }
    }
    if (!Array.isArray(mapped)) return isWalked(mapped) ? yield mapped : mapped;
    const copy: unknown[] = visited ? mapped : [];
    const walked = visited ?? [];
    if (!visited) {
      copy.length = mapped.length;
      for (let i = 0; i < mapped.length; i++) if (i in mapped) walked.push(i);
    }
    for (const i of walked) {
      const item: unknown = mapped[i];
      copy[i] = isWalked(item) ? yield item : item;
    }
    const prototype: unknown = Object.getPrototypeOf(mapped);
    if (prototype !== Array.prototype || "toJSON" in copy) {
      // Keeps a `toJSON` on what oRPC's map returns (an Array subclass's, or one a species gave an
      // ordinary array) without running a species constructor again or an overridden map again.
      if (!visited) Object.setPrototypeOf(copy, prototype as object | null);
      replays.set(copy, walked);
      Object.defineProperty(copy, "map", { value: replayMap, configurable: true });
    }
    return copy;
  }
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key in value) {
    let item = (value as Record<string, unknown>)[key];
    if (key === "toJSON") {
      if (typeof item === "function") continue;
      item = (value as Record<string, unknown>)[key];
    }
    copy[key] = isWalked(item) ? yield item : item;
  }
  return copy;
}

/**
 * A detached copy of a procedure's output, for oRPC to encode instead of the output: a caller
 * decodes it as it would the output, except as copyOf notes and for a `toJSON` getter that changes
 * type between its two reads. Having read the output once, as oRPC's serializer would, it keeps
 * getters, overridden `map`s and iterators from being read twice. Leaves are kept by reference, and
 * so is an output oRPC streams as an event iterator: the values it yields are not checked.
 *
 * Not a byte-for-byte guarantee against exotic hooks: a leaf's prototype `constructor` is read
 * again when oRPC encodes the leaf, a Proxy's `getPrototypeOf` trap fires more often, an object
 * reached again below itself is rejected even if its getters would answer differently the second
 * time, and meta entries can come in another order (inherited integer keys, a Proxy's `ownKeys`),
 * which decodes the same.
 *
 * Throws if the output contains itself, or nests deeper than oRPC's serializer could ever encode,
 * where that serializer would look, or nests more overridden array `map`s than MAX_MAP_NESTING.
 * oRPC finds a cycle only by recursing until the stack overflows, which blocks the event loop for
 * seconds; this answers in time linear in what the serializer would walk anyway, times the
 * overridden `map`s a value sits below. The depth bound also ends a value that hands out a fresh
 * object on every read.
 *
 * Iterative, so a deep value can't overflow the stack here either: only overridden `map`s nest,
 * up to MAX_MAP_NESTING. It tracks the current path from the root, not every value seen: a value
 * reached twice through different parents is shared, which serializes fine (as two copies, as
 * here); only one reached again below itself is a cycle.
 *
 * @param name The procedure's path, for the error message.
 */
export function snapshotOutput(output: unknown, name: string): unknown {
  if (isAsyncIteratorObject(output) || !isWalked(output)) return output;
  return copyWhole(output as object, { name, path: new Set(), maps: 0 });
}

/** The copy of `root`, walked iteratively below `walk.path`, which it leaves as it found it. */
function copyWhole(root: object, walk: Walk): unknown {
  const { path } = walk;
  const frames: { value: object; copying: Generator<unknown, unknown, unknown> }[] = [];
  let next = root;
  try {
    for (;;) {
      if (path.has(next) || path.size >= MAX_DEPTH) throw tooDeep(walk);
      path.add(next);
      frames.push({ value: next, copying: copyOf(next, walk) });
      // The copy to send to the innermost frame; undefined starts a new frame's generator.
      let copy: unknown;
      for (;;) {
        const frame = frames.at(-1)!;
        const step = frame.copying.next(copy);
        if (!step.done) {
          // copyOf yields only values isWalked accepts, all objects.
          next = step.value as object;
          break;
        }
        frames.pop();
        path.delete(frame.value);
        if (frames.length === 0) return step.value;
        copy = step.value;
      }
    }
  } finally {
    // A throw leaves frames behind; an override's map may catch it and the walk go on.
    for (const frame of frames) path.delete(frame.value);
  }
}
