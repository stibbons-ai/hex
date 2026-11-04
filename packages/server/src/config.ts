import { readFile } from "node:fs/promises";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createSignalAdapter } from "@stibbons/chat-adapter-signal";
import { Result, Schema } from "effect";
import type { ChatChannel, ChatOptions } from "./chat";

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Builds one platform's channel from its config `options`; secrets come from `env` only. An
 * adapter package may still read `process.env` itself for options left unset (the Slack adapter
 * does for e.g. `SLACK_API_URL`), so a test that must not see the real environment sets them.
 * `senderIds`, when set, is the form every allowlist entry must have on this channel.
 */
export type AdapterFactory = (
  options: unknown,
  env: Env,
) => Omit<ChatChannel, "allowlist"> & { senderIds?: { pattern: RegExp; expected: string } };

const strict = { errors: "all", onExcessProperty: "error" } as const;

function decodeOrThrow<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
  what: string,
): S["Type"] {
  const result = Schema.decodeUnknownResult(schema)(input, strict);
  if (Result.isFailure(result)) throw new Error(`${what}: ${result.failure.message}`);
  return result.success;
}

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

function requireToken(env: Env, name: string, prefix: string): string {
  return requireEnv(env, name, `start with "${prefix}"`, (value) => value.startsWith(prefix));
}

// Only socket mode: webhook mode needs a public route, which hex does not serve.
const SlackOptions = Schema.Struct({ mode: Schema.Literal("socket") });

// signal-cli takes the bot account as an E.164 number or as its ACI.
const BOT_ACCOUNT_FORMAT = /^(\+[1-9]\d{6,14}|[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;

/**
 * Replaces `secret`, as written and as it appears lowercased or URL-encoded, with `name` in the
 * messages and stacks of `error` and its causes. Mutates them, so the error keeps its class.
 */
function redact(error: unknown, secret: string, name: string): unknown {
  const forms = [...new Set([secret, secret.toLowerCase(), encodeURIComponent(secret)])];
  const scrub = (text: string) => forms.reduce((out, form) => out.replaceAll(form, name), text);
  for (let current = error; current instanceof Error; current = current.cause) {
    current.message = scrub(current.message);
    if (current.stack) current.stack = scrub(current.stack);
  }
  return error;
}

/** Channels by platform key. Adding a channel: install its adapter package, add it here. */
export const adapterFactories: Readonly<Record<string, AdapterFactory>> = {
  slack(options, env) {
    const { mode } = decodeOrThrow(SlackOptions, options, "options");
    const apiUrl = env["SLACK_API_URL"];
    const adapter = createSlackAdapter({
      mode,
      appToken: requireToken(env, "SLACK_APP_TOKEN", "xapp-"),
      botToken: requireToken(env, "SLACK_BOT_TOKEN", "xoxb-"),
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
      (value) => BOT_ACCOUNT_FORMAT.test(value),
    );
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
    // A failed start names the bot account's number (e.g. "Bot Account +1… is not registered");
    // Mastra logs that error and hex fails startup with it, so the number is taken out first.
    const initialize = adapter.initialize.bind(adapter);
    adapter.initialize = async (chat) => {
      try {
        await initialize(chat);
      } catch (error) {
        throw redact(error, account, "SIGNAL_ACCOUNT");
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
        pattern: /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
        expected: "a Signal ACI (a lowercase UUID with dashes), not a phone number",
      },
    };
  },
};

// Whitespace is rejected here; case is kept, and the allowlist compares IDs exactly.
const SenderId = Schema.String.check(Schema.isPattern(/^\S+$/));

const ConfigFile = Schema.Struct({
  chat: Schema.Struct({
    /** Mastra model-router id, `provider/model`. */
    model: Schema.String.check(Schema.isPattern(/^[^/\s]+\/\S+$/)),
    /** Passed through to the model call, keyed by provider, e.g. `{ anthropic: { effort: "low" } }`. */
    providerOptions: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
    ),
    channels: Schema.Record(
      Schema.String,
      Schema.Struct({
        options: Schema.Record(Schema.String, Schema.Unknown),
        allowlist: Schema.Array(SenderId),
      }),
    ),
  }),
});

/**
 * Reads the hex config file (`HEX_CONFIG`) and builds the chat settings, or `undefined` when it
 * configures no channels. Throws an error naming the file and the problem on unreadable or
 * malformed JSON, a shape mismatch, an unknown adapter, or a missing or malformed secret.
 */
export async function loadChatConfig(path: string, env: Env): Promise<ChatOptions | undefined> {
  const fail = (problem: string, cause?: unknown): never => {
    throw new Error(`hex config ${path}: ${problem}`, cause === undefined ? {} : { cause });
  };
  const text = await readFile(path, "utf8").catch((error: unknown) =>
    fail(`cannot read the file (${(error as Error).message})`, error),
  );
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return fail(`not valid JSON (${(error as Error).message})`, error);
  }
  const { chat } = decodeOrThrow(ConfigFile, json, `hex config ${path}: invalid config`);
  const entries = Object.entries(chat.channels);
  if (entries.length === 0) return undefined;
  const channels: Record<string, ChatChannel> = {};
  for (const [platform, { options, allowlist }] of entries) {
    const factory = Object.hasOwn(adapterFactories, platform)
      ? adapterFactories[platform]
      : undefined;
    if (!factory) {
      return fail(
        `channel "${platform}": unknown adapter; known: ${Object.keys(adapterFactories).join(", ")}`,
      );
    }
    try {
      const { senderIds, ...channel } = factory(options, env);
      // The entry's position, not its value: a misplaced phone number is personal data.
      const bad = senderIds ? allowlist.findIndex((id) => !senderIds.pattern.test(id)) : -1;
      if (senderIds && bad !== -1) {
        throw new Error(`allowlist entry ${bad + 1} must be ${senderIds.expected}`);
      }
      channels[platform] = { ...channel, allowlist };
    } catch (error) {
      return fail(`channel "${platform}": ${(error as Error).message}`, error);
    }
  }
  const { model, providerOptions } = chat;
  return { model, ...(providerOptions ? { providerOptions } : {}), channels };
}
