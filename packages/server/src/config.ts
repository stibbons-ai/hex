import { readFile } from "node:fs/promises";
import { CATEGORIES, DEFAULT_CATEGORY } from "@hex/domain";
import type { Category } from "@hex/domain";
import { Result, Schema } from "effect";
import type { ChatModel } from "./chat";

export type Env = Readonly<Record<string, string | undefined>>;

const strict = { errors: "all", onExcessProperty: "error" } as const;

export function decodeOrThrow<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
  what: string,
): S["Type"] {
  const result = Schema.decodeUnknownResult(schema)(input, strict);
  if (Result.isFailure(result)) throw new Error(`${what}: ${result.failure.message}`);
  return result.success;
}

// Whitespace is rejected here; case is kept, and the allowlist compares IDs exactly.
const SenderId = Schema.String.check(Schema.isPattern(/^\S+$/));

/** A Mastra model-router id, `provider/model`. */
const ModelId = Schema.String.check(Schema.isPattern(/^[^/\s]+\/\S+$/));

/** The model that reads Document dates when the config names none. */
const DEFAULT_INTAKE_MODEL = "openai/gpt-5.1-codex-mini";

const ConfigFile = Schema.Struct({
  chat: Schema.Struct({
    /** Mastra model-router id, `provider/model`. */
    model: ModelId,
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
  intake: Schema.optionalKey(
    Schema.Struct({
      /** The Category Documents are filed under; ER, the only one, when absent. */
      category: Schema.optionalKey(Schema.Literals(CATEGORIES)),
      /** The model that reads Document dates; {@link DEFAULT_INTAKE_MODEL} when absent. */
      model: Schema.optionalKey(ModelId),
    }),
  ),
});

/** Throws the config error for `path`: the file, then the problem. */
export function configError(path: string, problem: string, cause?: unknown): never {
  throw new Error(`hex config ${path}: ${problem}`, cause === undefined ? {} : { cause });
}

/**
 * Reads and decodes the hex config file (`HEX_CONFIG`). Throws an error naming the file and the
 * problem on an unreadable file, malformed JSON or a shape mismatch.
 */
export async function readConfigFile(path: string): Promise<typeof ConfigFile.Type> {
  const fail = (problem: string, cause?: unknown) => configError(path, problem, cause);
  const text = await readFile(path, "utf8").catch((error: unknown) =>
    fail(`cannot read the file (${(error as Error).message})`, error),
  );
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return fail(`not valid JSON (${(error as Error).message})`, error);
  }
  return decodeOrThrow(ConfigFile, json, `hex config ${path}: invalid config`);
}

/** The chat agent's model settings in the config file's `chat` section. */
export function chatModel({ model, providerOptions }: (typeof ConfigFile.Type)["chat"]): ChatModel {
  return { model, ...(providerOptions ? { providerOptions } : {}) };
}

/**
 * The chat agent's model settings from the hex config file at `path`, without building its
 * channels, so no channel secret is needed (Mastra Studio). Throws, naming the file and the
 * problem, on a file it can't use (see {@link readConfigFile}).
 */
export async function loadChatModel(path: string): Promise<ChatModel> {
  return chatModel((await readConfigFile(path)).chat);
}

/** Intake workflow settings from the config file. */
export interface IntakeConfig {
  category: Category;
  /** Mastra model-router id of the model that reads Document dates, `provider/model`. */
  model: string;
}

/**
 * The Intake settings from the hex config file at `path`, or the defaults (Category ER,
 * {@link DEFAULT_INTAKE_MODEL}) without a file. Fails like {@link readConfigFile} on a file it
 * can't use, e.g. a Category other than ER or a model that is no `provider/model` id. The
 * model's API key comes from the provider's usual variable (e.g. `OPENAI_API_KEY`), never from
 * this file.
 */
export async function loadIntakeConfig(path: string | undefined): Promise<IntakeConfig> {
  const intake = path === undefined ? undefined : (await readConfigFile(path)).intake;
  return {
    category: intake?.category ?? DEFAULT_CATEGORY,
    model: intake?.model ?? DEFAULT_INTAKE_MODEL,
  };
}
