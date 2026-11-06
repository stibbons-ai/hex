import { expect, test } from "bun:test";
import { Effect } from "effect";
import { MainChannel, mainChannelLayer } from "../src/main-channel";
import type { MainChannelTarget } from "../src/main-channel";
import { hangingAdapter } from "./hanging-adapter";

test("a post the platform never confirms fails once the timeout is up, saying it may still arrive", async () => {
  const target: MainChannelTarget = {
    channel: "slack",
    user: "U0DANIEL",
    adapter: hangingAdapter(),
    message: (text) => text,
  };
  const failed = await Effect.runPromise(
    MainChannel.use((channel) => channel.post("Intake processed: `x`")).pipe(
      Effect.flip,
      Effect.provide(mainChannelLayer(target, { timeout: "20 millis" })),
    ),
  );
  expect(failed).toMatchObject({
    _tag: "MainChannelError",
    message: "posting to slack was not confirmed within 20ms; it may still arrive",
  });
});
