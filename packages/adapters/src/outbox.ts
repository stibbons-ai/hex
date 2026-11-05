import { randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { freeFileName } from "@hex/domain";
import { Context, Data, Effect, Layer } from "effect";

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
     * Writes `content` as `name` into `folder` (relative to the Outbox, e.g. `2026-11/ER`) and
     * returns the path it landed at, relative to the Outbox, with `/` separators. Never
     * overwrites: a taken name becomes `name (1).ext`, `name (2).ext`, … (see `freeFileName`).
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

/**
 * Atomic, never-overwriting write: the content goes to a uniquely named `<name>.<id>.partial`
 * in the target folder first (hex-sync skips `*.partial`), is flushed, then hard-linked to the
 * final name. `link()` fails with EEXIST instead of replacing an existing file (a `rename()`
 * would replace it), so a name taken meanwhile, by a concurrent write or anything else, moves
 * on to the next free name. The `.partial` is removed in every case.
 */
async function writeNew(root: string, folder: string, name: string, content: Uint8Array) {
  const directory = resolve(root, folder);
  const inside = relative(root, join(directory, name));
  if (
    !name ||
    /[/\\\0]/.test(name) ||
    name === "." ||
    name === ".." ||
    /\.partial$/i.test(name) ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside)
  ) {
    throw new Error(`not a safe file name in the Outbox: ${JSON.stringify(name)}`);
  }
  await mkdir(directory, { recursive: true });
  const partial = join(directory, `${name}.${randomUUID()}.partial`);
  try {
    const handle = await open(partial, "wx");
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const taken = new Set(await readdir(directory));
    for (;;) {
      const candidate = freeFileName(name, taken);
      try {
        await link(partial, join(directory, candidate));
        return relative(root, join(directory, candidate)).split(/[/\\]/).join("/");
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        taken.add(candidate);
      }
    }
  } finally {
    await unlink(partial).catch((error: unknown) => {
      if (!isErrno(error, "ENOENT")) throw error;
    });
  }
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
            message: `filing ${JSON.stringify(name)} into ${folder} failed: ${(cause as Error).message}`,
            cause,
          }),
      }),
  });
}
