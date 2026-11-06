// The Main channel for tests: records every report text it accepts, and fails as scripted,
// standing in for the chat adapter as the recording Mailer stands in for SMTP.
import { Effect, Layer } from "effect";
import { MainChannel, MainChannelError } from "../src/main-channel";

/** A recording Main channel: `posted` holds each accepted text, in order. */
export function recordingMainChannel() {
  let failures = 0;
  let defects = 0;
  const recording = {
    posted: [] as string[],
    /** Called on each post, before it is accepted or failed: a test looks at the state then. */
    onPost: undefined as (() => void) | undefined,
    /** Fails the next `times` posts, as a platform refusing them would. */
    failNext(times = 1) {
      failures = times;
    },
    /** Dies on the next `times` posts, as an adapter throwing where nobody expects it would. */
    dieNext(times = 1) {
      defects = times;
    },
    layer: Layer.succeed(MainChannel, {
      post: (text) =>
        Effect.suspend(() => {
          recording.onPost?.();
          if (defects > 0) {
            defects--;
            return Effect.die(new TypeError("adapter.postMessage is not a function"));
          }
          if (failures > 0) {
            failures--;
            return Effect.fail(
              new MainChannelError({ message: "posting to slack failed: channel_not_found" }),
            );
          }
          recording.posted.push(text);
          return Effect.succeed("sent" as const);
        }),
    }),
  };
  return recording;
}
