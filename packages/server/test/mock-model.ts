import type { MastraModelConfig } from "@mastra/core/llm";
import { createMockModel } from "@mastra/core/test-utils/llm-mock";

export const REPLY = "hello from hex";

/** The one method the wrapper replaces; `createMockModel`'s type is a V1/V2 union. */
interface Streaming {
  doStream(options: unknown): Promise<unknown>;
}

/**
 * A model that answers {@link REPLY}. `before` runs before each answer streams: await something to
 * hold the run open, or throw to fail it.
 */
export function mockModel({ before }: { before?: () => Promise<void> } = {}): MastraModelConfig {
  const model = createMockModel({ mockText: REPLY, version: "v2" });
  if (before) {
    const streaming = model as unknown as Streaming;
    const doStream = streaming.doStream.bind(model);
    streaming.doStream = async (options) => {
      await before();
      return doStream(options);
    };
  }
  return model as MastraModelConfig;
}
