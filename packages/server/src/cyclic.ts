/** Marks, on the stack, that the value below it has had all its children checked. */
const LEFT = Symbol("left");

/**
 * The deepest path walked before giving up. oRPC's recursive serializer overflows the stack long
 * before this (about 19k plain objects deep on Bun's default stack, fewer for arrays and Maps), so
 * no output it could encode today is rejected.
 */
const MAX_DEPTH = 100_000;

/**
 * Whether oRPC's RPC serializer descends into `value`: a Map, a Set, an array, or what its
 * isObject accepts (a plain object, one without a prototype, or one whose prototype has no
 * constructor). Anything else it encodes as a leaf: primitives, Date, URL, RegExp, Blob, class
 * instances.
 */
function isWalked(value: unknown): value is object {
  if (!value || typeof value !== "object") return false;
  if (value instanceof Map || value instanceof Set || Array.isArray(value)) return true;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype || !(prototype as object).constructor;
}

/**
 * Pushes what the serializer walks inside `value`: Map keys and values, Set and array values, else
 * the values of for...in keys.
 */
function pushChildren(value: object, stack: unknown[]): void {
  if (value instanceof Map) {
    for (const [key, entry] of value) stack.push(key, entry);
  } else if (value instanceof Set || Array.isArray(value)) {
    for (const child of value) stack.push(child);
  } else {
    for (const key in value) stack.push((value as Record<string, unknown>)[key]);
  }
}

/**
 * Whether `value` contains itself, or nests deeper than oRPC's serializer could ever encode, where
 * that serializer would look. oRPC finds a cycle only by recursing until the stack overflows, which
 * blocks the event loop for seconds; this answers in time linear in what the serializer would walk
 * anyway. The depth bound also ends a value that hands out a fresh object on every read.
 *
 * Iterative, so a deep value can't overflow the stack here either. It tracks the current path from
 * the root, not every value seen: a value reached twice through different parents is shared, which
 * serializes fine (as two copies); only one reached again below itself is a cycle.
 */
export function isCyclicOrTooDeep(value: unknown): boolean {
  const path = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === LEFT) {
      path.delete(stack.pop() as object);
      continue;
    }
    if (!isWalked(next)) continue;
    if (path.has(next) || path.size >= MAX_DEPTH) return true;
    path.add(next);
    stack.push(next, LEFT);
    pushChildren(next, stack);
  }
  return false;
}
