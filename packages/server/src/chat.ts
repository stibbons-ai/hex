import { decideSender } from "@hex/domain";
import type { ChannelAllowlists } from "@hex/domain";
import { Agent } from "@mastra/core/agent";
import type {
  ChannelAdapterConfig,
  ChannelHandler,
  ChannelHandlerContext,
} from "@mastra/core/channels";
import type { MastraModelConfig } from "@mastra/core/llm";
import { Memory } from "@mastra/memory";
import type { Adapter } from "chat";

/** Every allowlisted conversation, on every channel, shares this memory resource (Daniel's). */
export const CHAT_RESOURCE_ID = "daniel";

export const CHAT_AGENT_ID = "hex";

/** Posted instead of a failed run's error, which may carry provider details; the log has those. */
export const CHAT_ERROR_REPLY = "Something went wrong; see the hex log.";

const INSTRUCTIONS =
  "You are hex, Daniel's personal assistant. Answer tersely and plainly; say so when you don't know.";

export interface ChatChannel {
  adapter: Adapter;
  /** Sender IDs allowed on this channel; everyone else is ignored. Empty answers no one. */
  allowlist: readonly string[];
  /**
   * Called once the channel has started; throws when it can't work although it connected (Slack:
   * the bot token was rejected).
   */
  verify?: () => void;
}

export interface ChatOptions {
  /** A Mastra model-router string such as `anthropic/claude-sonnet-4-5`; tests pass a mock model. */
  model: MastraModelConfig;
  /** Channels keyed by platform; each key must equal its adapter's `name`. */
  channels: Readonly<Record<string, ChatChannel>>;
}

export interface ChatAgent {
  agent: Agent;
  /** Resolves once every message admitted so far has been handled (answered or failed). */
  settled(): Promise<void>;
}

/** Whether the sender may reach the agent; a denied one is logged, without the message text. */
function admits(
  allowlists: ChannelAllowlists,
  ctx: ChannelHandlerContext,
  platform: string,
  sender: string | undefined,
): boolean {
  if (decideSender(allowlists, platform, sender) === "allow") return true;
  // No message text: a stranger's words are not ours to keep, not even in logs.
  ctx.mastra?.getLogger().warn("hex: ignored message from a sender not on the allowlist", {
    platform,
    sender: sender ?? null,
  });
  return false;
}

/**
 * The chat agent: answers allowlisted senders on every configured channel, with one memory thread
 * per channel conversation under resource {@link CHAT_RESOURCE_ID} and resource-scoped working
 * memory. A sender not on its channel's allowlist never reaches the agent: no reply, nothing
 * stored. Throws when a channel's key differs from its adapter's name, since the allowlist is
 * looked up by that name.
 */
export function createChatAgent({ model, channels }: ChatOptions): ChatAgent {
  const allowlists: Record<string, readonly string[]> = {};
  const adapters: Record<string, ChannelAdapterConfig> = {};
  for (const [platform, { adapter, allowlist }] of Object.entries(channels)) {
    if (adapter.name !== platform) {
      throw new Error(`chat channel "${platform}": its adapter reports platform "${adapter.name}"`);
    }
    allowlists[platform] = allowlist;
    adapters[platform] = {
      adapter,
      formatError: () => CHAT_ERROR_REPLY,
      // Off: in Slack channel threads it calls assistant.threads.setStatus, which needs the
      // assistant:write scope and only works in Slack's assistant threads.
      typingStatus: false,
    };
  }
  // Handler promises cover the whole run: core awaits the agent's stream before returning.
  const inFlight = new Set<Promise<void>>();
  const track = (handling: Promise<void>) => {
    inFlight.add(handling);
    void handling.then(
      () => inFlight.delete(handling),
      () => inFlight.delete(handling),
    );
    return handling;
  };
  const guard: ChannelHandler = async (thread, message, defaultHandler, ctx) => {
    if (admits(allowlists, ctx, thread.adapter.name, message.author.userId)) {
      await track(defaultHandler(thread, message));
    }
  };
  const agent = new Agent({
    id: CHAT_AGENT_ID,
    name: CHAT_AGENT_ID,
    instructions: INSTRUCTIONS,
    model,
    // Storage comes from the Mastra instance (the LibSQL store).
    memory: new Memory({ options: { workingMemory: { enabled: true, scope: "resource" } } }),
    channels: {
      adapters,
      handlers: {
        onDirectMessage: guard,
        onMention: guard,
        onSubscribedMessage: guard,
        // Button clicks (tool approvals) are held to the same allowlist.
        onAction: async (event, defaultHandler, ctx) => {
          if (admits(allowlists, ctx, event.adapter.name, event.user.userId)) {
            await track(defaultHandler());
          }
        },
        onSlashCommand: false,
      },
      // Off: on the first mention in a channel thread, core would store the thread's earlier
      // messages, other people's included, in memory.
      threadContext: { maxMessages: 0 },
      // No add_reaction/remove_reaction tools; nothing hex does needs them.
      tools: false,
      resolveResourceId: () => CHAT_RESOURCE_ID,
    },
  });
  return {
    agent,
    settled: async () => {
      await Promise.allSettled(inFlight);
    },
  };
}
