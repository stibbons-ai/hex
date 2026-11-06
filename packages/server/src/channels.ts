// The chat channels the hex config file names, built with their adapters. Apart from config.ts so
// that reading the config file (Mastra Studio does) never loads an adapter package.
import { createSlackAdapter } from "@chat-adapter/slack";
import { escapeSlackText } from "@chat-adapter/slack/format";
import { createSignalAdapter } from "@stibbons/chat-adapter-signal";
import type { AdapterPostableMessage } from "chat";
import { Config, Redacted, Result, Schema } from "effect";
import type { ChatChannel, ChatOptions } from "./chat";
import {
  type Env,
  chatModel,
  configError,
  decodeOrThrow,
  readConfigFile,
  readEnvConfig,
} from "./config";
import type { MainChannelTarget } from "./main-channel";

/**
 * One platform's channel as its factory builds it. `senderIds`, when set, is the form every
 * allowlist entry (and the Main channel's user) must have on this channel. `plainText`, when set,
 * is how plain text with its untrusted values in code spans is posted on this channel so that
 * they stay literal; else as given.
 */
type BuiltChannel = Omit<ChatChannel, "allowlist"> & {
  senderIds?: { valid: (id: string) => boolean; expected: string };
  plainText?: (text: string) => AdapterPostableMessage;
};

/**
 * Builds one platform's channel from its config `options`; secrets come from `env` only. An
 * adapter package may still read `process.env` itself for options left unset (the Slack adapter
 * does for e.g. `SLACK_API_URL`), so a test that must not see the real environment sets them.
 */
export type AdapterFactory = (options: unknown, env: Env) => BuiltChannel;

/** The variable's value; the error names the variable and what it must be, never the value. */
function requireEnv(
  env: Env,
  name: string,
  must: string,
  valid: (value: string) => boolean,
): string {
  const value = env[name];
  if (!value) throw new Error(`environment variable ${name} is not set`);
  if (!valid(value)) throw new Error(`environment variable ${name} must ${must}`);
  return value;
}

/**
 * A Slack token from `env`, read once as Effect `Config.Redacted` (it prints as `<redacted>`),
 * checked like {@link requireEnv} on that read, and unwrapped only where the adapter takes it.
 */
function requireToken(env: Env, name: string, prefix: string): Redacted.Redacted<string> {
  const read = readEnvConfig(Config.Redacted(name), env);
  const value = Result.isSuccess(read) ? Redacted.value(read.success) : undefined;
  return Redacted.make(
    requireEnv({ [name]: value }, name, `start with "${prefix}"`, (token) =>
      token.startsWith(prefix),
    ),
  );
}

/**
 * `text` for Slack's `text` field, taken literally: `&`, `<` and `>` escaped, so no `<@user>`,
 * `<!channel>` or `<url|label>` forms from it. Bare `@names` and URLs stay plain only inside code
 * spans (Slack links neither there, and the adapter rewrites no mention there).
 */
const slackPlainText = (text: string) => ({ raw: escapeSlackText(text) });

// Only socket mode: webhook mode needs a public route, which hex does not serve.
const SlackOptions = Schema.Struct({ mode: Schema.Literal("socket") });

/** A Signal ACI as signal-cli prints it: a lowercase UUID with dashes. */
const ACI = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** signal-cli takes the bot account as an E.164 number or as its ACI (any case). */
function isBotAccount(value: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(value) || ACI.test(value.toLowerCase());
}

/**
 * A copy of `error` with every form of `secret` in `forms` replaced by `name`: a native Error
 * (so it prints and nests as one) with the original's prototype (so `instanceof` holds), its
 * `name`, scrubbed `message` and `stack`, and its own primitive fields (such as `code`), strings
 * scrubbed. Object fields (the `cause`, an adapter's `originalError`) are dropped: they can carry
 * the secret anywhere, e.g. Bun's fetch error in its own `path`.
 */
function redacted(error: unknown, forms: readonly string[], name: string): Error {
  const scrub = (text: string) => forms.reduce((out, form) => out.replaceAll(form, name), text);
  if (!(error instanceof Error)) return new Error(scrub(String(error)));
  const copy = new Error(scrub(error.message));
  Object.setPrototypeOf(copy, Object.getPrototypeOf(error) as object);
  // Own data properties, so a getter-only accessor on the prototype can't make a write throw.
  const field = (value: unknown) => ({
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  for (const [key, value] of Object.entries(error)) {
    if (typeof value === "string") Object.defineProperty(copy, key, field(scrub(value)));
    else if (typeof value === "number" || typeof value === "boolean") {
      Object.defineProperty(copy, key, field(value));
    }
  }
  const hidden = (value: string) => ({ value: scrub(value), writable: true, configurable: true });
  Object.defineProperties(copy, {
    name: hidden(error.name),
    stack: hidden(error.stack ?? `${error.name}: ${error.message}`),
  });
  return copy;
}

/** Channels by platform key. Adding a channel: install its adapter package, add it here. */
export const adapterFactories: Readonly<Record<string, AdapterFactory>> = {
  slack(options, env) {
    const { mode } = decodeOrThrow(SlackOptions, options, "options");
    const apiUrl = env["SLACK_API_URL"];
    const adapter = createSlackAdapter({
      mode,
      appToken: Redacted.value(requireToken(env, "SLACK_APP_TOKEN", "xapp-")),
      botToken: Redacted.value(requireToken(env, "SLACK_BOT_TOKEN", "xoxb-")),
      // Optional: another Slack Web API base URL (tests point it at a fake Slack).
      ...(apiUrl ? { apiUrl } : {}),
    });
    return {
      adapter,
      // The adapter only warns when auth.test fails; without a bot user ID no reply would work.
      verify() {
        if (!adapter.botUserId) {
          throw new Error("Slack did not accept SLACK_BOT_TOKEN (auth.test failed; see the log)");
        }
      },
      plainText: slackPlainText,
    };
  },
  signal(options, env) {
    if (typeof options !== "object" || options === null || Object.keys(options).length > 0) {
      throw new Error(
        "options: signal takes no options; the account and the URL come from SIGNAL_ACCOUNT and SIGNAL_CLI_URL",
      );
    }
    const account = requireEnv(
      env,
      "SIGNAL_ACCOUNT",
      "be the bot account's number (+ and digits) or ACI",
      isBotAccount,
    );
    // As given, and as the adapter normalises an ACI (lowercase), each also URL-encoded.
    const accountForms = [...new Set([account, account.toLowerCase()])].flatMap((form) => [
      form,
      encodeURIComponent(form),
    ]);
    // Both passed explicitly, so the adapter never falls back to process.env.
    const adapter = createSignalAdapter({
      account,
      transport: {
        type: "http",
        url: requireEnv(env, "SIGNAL_CLI_URL", "be an http(s) URL", (value) =>
          ["http:", "https:"].includes(URL.parse(value)?.protocol ?? ""),
        ),
      },
    });
    // A failed start can name the bot account: in the message ("Bot Account +1… is not
    // registered") and in the event-stream URL's `?account=` inside `originalError`. Mastra logs
    // that error and hex fails startup with it, so it is replaced by a copy: the account
    // replaced in its message and stack, `originalError` dropped.
    const initialize = adapter.initialize.bind(adapter);
    adapter.initialize = async (chat) => {
      try {
        await initialize(chat);
      } catch (error) {
        throw redacted(error, accountForms, "SIGNAL_ACCOUNT");
      }
    };
    // No verify: initialize() rejects when signal-cli is unreachable, and when it lists the
    // daemon's accounts (or the account's own contact entry) without this one.
    return {
      adapter,
      // A Group is one conversation with all its members: one @mention would subscribe hex to
      // it, and every later message from Daniel there would be answered to the whole Group.
      directMessagesOnly: true,
      // The adapter keys senders by ACI, as signal-cli prints it; a number would match no one.
      senderIds: {
        valid: (id) => ACI.test(id),
        expected: "a Signal ACI (a lowercase UUID with dashes), not a phone number",
      },
    };
  },
};

/** The chat settings, with the Main channel when one is configured. */
export interface ChatConfig extends ChatOptions {
  /** Where Intake reports go; absent: Intake reports are off. */
  mainChannel?: MainChannelTarget;
}

/**
 * Reads the hex config file (`HEX_CONFIG`) and builds the chat settings, or `undefined` when it
 * configures no channels. Throws an error naming the file and the problem on unreadable or
 * malformed JSON, a shape mismatch, an unknown adapter, a missing or malformed secret, or a Main
 * channel on no configured channel or with a user ID that channel can't have.
 */
export async function loadChatConfig(path: string, env: Env): Promise<ChatConfig | undefined> {
  const fail = (problem: string, cause?: unknown) => configError(path, problem, cause);
  const { chat } = await readConfigFile(path);
  const entries = Object.entries(chat.channels);
  const main = chat.mainChannel;
  if (main && !Object.hasOwn(chat.channels, main.channel)) {
    const configured = entries.length === 0 ? "none" : Object.keys(chat.channels).join(", ");
    return fail(
      `mainChannel: channel "${main.channel}" is not configured; configured: ${configured}`,
    );
  }
  if (entries.length === 0) return undefined;
  const channels: Record<string, ChatChannel> = {};
  let mainChannel: MainChannelTarget | undefined;
  for (const [platform, { options, allowlist }] of entries) {
    const factory = Object.hasOwn(adapterFactories, platform)
      ? adapterFactories[platform]
      : undefined;
    if (!factory) {
      return fail(
        `channel "${platform}": unknown adapter; known: ${Object.keys(adapterFactories).join(", ")}`,
      );
    }
    let built: BuiltChannel;
    try {
      built = factory(options, env);
      const { senderIds } = built;
      // The entry's position, not its value: a misplaced phone number is personal data.
      const bad = senderIds ? allowlist.findIndex((id) => !senderIds.valid(id)) : -1;
      if (senderIds && bad !== -1) {
        throw new Error(`allowlist entry ${bad + 1} must be ${senderIds.expected}`);
      }
    } catch (error) {
      return fail(`channel "${platform}": ${(error as Error).message}`, error);
    }
    const { senderIds, plainText = (text) => text, ...channel } = built;
    channels[platform] = { ...channel, allowlist };
    if (main?.channel === platform) {
      // Not its value, as for allowlist entries.
      if (senderIds && !senderIds.valid(main.user)) {
        return fail(`mainChannel: user must be ${senderIds.expected}`);
      }
      mainChannel = { ...main, adapter: channel.adapter, message: plainText };
    }
  }
  return { ...chatModel(chat), channels, ...(mainChannel ? { mainChannel } : {}) };
}
