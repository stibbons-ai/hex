import { readFile } from "node:fs/promises";
import { createSlackAdapter } from "@chat-adapter/slack";
import type { Adapter } from "chat";
import { Result, Schema } from "effect";
import type { ChatOptions } from "./chat";

export type Env = Readonly<Record<string, string | undefined>>;

/** Builds one platform's chat adapter from its config `options`; secrets come from env only. */
export type AdapterFactory = (options: unknown, env: Env) => Adapter;

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

function requireEnv(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`environment variable ${name} is not set`);
  return value;
}

// Only socket mode: webhook mode needs a public route, which hex does not serve.
const SlackOptions = Schema.Struct({ mode: Schema.Literal("socket") });

/** Chat adapters by platform key. Adding a channel: install its adapter package, add it here. */
export const adapterFactories: Readonly<Record<string, AdapterFactory>> = {
  slack(options, env) {
    const { mode } = decodeOrThrow(SlackOptions, options, "options");
    const apiUrl = env["SLACK_API_URL"];
    return createSlackAdapter({
      mode,
      appToken: requireEnv(env, "SLACK_APP_TOKEN"),
      botToken: requireEnv(env, "SLACK_BOT_TOKEN"),
      // Optional: another Slack Web API base URL (tests point it at a fake Slack).
      ...(apiUrl ? { apiUrl } : {}),
    });
  },
};

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
 * malformed JSON, a shape mismatch, an unknown adapter, or a missing secret.
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
  const channels = Object.entries(chat.channels);
  if (channels.length === 0) return undefined;
  const adapters: Record<string, Adapter> = {};
  const allowlists: Record<string, readonly string[]> = {};
  for (const [platform, { options, allowlist }] of channels) {
    const factory = Object.hasOwn(adapterFactories, platform)
      ? adapterFactories[platform]
      : undefined;
    if (!factory) {
      return fail(
        `channel "${platform}": unknown adapter; known: ${Object.keys(adapterFactories).join(", ")}`,
      );
    }
    let adapter: Adapter;
    try {
      adapter = factory(options, env);
    } catch (error) {
      return fail(`channel "${platform}": ${(error as Error).message}`, error);
    }
    // The allowlist is looked up by the adapter's own name, so the two must agree.
    if (adapter.name !== platform) {
      return fail(`channel "${platform}": adapter reports platform "${adapter.name}"`);
    }
    adapters[platform] = adapter;
    allowlists[platform] = allowlist;
  }
  return { model: chat.model, adapters, allowlists };
}
