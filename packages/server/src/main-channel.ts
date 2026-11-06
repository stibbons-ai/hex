// The Main channel: the one conversation where hex reaches Daniel unprompted (a DM on Slack or
// Signal), on the chat adapter the server connects.
import { messageOf } from "@hex/adapters";
import type { Adapter, AdapterPostableMessage } from "chat";
import { Context, Data, Duration, Effect, Layer } from "effect";

/** Posting to the Main channel failed. The message says why, never the posted text. */
export class MainChannelError extends Data.TaggedError("MainChannelError")<{
  readonly message: string;
}> {}

/** Posts to the Main channel. */
export class MainChannel extends Context.Service<
  MainChannel,
  {
    /**
     * Posts `text` (plain text, untrusted values quoted as code spans), without any inbound
     * message: `sent` once the platform accepted it, `off` when no Main channel is configured.
     */
    readonly post: (text: string) => Effect.Effect<"sent" | "off", MainChannelError>;
  }
>()("hex/MainChannel") {}

/** Where the Main channel is: the user's DM on one configured channel, and how text goes there. */
export interface MainChannelTarget {
  /** The channel's platform key, e.g. `slack`. */
  readonly channel: string;
  /** The user whose DM it is, as the platform knows them. */
  readonly user: string;
  /** The adapter the server connects for that channel, able to open a DM. */
  readonly adapter: Adapter & Required<Pick<Adapter, "openDM">>;
  /** `text` as a message to post on that platform, its quoted values kept literal. */
  readonly message: (text: string) => AdapterPostableMessage;
}

/** No Main channel: nothing is posted. */
export const mainChannelOff = Layer.succeed(MainChannel, {
  post: () => Effect.succeed("off" as const),
});

/**
 * How long a post may take by default: the Slack client retries a failing call for about 30 min,
 * and an Intake run waits for its report.
 */
const POST_TIMEOUT: Duration.Input = "30 seconds";

/**
 * The Main channel on `target`'s adapter: opens the user's DM on the first post (kept once
 * opened), then posts there. Posting works once the server has started the channel. A failure, or
 * a post not confirmed within `timeout`, is a {@link MainChannelError}; such a post is not
 * cancelled, so it may still arrive.
 */
export function mainChannelLayer(
  { channel, user, adapter, message }: MainChannelTarget,
  { timeout = POST_TIMEOUT }: { timeout?: Duration.Input } = {},
): Layer.Layer<MainChannel> {
  const limit = Duration.fromInputUnsafe(timeout);
  let dm: string | undefined;
  return Layer.succeed(MainChannel, {
    post: (text) =>
      Effect.tryPromise({
        try: async () => {
          dm ??= await adapter.openDM(user);
          await adapter.postMessage(dm, message(text));
          return "sent" as const;
        },
        catch: (cause) =>
          new MainChannelError({ message: `posting to ${channel} failed: ${messageOf(cause)}` }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: limit,
          orElse: () =>
            Effect.fail(
              new MainChannelError({
                message: `posting to ${channel} was not confirmed within ${Duration.format(limit)}; it may still arrive`,
              }),
            ),
        }),
      ),
  });
}
