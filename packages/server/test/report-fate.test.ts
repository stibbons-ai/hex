import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer } from "effect";
import { MainChannel } from "../src/main-channel";
import { postReport } from "../src/report-fate";

const intake = {
  messageId: "<interrupt@shop.example>",
  receivedAt: "2026-11-02T07:15:00.000Z",
  cidReferences: [],
  attachments: [],
};

test("a post interrupted is no report fate: the interrupt reaches the run", async () => {
  const exit = await Effect.runPromiseExit(
    postReport(intake, { filings: [], forwardings: [], outcome: { status: "processed" } }).pipe(
      Effect.provide(Layer.succeed(MainChannel, { post: () => Effect.interrupt })),
    ),
  );
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
});
