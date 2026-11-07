/**
 * The deepest path walked before giving up. oRPC's recursive serializer overflows the stack long
 * before this (roughly 16-18k plain objects deep on Bun's default stack, depending on the caller's
 * stack, and fewer for arrays and Maps), so no output it could encode today is rejected.
 */
const MAX_DEPTH = 100_000;

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
 * - Array: the array's own `map`, called with a callback that returns each item, as oRPC calls it
 *   with one that encodes each. What `map` returns stands for oRPC's raw JSON for the array, and is
 *   walked like any output, so the copy has the returned shape (holes stay holes). Where the
 *   override returns raw values, moves callback results or passes its own index, the copy differs:
 *   the snapshot encodes each value at its real slot, where oRPC records meta at the override's
 *   path and index and passes raw values on unwalked; and a raw value referring back to the array
 *   counts as a cycle. All items are read before any is walked into, where oRPC walks each as `map`
 *   reaches it; only recursion could keep that order.
 * - Anything else: the values of its for...in keys, each read right before it is walked into, as
 *   oRPC does: once, but a `toJSON` key twice. A `toJSON` function is skipped. The copy has no
 *   prototype, so a `__proto__` key stays a key and oRPC re-encodes it as it would the original.
 *
 * The walk, and so the cycle check, reaches only what it descends into: a callback result an
 * override hides inside a leaf (a class instance, say) is kept there by reference, unwalked.
 */
function* copyOf(value: object, name: string): Generator<unknown, unknown, unknown> {
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
      // Not always pairs: an overridden `entries` can yield anything, and new Map rejects that.
      return new Map(copies as [unknown, unknown][]);
    } catch (cause) {
      throw new Error(`hex: the output of ${name} has a Map entry that isn't a [key, value] pair`, {
        cause,
      });
    }
  }
  if (Array.isArray(value)) {
    const mapped: unknown = value.map((item: unknown) => item);
    if (!Array.isArray(mapped)) return isWalked(mapped) ? yield mapped : mapped;
    const copy: unknown[] = [];
    copy.length = mapped.length;
    for (let i = 0; i < mapped.length; i++) {
      if (!(i in mapped)) continue;
      const item: unknown = mapped[i];
      copy[i] = isWalked(item) ? yield item : item;
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
 * A detached copy of a procedure's output, for oRPC to encode instead of the output: it encodes to
 * what the output would have, except as copyOf notes and for a `toJSON` getter that changes type
 * between its two reads. Having read the output once, as oRPC's serializer would, it keeps
 * getters, overridden `map`s and iterators from being read twice; only a leaf's prototype
 * `constructor` is read again when oRPC encodes the leaf. Leaves are kept by reference, and so is
 * an output oRPC streams as an event iterator.
 *
 * Throws if the output contains itself, or nests deeper than oRPC's serializer could ever encode,
 * where that serializer would look. oRPC finds a cycle only by recursing until the stack
 * overflows, which blocks the event loop for seconds; this answers in time linear in what the
 * serializer would walk anyway. The depth bound also ends a value that hands out a fresh object on
 * every read.
 *
 * Iterative, so a deep value can't overflow the stack here either. It tracks the current path from
 * the root, not every value seen: a value reached twice through different parents is shared,
 * which serializes fine (as two copies, as here); only one reached again below itself is a cycle.
 *
 * @param name The procedure's path, for the error message.
 */
export function snapshotOutput(output: unknown, name: string): unknown {
  if (isAsyncIteratorObject(output) || !isWalked(output)) return output;
  const path = new Set<object>();
  const frames: { value: object; copying: Generator<unknown, unknown, unknown> }[] = [];
  let next = output as object;
  for (;;) {
    if (path.has(next) || path.size >= MAX_DEPTH) {
      throw new Error(`hex: the output of ${name} is cyclic or too deep`);
    }
    path.add(next);
    frames.push({ value: next, copying: copyOf(next, name) });
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
}
