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

test("a DM that failed to open is opened again on the next post", async () => {
  const opens: string[] = [];
  const posts: string[] = [];
  const adapter = {
    openDM: async (user: string) => {
      opens.push(user);
      if (opens.length === 1) throw new Error("ratelimited");
      return "D0DANIEL";
    },
    postMessage: async (dm: string) => {
      posts.push(dm);
    },
  } as unknown as MainChannelTarget["adapter"];
  const layer = mainChannelLayer({
    channel: "slack",
    user: "U0DANIEL",
    adapter,
    message: (text) => text,
  });
  const post = MainChannel.use((channel) => channel.post("Intake processed: `x`"));
  const results = await Effect.runPromise(
    Effect.all([Effect.flip(post), post]).pipe(Effect.provide(layer)),
  );
  expect(results).toMatchObject([
    { _tag: "MainChannelError", message: "posting to slack failed: ratelimited" },
    "sent",
  ]);
  expect(opens).toEqual(["U0DANIEL", "U0DANIEL"]);
  expect(posts).toEqual(["D0DANIEL"]);
});
