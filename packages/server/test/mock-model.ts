import type { MastraModelConfig } from "@mastra/core/llm";
import {
  MastraLanguageModelV2Mock,
  createMockModel,
  simulateReadableStream,
} from "@mastra/core/test-utils/llm-mock";

export const REPLY = "hello from hex";

/** The one method the wrapper replaces; `createMockModel`'s type is a V1/V2 union. */
interface Streaming {
  doStream(options: unknown): Promise<unknown>;
}

/** Runs with a model call's options before its answer streams. */
type Before = (options: unknown) => Promise<void>;

/** Runs `before` with each model call's options before its answer streams. */
function withBefore(model: object, before?: Before) {
  if (!before) return;
  const streaming = model as Streaming;
  const doStream = streaming.doStream.bind(model);
  streaming.doStream = async (options) => {
    await before(options);
    return doStream(options);
  };
}

/**
 * A model that answers {@link REPLY}. `before` runs before each answer streams, with the call's
 * options: await something to hold the run open, or throw to fail it.
 */
export function mockModel({ before }: { before?: Before } = {}): MastraModelConfig {
  const model = createMockModel({ mockText: REPLY, version: "v2" });
  withBefore(model, before);
  return model as MastraModelConfig;
}

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function step(chunks: unknown[]) {
  return {
    stream: simulateReadableStream({ chunks: [{ type: "stream-start", warnings: [] }, ...chunks] }),
  };
}

function answer(text: string) {
  return step([
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: text },
    { type: "text-end", id: "text-1" },
    { type: "finish", finishReason: "stop", usage: USAGE },
  ]);
}

type MockOptions = ConstructorParameters<typeof MastraLanguageModelV2Mock>[0];

/**
 * A model whose first step calls hex's `updateWorkingMemory` tool with `args`, and whose
 * second answers {@link REPLY}; each of `laterCalls` more model calls answers {@link REPLY} too.
 * `before` runs before each step streams, as for {@link mockModel}.
 */
export function toolCallingModel(
  args: Record<string, unknown>,
  { before, laterCalls = 0 }: { before?: Before; laterCalls?: number } = {},
): MastraModelConfig {
  const model = new MastraLanguageModelV2Mock({
    doStream: [
      step([
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "updateWorkingMemory",
          input: JSON.stringify(args),
        },
        { type: "finish", finishReason: "tool-calls", usage: USAGE },
      ]),
      answer(REPLY),
      ...Array.from({ length: laterCalls }, () => answer(REPLY)),
    ],
  } as MockOptions);
  withBefore(model, before);
  // Mastra's mock and its model type disagree under exactOptionalPropertyTypes.
  return model as MastraModelConfig;
}

/** A model whose n-th call (from 1) answers `reply n`, so a reply names the call that wrote it. */
export function numberedModel({ before }: { before?: Before } = {}): MastraModelConfig {
  let calls = 0;
  const model = new MastraLanguageModelV2Mock({
    doStream: async () => answer(`reply ${++calls}`),
  } as MockOptions);
  withBefore(model, before);
  return model as MastraModelConfig;
}

/**
 * A {@link numberedModel} that records every call's prompt and holds call `held` (from 1) until
 * `release()`; `busy` resolves once that call has started.
 */
export function heldModel(held = 1) {
  const busy = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const prompts: string[] = [];
  const model = numberedModel({
    before: async (call) => {
      prompts.push(JSON.stringify(call));
      if (prompts.length === held) {
        busy.resolve();
        await release.promise;
      }
    },
  });
  return { model, prompts, busy: busy.promise, release: () => release.resolve() };
}
