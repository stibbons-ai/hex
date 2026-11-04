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

/**
 * A model whose first step calls hex's `updateWorkingMemory` tool with `args`, and whose
 * second answers {@link REPLY}; each of `laterRuns` more calls answers {@link REPLY} too.
 * `before` runs before each step streams, as for {@link mockModel}.
 */
export function toolCallingModel(
  args: Record<string, unknown>,
  { before, laterRuns = 0 }: { before?: Before; laterRuns?: number } = {},
): MastraModelConfig {
  const step = (chunks: unknown[]) => ({
    stream: simulateReadableStream({ chunks: [{ type: "stream-start", warnings: [] }, ...chunks] }),
  });
  const answer = () =>
    step([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: REPLY },
      { type: "text-end", id: "text-1" },
      { type: "finish", finishReason: "stop", usage: USAGE },
    ]);
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
      answer(),
      ...Array.from({ length: laterRuns }, answer),
    ],
  } as ConstructorParameters<typeof MastraLanguageModelV2Mock>[0]);
  withBefore(model, before);
  // Mastra's mock and its model type disagree under exactOptionalPropertyTypes.
  return model as MastraModelConfig;
}
