import { isAbsolute, relative, sep } from "node:path";

/** Whether `path` is `root` or lies below it, compared lexically (no symlinks resolved). */
export function isWithin(root: string, path: string): boolean {
  const inside = relative(root, path);
  return inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}
