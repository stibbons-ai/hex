import { readFile } from "node:fs/promises";
import { createSlackAdapter } from "@chat-adapter/slack";
import { Result, Schema } from "effect";
import type { ChatChannel, ChatOptions } from "./chat";

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Builds one platform's channel from its config `options`; secrets come from `env` only. An
 * adapter package may still read `process.env` itself for options left unset (the Slack adapter
 * does for e.g. `SLACK_API_URL`), so a test that must not see the real environment sets them.
 */
export type AdapterFactory = (options: unknown, env: Env) => Omit<ChatChannel, "allowlist">;

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

/** The variable's value; the error names the variable and the expected prefix, never the value. */
function requireToken(env: Env, name: string, prefix: string): string {
  const value = env[name];
  if (!value) throw new Error(`environment variable ${name} is not set`);
  if (!value.startsWith(prefix)) {
    throw new Error(`environment variable ${name} must start with "${prefix}"`);
  }
  return value;
}

// Only socket mode: webhook mode needs a public route, which hex does not serve.
const SlackOptions = Schema.Struct({ mode: Schema.Literal("socket") });

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
};

// Whitespace is rejected here; case is kept, and the allowlist compares IDs exactly.
const SenderId = Schema.String.check(Schema.isPattern(/^\S+$/));

const ConfigFile = Schema.Struct({
  chat: Schema.Struct({
    /** Mastra model-router id, `provider/model`. */
    model: Schema.String.check(Schema.isPattern(/^[^/\s]+\/\S+$/)),
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
      channels[platform] = { ...factory(options, env), allowlist };
    } catch (error) {
      return fail(`channel "${platform}": ${(error as Error).message}`, error);
    }
  }
  return { model: chat.model, channels };
}
