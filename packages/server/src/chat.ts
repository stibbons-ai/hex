import { withHexApiKey } from "@hex/adapters";
import { decideSender } from "@hex/domain";
import { Agent } from "@mastra/core/agent";
import type { AgentConfig, AgentExecutionOptions } from "@mastra/core/agent";
import type {
  ChannelAdapterConfig,
  ChannelHandler,
  ChannelHandlerContext,
} from "@mastra/core/channels";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { IMastraLogger } from "@mastra/core/logger";
import { Memory } from "@mastra/memory";
import type { Adapter } from "chat";
import { ChatState, type ChatStores } from "./chat-state";

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
  /**
   * Answer direct messages only: a message in any other conversation is ignored and logged.
   * Messages only; button clicks are not checked (no hex tool posts buttons).
   */
  directMessagesOnly?: boolean;
}

/** Provider-keyed options passed unchanged to the model, e.g. `{ anthropic: { effort: "low" } }`. */
export type ProviderOptions = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

type AgentProviderOptions = NonNullable<AgentExecutionOptions["providerOptions"]>;

type StepContent = Parameters<NonNullable<AgentExecutionOptions["onStepFinish"]>>[0]["content"];

export interface ChatOptions {
  /**
   * A Mastra model-router string such as `anthropic/claude-opus-5-5`, its API key from
   * `HEX_<provider variable>` (see `withHexApiKey`); tests pass a mock model.
   */
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
   * runs admitted while waiting. Does not wait for messages still queued behind a run: each is
   * admitted when its turn comes, or after close() logged and dropped. Approval-click runs are not
   * covered: core doesn't await them.
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
 * Why a finished tool call failed, by kind only: the failure's text can quote the call's args,
 * and hex's are working-memory content. `undefined` when it succeeded.
 */
function toolFailure(
  part: Extract<StepContent[number], { type: "tool-result" | "tool-error" }>,
): string | undefined {
  if (part.type === "tool-error") return "error";
  // Mastra hands the model a thrown error or an unknown tool as error text, and input that failed
  // validation as a JSON result with `error: true`.
  const output = part.output as { type?: string; value?: unknown } | undefined;
  if (output?.type?.startsWith("error-")) return "error";
  const value = output?.value as { error?: unknown } | null | undefined;
  return output?.type === "json" && value?.error === true ? "invalid input" : undefined;
}

/** One line per finished tool call, never its args or result: tool cards are hidden in chat. */
function logToolCalls(logger: IMastraLogger | undefined, content: StepContent) {
  for (const part of content) {
    if (part.type !== "tool-result" && part.type !== "tool-error") continue;
    const call = { tool: part.toolName, toolCallId: part.toolCallId };
    const error = toolFailure(part);
    if (error === undefined) logger?.info("hex: tool call", { ...call, ok: true });
    else logger?.warn("hex: tool call", { ...call, ok: false, error });
  }
}

/** The chat agent's model settings, without its channels. */
export type ChatModel = Pick<ChatOptions, "model" | "providerOptions">;

/** The chat agent, channels aside: what every hex chat agent shares. */
function chatAgentConfig(
  { model, providerOptions }: ChatModel,
  getAgent: () => Agent,
): AgentConfig {
  return {
    id: CHAT_AGENT_ID,
    name: CHAT_AGENT_ID,
    instructions: INSTRUCTIONS,
    model: withHexApiKey(model),
    // Every run, the Channels-triggered ones included, merges these defaults into its options.
    defaultOptions: {
      onStepFinish: ({ content }) =>
        logToolCalls(getAgent().getMastraInstance()?.getLogger(), content),
      // Mastra types the known providers' options; ours come from the config as data.
      ...(providerOptions ? { providerOptions: providerOptions as AgentProviderOptions } : {}),
    },
    // Storage comes from the Mastra instance (the LibSQL store).
    memory: new Memory({ options: { workingMemory: { enabled: true, scope: "resource" } } }),
  };
}

/**
 * The chat agent without channels, for Mastra Studio: the same agent, memory and model, called
 * from Studio only; it never connects to a chat platform.
 */
export function createStudioChatAgent(model: ChatModel): Agent {
  const agent: Agent = new Agent(chatAgentConfig(model, () => agent));
  return agent;
}

/**
 * The chat agent: answers allowlisted senders on every configured channel, with one memory thread
 * per channel conversation under resource {@link CHAT_RESOURCE_ID} and resource-scoped working
 * memory. A sender not on its channel's allowlist never reaches the agent: no reply, nothing
 * persisted. Neither does a message outside a direct message on a `directMessagesOnly` channel.
 * Throws when there are no channels, or when a channel's key differs from its adapter's name,
 * since the allowlist is looked up by that name.
 */
export function createChatAgent(
  { channels, ...model }: ChatOptions,
  stores: ChatStores,
): ChatAgent {
  const entries = Object.entries(channels);
  if (entries.length === 0) throw new Error("chat needs at least one channel");
  const allowlists: Record<string, readonly string[]> = {};
  const directOnly = new Set<string>();
  const adapters: Record<string, ChannelAdapterConfig> = {};
  for (const [platform, { adapter, allowlist, directMessagesOnly }] of entries) {
    if (adapter.name !== platform) {
      throw new Error(`chat channel "${platform}": its adapter reports platform "${adapter.name}"`);
    }
    allowlists[platform] = allowlist;
    if (directMessagesOnly) directOnly.add(platform);
    adapters[platform] = {
      adapter,
      formatError: () => CHAT_ERROR_REPLY,
      // Off: Slack's typing status (assistant.threads.setStatus) targets its assistant threads,
      // not the DMs and channel threads hex answers in.
      typingStatus: false,
      // Hidden: a tool card posts the call's args and result, working memory included, which a
      // channel thread makes public. Approvals would still post as cards; no hex tool needs one.
      toolDisplay: "hidden",
    };
  }
  // Handler promises cover the whole run: core awaits the agent's stream before returning. Under
  // the "queue" strategy (below) no message joins a run already going; queued messages wait and
  // are handed over in later turns.
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
  // Under "queue", messages queued behind a busy run reach Mastra as one batch per conversation,
  // senders mixed (chat 4.43 drainQueue). Mastra 1.80 (dispatchBatch, dist/agent-b2Y5GsZg.js:51998)
  // splits it into runs of consecutive messages from one author and calls this once per run, with
  // the run's earlier messages in `ctx.skipped`: `message.author` speaks for the whole turn. The
  // test "messages queued behind a busy run are one turn per sender…" pins it.
  const guard: ChannelHandler = async (thread, message, defaultHandler, ctx) => {
    const platform = thread.adapter.name;
    if (directOnly.has(platform) && !thread.isDM) {
      logIgnored(ctx, "outside a direct message", platform, message.author.userId);
      return;
    }
    if (admits(ctx, platform, message.author.userId)) {
      await track(defaultHandler(thread, message));
    }
  };
  const agent: Agent = new Agent({
    ...chatAgentConfig(model, () => agent),
    channels: {
      adapters,
      // Mastra's own state adapter, built as core would build it (the agent's id as owner), but
      // with the Signal receive cursor persisted.
      state: new ChatState(stores, () => agent.id),
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
      // One handler at a time per conversation; messages arriving meanwhile wait their turn.
      // Mastra's default, "concurrent", streams such a message into the busy run and finishes it
      // in a run nobody awaits (stop() could close storage under it), and races two first
      // messages of a new conversation into two memory threads; this per-conversation lock fixes
      // both. Given up on purpose: a message joining the run in progress. hex is single-user, and
      // one complete history per conversation is worth more. Chat SDK defaults hold, and both
      // limits lose messages without an answer or a line in hex's log: at most 10 wait per
      // conversation, anyone's counting (they are queued before the allowlist guard, so others in
      // a Slack channel thread can push Daniel's out), beyond that the oldest is dropped; a
      // message still waiting after 90 s is dropped when its turn comes.
      chatOptions: { concurrency: { strategy: "queue" } },
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
