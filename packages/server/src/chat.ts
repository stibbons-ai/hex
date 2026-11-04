import { decideSender } from "@hex/domain";
import { Agent } from "@mastra/core/agent";
import type { AgentExecutionOptions } from "@mastra/core/agent";
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
   * Called once the channel has started; throws when it can't work although it connected. An
   * adapter that only warns on an auth failure must supply it (Slack: the bot token was rejected).
   */
  verify?: () => void;
}

/** Provider-keyed options passed unchanged to the model, e.g. `{ anthropic: { effort: "low" } }`. */
export type ProviderOptions = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

type AgentProviderOptions = NonNullable<AgentExecutionOptions["providerOptions"]>;

export interface ChatOptions {
  /** A Mastra model-router string such as `anthropic/claude-opus-5-5`; tests pass a mock model. */
  model: MastraModelConfig;
  /** Passed to every model call of the chat agent; omitted uses the provider's defaults. */
  providerOptions?: ProviderOptions;
  /** Channels keyed by platform; each key must equal its adapter's `name`. */
  channels: Readonly<Record<string, ChatChannel>>;
}

export interface ChatAgent {
  agent: Agent;
  /** From now on, admits no message: each is logged (without its text) and dropped. */
  close(): void;
  /**
   * Resolves once every admitted message run has been handled (answered or failed), including
   * runs admitted while waiting. Approval-click runs are not covered: core doesn't await them.
   */
  settled(): Promise<void>;
  /** Admitted message runs not yet handled. */
  pending(): number;
}

function logIgnored(ctx: ChannelHandlerContext, reason: string, platform: string, sender?: string) {
  // No message text: a stranger's words are not ours to keep, not even in logs.
  ctx.mastra?.getLogger().warn(`hex: ignored message ${reason}`, {
    platform,
    sender: sender ?? null,
  });
}

/**
 * The chat agent: answers allowlisted senders on every configured channel, with one memory thread
 * per channel conversation under resource {@link CHAT_RESOURCE_ID} and resource-scoped working
 * memory. A sender not on its channel's allowlist never reaches the agent: no reply, nothing
 * stored. Throws when there are no channels, or when a channel's key differs from its adapter's
 * name, since the allowlist is looked up by that name.
 */
export function createChatAgent({ model, providerOptions, channels }: ChatOptions): ChatAgent {
  const entries = Object.entries(channels);
  if (entries.length === 0) throw new Error("chat needs at least one channel");
  const allowlists: Record<string, readonly string[]> = {};
  const adapters: Record<string, ChannelAdapterConfig> = {};
  for (const [platform, { adapter, allowlist }] of entries) {
    if (adapter.name !== platform) {
      throw new Error(`chat channel "${platform}": its adapter reports platform "${adapter.name}"`);
    }
    allowlists[platform] = allowlist;
    adapters[platform] = {
      adapter,
      formatError: () => CHAT_ERROR_REPLY,
      // Off: Slack's typing status (assistant.threads.setStatus) targets its assistant threads,
      // not the DMs and channel threads hex answers in.
      typingStatus: false,
    };
  }
  // Handler promises cover the whole run: core awaits the agent's stream before returning.
  const inFlight = new Set<Promise<void>>();
  let closing = false;
  const admits = (ctx: ChannelHandlerContext, platform: string, sender: string | undefined) => {
    if (closing) {
      logIgnored(ctx, "while hex is shutting down", platform, sender);
      return false;
    }
    if (decideSender(allowlists, platform, sender) === "allow") return true;
    logIgnored(ctx, "from a sender not on the allowlist", platform, sender);
    return false;
  };
  const track = (handling: Promise<void>) => {
    inFlight.add(handling);
    void handling.then(
      () => inFlight.delete(handling),
      () => inFlight.delete(handling),
    );
    return handling;
  };
  const guard: ChannelHandler = async (thread, message, defaultHandler, ctx) => {
    if (admits(ctx, thread.adapter.name, message.author.userId)) {
      await track(defaultHandler(thread, message));
    }
  };
  const agent = new Agent({
    id: CHAT_AGENT_ID,
    name: CHAT_AGENT_ID,
    instructions: INSTRUCTIONS,
    model,
    // Every run, the Channels-triggered ones included, merges these defaults into its options.
    // Mastra types the known providers' options; ours come from the config as data.
    ...(providerOptions
      ? { defaultOptions: { providerOptions: providerOptions as AgentProviderOptions } }
      : {}),
    // Storage comes from the Mastra instance (the LibSQL store).
    memory: new Memory({ options: { workingMemory: { enabled: true, scope: "resource" } } }),
    channels: {
      adapters,
      handlers: {
        onDirectMessage: guard,
        onMention: guard,
        onSubscribedMessage: guard,
        // Button clicks (tool approvals) are guarded too, if interactivity is ever enabled.
        onAction: async (event, defaultHandler, ctx) => {
          if (admits(ctx, event.adapter.name, event.user.userId)) {
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
    close: () => {
      closing = true;
    },
    settled: async () => {
      while (inFlight.size > 0) await Promise.allSettled(inFlight);
    },
    pending: () => inFlight.size,
  };
}
