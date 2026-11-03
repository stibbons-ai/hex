import { decideSender } from "@hex/domain";
import type { ChannelAllowlists } from "@hex/domain";
import { Agent } from "@mastra/core/agent";
import type { ChannelHandler, ChannelHandlerContext } from "@mastra/core/channels";
import type { MastraModelConfig } from "@mastra/core/llm";
import { Memory } from "@mastra/memory";
import type { Adapter } from "chat";

/** Every allowlisted conversation, on every channel, shares this memory resource (Daniel's). */
export const CHAT_RESOURCE_ID = "daniel";

export const CHAT_AGENT_ID = "hex";

const INSTRUCTIONS =
  "You are hex, Daniel's personal assistant. Answer tersely and plainly; say so when you don't know.";

export interface ChatOptions {
  /** A Mastra model-router string such as `anthropic/claude-sonnet-4-5`; tests pass a mock model. */
  model: MastraModelConfig;
  /** Chat adapters keyed by platform; each key equals its adapter's `name`. */
  adapters: Readonly<Record<string, Adapter>>;
  /** Sender IDs allowed per platform; everyone else is ignored. */
  allowlists: ChannelAllowlists;
}

function logIgnored(ctx: ChannelHandlerContext, channel: string, sender: string | undefined) {
  // No message text: a stranger's words are not ours to keep, not even in logs.
  ctx.mastra?.getLogger().warn("hex: ignored message from a sender not on the allowlist", {
    channel,
    sender: sender ?? null,
  });
}

/**
 * The chat agent: answers allowlisted senders on every configured channel, with one memory thread
 * per channel conversation under resource {@link CHAT_RESOURCE_ID} and working memory on.
 * A sender not on its channel's allowlist never reaches the agent: no reply, nothing stored.
 */
export function createChatAgent({ model, adapters, allowlists }: ChatOptions): Agent {
  const guard: ChannelHandler = async (thread, message, defaultHandler, ctx) => {
    const channel = thread.adapter.name;
    const sender = message.author.userId;
    if (decideSender(allowlists, channel, sender) === "allow") {
      await defaultHandler(thread, message);
    } else {
      logIgnored(ctx, channel, sender);
    }
  };
  return new Agent({
    id: CHAT_AGENT_ID,
    name: CHAT_AGENT_ID,
    instructions: INSTRUCTIONS,
    model,
    // Storage comes from the Mastra instance (the LibSQL store).
    memory: new Memory({ options: { workingMemory: { enabled: true } } }),
    channels: {
      adapters: { ...adapters },
      handlers: {
        onDirectMessage: guard,
        onMention: guard,
        onSubscribedMessage: guard,
        // Button clicks (tool approvals) are held to the same allowlist.
        onAction: async (event, defaultHandler, ctx) => {
          const channel = event.adapter.name;
          const sender = event.user.userId;
          if (decideSender(allowlists, channel, sender) === "allow") await defaultHandler();
          else logIgnored(ctx, channel, sender);
        },
        onSlashCommand: false,
      },
      // Off: on the first mention in a channel thread, core would store the thread's earlier
      // messages, other people's included, in memory.
      threadContext: { maxMessages: 0 },
      resolveResourceId: () => CHAT_RESOURCE_ID,
    },
  });
}

/** Disconnects every adapter (Slack: closes the socket), even after a failure. */
export async function disconnectAdapters(adapters: Readonly<Record<string, Adapter>>) {
  const results = await Promise.allSettled(
    Object.values(adapters).map(async (adapter) => adapter.disconnect?.()),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Several chat adapters failed to disconnect");
}
