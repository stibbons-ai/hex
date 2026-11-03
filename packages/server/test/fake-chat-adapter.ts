import { Message, parseMarkdown, stringifyMarkdown } from "chat";
import type {
  Adapter,
  AdapterPostableMessage,
  ChatInstance,
  FetchResult,
  FormattedContent,
  RawMessage,
  ThreadInfo,
} from "chat";

export interface Incoming {
  /** Conversation key; `dm-*` conversations are direct messages, others channel threads. */
  conversation: string;
  sender: string;
  text: string;
  /** In a channel thread, whether the message @-mentions the bot. */
  mention?: boolean;
}

/**
 * A chat platform in memory: `receive` delivers a message the way a platform adapter does and
 * waits until the Chat SDK has handled it; replies land in `posted`.
 */
export class FakeChatAdapter implements Adapter {
  readonly name = "fake";
  readonly userName = "hex";
  readonly botUserId = "U0BOT";
  readonly posted: { threadId: string; text: string }[] = [];
  connected = false;
  disconnects = 0;
  /** Set to make the next connect fail. */
  connectError: Error | undefined;
  #chat: ChatInstance | undefined;
  #ids = 0;
  #waiters: { count: number; resolve: () => void }[] = [];

  /** Resolves once `count` messages have been posted (the reply follows the run, unawaited). */
  posts(count: number): Promise<void> {
    if (this.posted.length >= count) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#waiters.push({ count, resolve });
    return promise;
  }

  async initialize(chat: ChatInstance): Promise<void> {
    if (this.connectError) throw this.connectError;
    this.#chat = chat;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.disconnects++;
  }

  /** Delivers a message and resolves once the Chat SDK's handler for it has returned. */
  async receive({ conversation, sender, text, mention = false }: Incoming): Promise<void> {
    if (!this.#chat) throw new Error("fake adapter not connected");
    const threadId = `fake:${conversation}`;
    const message = new Message({
      id: `in-${++this.#ids}`,
      threadId,
      text,
      formatted: parseMarkdown(text),
      author: { userId: sender, userName: sender, fullName: sender, isBot: false, isMe: false },
      metadata: { dateSent: new Date(), edited: false },
      attachments: [],
      isMention: mention,
      raw: {},
    });
    const tasks: Promise<unknown>[] = [];
    await this.#chat.processMessage(this, threadId, message, {
      waitUntil: (task) => void tasks.push(task),
    });
    await Promise.all(tasks);
  }

  isDM(threadId: string): boolean {
    return threadId.startsWith("fake:dm-");
  }

  channelIdFromThreadId(threadId: string): string {
    return threadId;
  }

  encodeThreadId(platformData: unknown): string {
    return String(platformData);
  }

  decodeThreadId(threadId: string): unknown {
    return threadId;
  }

  async postMessage(threadId: string, message: AdapterPostableMessage): Promise<RawMessage> {
    this.#post(threadId, message);
    return { id: `out-${++this.#ids}`, threadId, raw: {} };
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage> {
    this.#post(threadId, message);
    return { id: messageId, threadId, raw: {} };
  }

  async deleteMessage(): Promise<void> {}
  async addReaction(): Promise<void> {}
  async removeReaction(): Promise<void> {}
  async startTyping(): Promise<void> {}

  async fetchMessages(): Promise<FetchResult> {
    return { messages: [] };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    return { id: threadId, channelId: threadId, isDM: this.isDM(threadId), metadata: {} };
  }

  async handleWebhook(): Promise<Response> {
    return new Response("fake adapter takes no webhooks", { status: 404 });
  }

  parseMessage(): Message {
    throw new Error("fake adapter parses no raw messages");
  }

  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content);
  }

  #post(threadId: string, message: AdapterPostableMessage) {
    this.posted.push({ threadId, text: this.#text(message) });
    const done = this.#waiters.filter(({ count }) => this.posted.length >= count);
    this.#waiters = this.#waiters.filter(({ count }) => this.posted.length < count);
    for (const waiter of done) waiter.resolve();
  }

  #text(message: AdapterPostableMessage): string {
    if (typeof message === "string") return message;
    if ("markdown" in message) return message.markdown;
    if ("raw" in message) return message.raw;
    return JSON.stringify(message);
  }
}
