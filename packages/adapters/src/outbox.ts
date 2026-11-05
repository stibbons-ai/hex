import { randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { freeFileName, isSafeFileName } from "@hex/domain";
import { Context, Data, Effect, Layer } from "effect";
import { messageOf } from "./errors";

/** A Document that could not be filed; the message says where and why. */
export class OutboxError extends Data.TaggedError("OutboxError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Where Filing places Documents until hex-sync moves them into the Archive. */
export class Outbox extends Context.Service<
  Outbox,
  {
    /**
     * Writes `content` as `name` (which must pass `isSafeFileName`) into `folder` (relative to the
     * Outbox, e.g. `2026-11/ER`) and returns the path it landed at, relative to the Outbox, with
     * `/` separators. Never overwrites: a taken name becomes `name (1).ext`, `name (2).ext`, …
     * (see `freeFileName`).
     */
    readonly file: (
      folder: string,
      name: string,
      content: Uint8Array,
    ) => Effect.Effect<string, OutboxError>;
  }
>()("hex/Outbox") {}

const isErrno = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;

/** Flushes a directory, so the entries just created in it survive a power loss. */
async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Writes `content` to the new file `path` and flushes it; a close error never hides a write error. */
async function writeFlushed(path: string, content: Uint8Array) {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(content);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
  await handle.close();
}

/** Hard-links `partial` to the first free name in `directory`; returns that name. */
async function linkToFreeName(partial: string, directory: string, name: string) {
  // The folder is listed only after a clash: usually the name is free.
  let taken: Set<string> | undefined;
  let candidate = name;
  for (;;) {
    try {
      await link(partial, join(directory, candidate));
      return candidate;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      taken ??= new Set(await readdir(directory));
      taken.add(candidate);
      candidate = freeFileName(name, taken);
    }
  }
}

/**
 * Atomic, never-overwriting write: the content goes to a uniquely named `<name>.<id>.partial`
 * in the target folder first (hex-sync skips `*.partial`), is flushed, then hard-linked to the
 * final name. `link()` fails with EEXIST instead of replacing an existing file (a `rename()`
 * would replace it), so a name taken meanwhile, by a concurrent write or anything else, moves
 * on to the next free name. The folder (and every folder created for it) is flushed after the
 * link. On an error the `.partial` is removed and the first error is kept; once the link exists
 * the Document is filed, and a `.partial` that can't be removed is only reported in
 * `leftover`. A crash or kill can still leave a `.partial` behind.
 */
async function writeNew(root: string, folder: string, name: string, content: Uint8Array) {
  const directory = resolve(root, folder);
  const inside = relative(root, directory);
  if (
    !isSafeFileName(name) ||
    inside === ".." ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside)
  ) {
    throw new Error(`not a safe file name in the Outbox: ${JSON.stringify(name)}`);
  }
  const created = await mkdir(directory, { recursive: true });
  const partial = join(directory, `${name}.${randomUUID()}.partial`);
  let filed: string;
  try {
    await writeFlushed(partial, content);
    filed = await linkToFreeName(partial, directory, name);
    await syncDirectory(directory);
    // Each folder mkdir created is an entry in its parent: flush those parents too.
    for (let parent = directory; created !== undefined && parent !== dirname(created);) {
      parent = dirname(parent);
      await syncDirectory(parent);
    }
  } catch (error) {
    await unlink(partial).catch(() => {});
    throw error;
  }
  const leftover = await unlink(partial).then(
    () => undefined,
    (error: unknown) => (isErrno(error, "ENOENT") ? undefined : error),
  );
  return { path: relative(root, join(directory, filed)).split(/[/\\]/).join("/"), leftover };
}

/** The Outbox at `root` (created on first use). */
export function outboxLayer(root: string): Layer.Layer<Outbox> {
  const absoluteRoot = resolve(root);
  return Layer.succeed(Outbox, {
    file: (folder, name, content) =>
      Effect.tryPromise({
        try: () => writeNew(absoluteRoot, folder, name, content),
        catch: (cause) =>
          new OutboxError({
            message: `filing ${JSON.stringify(name)} into ${folder} failed: ${messageOf(cause)}`,
            cause,
          }),
      }).pipe(
        Effect.tap(({ path, leftover }) =>
          leftover === undefined
            ? Effect.void
            : Effect.logWarning(
                `Outbox: filed ${path}, but its .partial stays behind: ${messageOf(leftover)}`,
              ),
        ),
        Effect.map(({ path }) => path),
      ),
  });
}
