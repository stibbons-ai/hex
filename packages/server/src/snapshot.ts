/**
 * The deepest path walked before giving up. oRPC's recursive serializer overflows the stack long
 * before this (roughly 16-18k plain objects deep on Bun's default stack, depending on the caller's
 * stack, and fewer for arrays and Maps), so no output it could encode today is rejected.
 */
const MAX_DEPTH = 100_000;

/** An array item captured by copyOf's `map` callback; the walk unwraps it wherever it turns up. */
class Captured {
  constructor(readonly item: unknown) {}
}

/**
 * Whether the walk descends into `value`: a Captured item, or what oRPC's RPC serializer descends
 * into: a Map, a Set, an array, or what its isObject accepts (a plain object, one without a
 * prototype, or one whose prototype has no constructor). Anything else it encodes as a leaf:
 * primitives, Date, URL, RegExp, Blob, class instances.
 */
function isWalked(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (value instanceof Captured) return true;
  if (value instanceof Map || value instanceof Set || Array.isArray(value)) return true;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype || !(prototype as object).constructor;
}

/**
 * Copies one walked value, reading it through exactly the protocols oRPC 1.16's RPC serializer
 * uses, so an overridden one can't make the two disagree. It yields each walked child to the
 * caller and is sent back that child's copy (a leaf child is its own copy); it returns the value's
 * copy.
 * - Set: the items of `Array.from(set)`. The copy is a Set of their copies; walked items are fresh
 *   copies, so only a leaf or primitive repeated by an overridden Set iterator collapses into one
 *   entry, where oRPC sends it twice (and its client keeps both of a repeated leaf object).
 * - Map: the items of `Array.from(map.entries())`, each walked as oRPC walks it (normally a
 *   `[key, value]` array). The copy is `new Map(itemCopies)`: an item that is no entry object (an
 *   overridden `entries`) fails the call there, naming the procedure, where oRPC's client would
 *   fail decoding it with the same `new Map(json)`; a short, long or repeated entry decodes the
 *   same either way.
 * - Array: the array's own `map`, called with a callback that captures each item, as oRPC calls it
 *   with one that encodes each. What `map` returns is oRPC's raw JSON for the array, with each
 *   callback result in place of the item's JSON; it is walked like any output, a captured item
 *   becoming its item's copy wherever it sits, so the copy has the returned shape (holes stay
 *   holes). Raw values an override returned are walked too, so no cycle hides in them, and copied,
 *   where oRPC would pass them on unwalked, which differs only for a raw value that isn't JSON. All
 *   items are read before any is walked into, where oRPC walks each as `map` reaches it; only
 *   recursion could keep that order.
 * - Anything else: the values of its for...in keys, each read right before it is walked into, as
 *   oRPC does: once, but a `toJSON` key twice. A `toJSON` function is skipped. The copy has no
 *   prototype, so a `__proto__` key stays a key and oRPC re-encodes it as it would the original.
 */
function* copyOf(value: object, name: string): Generator<unknown, unknown, unknown> {
  if (value instanceof Captured) return isWalked(value.item) ? yield value.item : value.item;
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
    const mapped: unknown = value.map((item: unknown) => new Captured(item));
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
 * what the output would have, and having read the output once, as oRPC's serializer would, it
 * keeps getters, overridden `map`s and iterators from being read twice. Leaves are kept by
 * reference.
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
  if (!isWalked(output)) return output;
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
