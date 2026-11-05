import { readFile } from "node:fs/promises";
import type { SmtpSecurity, SmtpSettings } from "@hex/adapters";
import { CATEGORIES, DEFAULT_CATEGORY } from "@hex/domain";
import type { Category } from "@hex/domain";
import { Config, ConfigProvider, Effect, Option, Result, Schema } from "effect";
import type { ChatModel } from "./chat";
import type { IntakeForwarding } from "./intake-workflow";

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

/** An email address, `local@domain`: no whitespace, angle brackets, quotes, commas or colons. */
const Address = Schema.String.check(
  Schema.isPattern(/^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\]+$/),
);

/** A Forwarding target's name, the key the ledger records its Forwardings under. */
const TargetName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/));

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
  /**
   * Forwarding of each Intake's Documents by SMTP: the sender address, and each target by name
   * (e.g. `sevdesk`, `paperless`) with its address and whether it is on. Off when absent.
   */
  forwarding: Schema.optionalKey(
    Schema.Struct({
      from: Address,
      targets: Schema.Record(TargetName, Schema.Struct({ to: Address, enabled: Schema.Boolean })),
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

/** Forwarding settings: the targets that are on, and the SMTP server to send through. */
export interface ForwardingConfig extends IntakeForwarding {
  smtp: SmtpSettings;
}

/** Intake workflow settings from the config file. */
export interface IntakeConfig {
  category: Category;
  /** Mastra model-router id of the model that reads Document dates, `provider/model`. */
  model: string;
}

/** The SMTP variables without a default. */
const REQUIRED_SMTP_VARIABLES = ["HEX_SMTP_HOST", "HEX_SMTP_USER", "HEX_SMTP_PASSWORD"] as const;

const SmtpEnv = Config.all({
  host: Config.NonEmptyString("HEX_SMTP_HOST"),
  port: Config.Port("HEX_SMTP_PORT").pipe(Config.withDefault(465)),
  security: Config.option(Config.Literals(["tls", "starttls", "plain"], "HEX_SMTP_SECURITY")),
  user: Config.Redacted("HEX_SMTP_USER"),
  password: Config.Redacted("HEX_SMTP_PASSWORD"),
});

/** Whether `host` is this machine: `localhost`, an IPv4 loopback address or `::1`. */
function isLoopback(host: string): boolean {
  return /^(?:localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i.test(host);
}

/**
 * The SMTP settings from `env`: `HEX_SMTP_HOST`, `HEX_SMTP_PORT` (465 when unset),
 * `HEX_SMTP_SECURITY` (`tls` on port 465, else `starttls`, when unset; `plain` only for a
 * loopback host), `HEX_SMTP_USER` and `HEX_SMTP_PASSWORD`, both redacted. Throws naming the
 * variable, never its value.
 */
function smtpSettings(path: string, env: Env): SmtpSettings {
  const fail = (problem: string): never => configError(path, `forwarding: ${problem}`);
  for (const name of REQUIRED_SMTP_VARIABLES) {
    if (!env[name]) fail(`environment variable ${name} is not set`);
  }
  const result = Effect.runSync(
    Effect.result(SmtpEnv.parse(ConfigProvider.fromEnvRecord({ ...env }))),
  );
  if (Result.isFailure(result)) {
    // E.g. `Expected a value between 1 and 65535 at ["HEX_SMTP_PORT"]`: the variable, never a value.
    return fail(
      `unusable environment variable: ${result.failure.cause.message.replace(/\s+/g, " ")}`,
    );
  }
  const { security: chosen, ...settings } = result.success;
  const security: SmtpSecurity = Option.getOrElse(chosen, () =>
    settings.port === 465 ? "tls" : "starttls",
  );
  if (security === "plain" && !isLoopback(settings.host)) {
    fail(
      `HEX_SMTP_SECURITY=plain is only allowed for a loopback host (localhost, 127.x.x.x, ::1); use tls or starttls for ${settings.host}`,
    );
  }
  return { ...settings, security };
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

/**
 * The Forwarding settings from the hex config file at `path`: undefined (Forwarding off) without
 * a file, without a `forwarding` section or with no target enabled, so no SMTP setting is needed
 * then. Otherwise the enabled targets and the SMTP settings from `env` (see
 * {@link smtpSettings}). Fails like {@link readConfigFile} on a file it can't use (e.g. an
 * invalid address or target name), and on SMTP settings it can't use, naming the variable.
 */
export async function loadForwardingConfig(
  path: string | undefined,
  env: Env,
): Promise<ForwardingConfig | undefined> {
  if (path === undefined) return undefined;
  const { forwarding } = await readConfigFile(path);
  if (!forwarding) return undefined;
  const targets = Object.entries(forwarding.targets)
    .filter(([, { enabled }]) => enabled)
    .map(([name, { to }]) => ({ name, to }));
  if (targets.length === 0) return undefined;
  return { from: forwarding.from, targets, smtp: smtpSettings(path, env) };
}
