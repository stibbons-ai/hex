import { readFile } from "node:fs/promises";
import { LOOPBACK_ONLY, plaintextRefused } from "@hex/adapters";
import type { ImapSettings, SmtpSettings } from "@hex/adapters";
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

/**
 * The model that reads Document dates when the config names none: the cheapest of the models
 * that read every synthetic Document date right in the 2026-11-05 eval (issue #13).
 */
const DEFAULT_INTAKE_MODEL = "anthropic/claude-haiku-5-5";

/** An email address, `local@domain`: no whitespace, angle brackets, quotes, commas or colons. */
const Address = Schema.String.check(
  Schema.isPattern(/^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\]+$/),
);

/** A Forwarding target's name, the key the ledger records its Forwardings under. */
const TargetName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/));

/**
 * The watched folder: not blank, and none of hex's outcome folders (`hex/processed`,
 * `hex/failed`, with either delimiter, under an `INBOX` namespace or not, in any letter case),
 * since mail moved there would be watched again.
 */
const WatchedFolder = Schema.String.check(
  Schema.makeFilter((folder) => folder.trim() !== "" || "a folder name that is not blank"),
  Schema.makeFilter(
    (folder) =>
      !/^(inbox[./])?hex[./](processed|failed)$/i.test(folder.trim()) ||
      "a folder other than hex's outcome folders hex/processed and hex/failed",
  ),
);

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
  /**
   * The intake mailbox hex watches over IMAP, its server and login from the environment: the
   * folder it takes mail from and how long it waits after a look without news before it looks
   * again. Off when absent.
   */
  mailbox: Schema.optionalKey(
    Schema.Struct({
      /** The watched folder; INBOX when absent. */
      folder: Schema.optionalKey(WatchedFolder),
      /** Seconds to wait after a look without news, 1 to 3600; 60 when absent. */
      pollSeconds: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3600 })),
      ),
    }),
  ),
  /** The eval (`bun run eval`): the models it compares; `intake.model` alone when absent. */
  eval: Schema.optionalKey(
    Schema.Struct({
      /** Mastra model-router ids, `provider/model`: at least one, none twice. */
      models: Schema.NonEmptyArray(ModelId).check(Schema.isUnique()),
    }),
  ),
});

/** The config file as the eval reads it: the same file, with the chat section optional. */
const EvalConfigFile = Schema.Struct({
  ...ConfigFile.fields,
  chat: Schema.optionalKey(ConfigFile.fields.chat),
});

/** Throws the config error for `path`: the file, then the problem. */
export function configError(path: string, problem: string, cause?: unknown): never {
  throw new Error(`hex config ${path}: ${problem}`, cause === undefined ? {} : { cause });
}

/**
 * Reads the hex config file at `path` and decodes it with `schema`. Throws an error naming the
 * file and the problem on an unreadable file, malformed JSON or a shape mismatch.
 */
async function decodeConfigFile<S extends Schema.ConstraintDecoder<unknown>>(
  path: string,
  schema: S,
): Promise<S["Type"]> {
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
  return decodeOrThrow(schema, json, `hex config ${path}: invalid config`);
}

/**
 * Reads and decodes the hex config file (`HEX_CONFIG`). Throws an error naming the file and the
 * problem on an unreadable file, malformed JSON or a shape mismatch.
 */
export function readConfigFile(path: string): Promise<typeof ConfigFile.Type> {
  return decodeConfigFile(path, ConfigFile);
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

/** The variables of a mail server's connection, by prefix (`HEX_SMTP`, `HEX_IMAP`). */
const mailServerEnv = (prefix: string, tlsPort: number) =>
  Config.all({
    host: Config.NonEmptyString(`${prefix}_HOST`),
    port: Config.Port(`${prefix}_PORT`).pipe(Config.withDefault(tlsPort)),
    security: Config.option(Config.Literals(["tls", "starttls", "plain"], `${prefix}_SECURITY`)),
    user: Config.Redacted(`${prefix}_USER`),
    password: Config.Redacted(`${prefix}_PASSWORD`),
  });

/**
 * `config` read from `env` through Effect `Config`: the value, or the `ConfigError` saying which
 * variable is unusable (never its value).
 */
export function readEnvConfig<A>(
  config: Config.Config<A>,
  env: Env,
): Result.Result<A, Config.ConfigError> {
  return Effect.runSync(Effect.result(config.parse(ConfigProvider.fromEnvRecord({ ...env }))));
}

/**
 * A mail server's settings from `env`: `<prefix>_HOST`, `<prefix>_PORT` (`tlsPort` when unset),
 * `<prefix>_SECURITY` (`tls` on `tlsPort`, else `starttls`, when unset; `plain` only for a
 * loopback IP address, see `isLoopbackHost`), `<prefix>_USER` and `<prefix>_PASSWORD`, both
 * redacted. Calls `fail` naming the variable, never its value. IMAP shares SMTP's settings but
 * for the watched folder.
 */
function mailServerSettings(
  prefix: "HEX_SMTP" | "HEX_IMAP",
  tlsPort: number,
  env: Env,
  fail: (problem: string) => never,
): SmtpSettings {
  for (const name of ["HOST", "USER", "PASSWORD"].map((suffix) => `${prefix}_${suffix}`)) {
    if (!env[name]) fail(`environment variable ${name} is not set`);
  }
  const result = readEnvConfig(mailServerEnv(prefix, tlsPort), env);
  if (Result.isFailure(result)) {
    // E.g. `Expected a value between 1 and 65535 at ["HEX_SMTP_PORT"]`: the variable, never a value.
    return fail(
      `unusable environment variable: ${result.failure.cause.message.replace(/\s+/g, " ")}`,
    );
  }
  const { security: chosen, ...settings } = result.success;
  const security = Option.getOrElse(chosen, () =>
    settings.port === tlsPort ? ("tls" as const) : ("starttls" as const),
  );
  if (plaintextRefused(security, settings.host)) {
    fail(
      `${prefix}_SECURITY=plain is only allowed for ${LOOPBACK_ONLY}; use tls or starttls for ${settings.host}`,
    );
  }
  return { ...settings, security };
}

/** The SMTP settings from `env` ({@link mailServerSettings}, port 465 for TLS). */
function smtpSettings(path: string, env: Env): SmtpSettings {
  return mailServerSettings("HEX_SMTP", 465, env, (problem) =>
    configError(path, `forwarding: ${problem}`),
  );
}

/**
 * The Intake settings from the hex config file at `path`, or the defaults (Category ER,
 * {@link DEFAULT_INTAKE_MODEL}) without a file. Fails like {@link readConfigFile} on a file it
 * can't use, e.g. a Category other than ER or a model that is no `provider/model` id. The
 * model's API key comes from the provider's usual variable (e.g. `ANTHROPIC_API_KEY`), never from
 * this file.
 */
export async function loadIntakeConfig(path: string | undefined): Promise<IntakeConfig> {
  const intake = path === undefined ? undefined : (await readConfigFile(path)).intake;
  return {
    category: intake?.category ?? DEFAULT_CATEGORY,
    model: intake?.model ?? DEFAULT_INTAKE_MODEL,
  };
}

/** Eval settings from the config file. */
export interface EvalConfig {
  /** Mastra model-router ids of the models the eval compares, `provider/model`, in file order. */
  models: readonly [string, ...string[]];
}

/**
 * The eval settings from the hex config file at `path`: the models of its `eval` section, else
 * the one model the Intake uses (`intake.model`, {@link DEFAULT_INTAKE_MODEL} without one or
 * without a file). The chat section is optional here, so a file holding only `eval` (or
 * `intake`) works; every section present is checked as {@link readConfigFile} checks it, failing
 * the same way, e.g. on an empty or repeated model list or an unknown key.
 */
export async function loadEvalConfig(path: string | undefined): Promise<EvalConfig> {
  const file = path === undefined ? undefined : await decodeConfigFile(path, EvalConfigFile);
  return { models: file?.eval?.models ?? [file?.intake?.model ?? DEFAULT_INTAKE_MODEL] };
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

/** The intake mailbox: the IMAP settings (with the watched folder) and the poll interval. */
export interface MailboxConfig {
  imap: ImapSettings;
  /** Milliseconds to wait after a look at the watched folder without news before looking again. */
  pollMs: number;
}

/** The watched folder when the config names none. */
const DEFAULT_MAILBOX_FOLDER = "INBOX";
/** Seconds to wait after a look without news when the config says nothing. */
const DEFAULT_POLL_SECONDS = 60;

/**
 * The intake mailbox settings from the hex config file at `path`: undefined (no watcher) without
 * a file or without a `mailbox` section, so no IMAP setting is needed then. Otherwise the watched
 * folder (`INBOX` when unset), the wait after a look without news (60 s when unset) and the IMAP
 * server from `env`:
 * `HEX_IMAP_HOST`, `HEX_IMAP_PORT` (993 when unset), `HEX_IMAP_SECURITY` (`tls` on port 993,
 * else `starttls`, when unset; `plain` only for a loopback IP address), `HEX_IMAP_USER` and
 * `HEX_IMAP_PASSWORD`, both redacted. Fails like {@link readConfigFile} on a file it can't use,
 * and on IMAP settings it can't use, naming the variable, never its value.
 */
export async function loadMailboxConfig(
  path: string | undefined,
  env: Env,
): Promise<MailboxConfig | undefined> {
  if (path === undefined) return undefined;
  const { mailbox } = await readConfigFile(path);
  if (!mailbox) return undefined;
  const server = mailServerSettings("HEX_IMAP", 993, env, (problem) =>
    configError(path, `mailbox: ${problem}`),
  );
  return {
    imap: { ...server, folder: mailbox.folder ?? DEFAULT_MAILBOX_FOLDER },
    pollMs: (mailbox.pollSeconds ?? DEFAULT_POLL_SECONDS) * 1000,
  };
}
