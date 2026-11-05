import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redacted } from "effect";
import { loadChatConfig } from "../src/channels";
import { loadEvalConfig, loadForwardingConfig, loadIntakeConfig } from "../src/config";
import { BOT_ACCOUNT, BOT_ACI, DANIEL as DANIEL_ACI } from "./fake-signal-cli";

const signalEnv = { SIGNAL_ACCOUNT: BOT_ACCOUNT, SIGNAL_CLI_URL: "http://127.0.0.1:8080" };
const signalConfig = {
  chat: {
    model: "anthropic/claude-opus-5-5",
    channels: { signal: { options: {}, allowlist: [DANIEL_ACI] } },
  },
};

const slackEnv = { SLACK_APP_TOKEN: "xapp-test", SLACK_BOT_TOKEN: "xoxb-test" };
const valid = {
  chat: {
    model: "anthropic/claude-opus-5-5",
    channels: { slack: { options: { mode: "socket" }, allowlist: ["U0DANIEL"] } },
  },
};

let directory: string;
let files = 0;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-config-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function configFile(content: unknown): Promise<string> {
  const path = join(directory, `config-${files++}.json`);
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

describe("loadChatConfig", () => {
  test("builds a socket-mode Slack adapter, the model and the allowlist from a valid file", async () => {
    const chat = await loadChatConfig(await configFile(valid), slackEnv);
    expect(chat?.model).toBe("anthropic/claude-opus-5-5");
    // Not set: the provider's defaults apply.
    expect(chat).not.toHaveProperty("providerOptions");
    const slack = chat?.channels["slack"];
    expect(slack?.allowlist).toEqual(["U0DANIEL"]);
    const adapter = slack?.adapter as { name: string; isSocketMode: boolean } | undefined;
    expect(adapter?.name).toBe("slack");
    expect(adapter?.isSocketMode).toBe(true);
    // Not connected yet, so Slack hasn't confirmed the bot token: the check fails.
    expect(() => slack?.verify?.()).toThrow("Slack did not accept SLACK_BOT_TOKEN");
  });

  test("carries providerOptions through unchanged", async () => {
    const providerOptions = { anthropic: { effort: "low", thinking: { type: "adaptive" } } };
    const path = await configFile({ chat: { ...valid.chat, providerOptions } });
    expect((await loadChatConfig(path, slackEnv))?.providerOptions).toEqual(providerOptions);
  });

  test.each([
    ["a provider's options that aren't an object", { anthropic: "low" }, '["anthropic"]'],
    ["providerOptions that aren't an object", ["anthropic"], ""],
  ])("%s fail with the path", async (_case, providerOptions, at) => {
    const path = await configFile({ chat: { ...valid.chat, providerOptions } });
    await expect(loadChatConfig(path, slackEnv)).rejects.toThrow(
      `at ["chat"]["providerOptions"]${at}`,
    );
  });

  test("no channels means no chat", async () => {
    const path = await configFile({ chat: { model: "openai/gpt-5", channels: {} } });
    expect(await loadChatConfig(path, {})).toBeUndefined();
  });

  test.each([
    ["SLACK_APP_TOKEN", undefined],
    ["SLACK_BOT_TOKEN", undefined],
    // As .env.example ships it.
    ["SLACK_APP_TOKEN", ""],
    ["SLACK_BOT_TOKEN", ""],
  ])("%s=%j fails as not set, naming it", async (name, value) => {
    const path = await configFile(valid);
    await expect(loadChatConfig(path, { ...slackEnv, [name]: value })).rejects.toThrow(
      `hex config ${path}: channel "slack": environment variable ${name} is not set`,
    );
  });

  test.each([
    ["SLACK_APP_TOKEN", "xoxb-swapped", "xapp-"],
    ["SLACK_BOT_TOKEN", "xapp-swapped", "xoxb-"],
    ["SLACK_BOT_TOKEN", " xoxb-padded", "xoxb-"],
  ])("%s=%j fails on its prefix without echoing the value", async (name, value, prefix) => {
    const path = await configFile(valid);
    const loading = loadChatConfig(path, { ...slackEnv, [name]: value });
    await expect(loading).rejects.toThrow(
      `hex config ${path}: channel "slack": environment variable ${name} must start with "${prefix}"`,
    );
    await expect(loading).rejects.not.toThrow(value.trim());
  });

  test("an unknown adapter fails, listing the known ones", async () => {
    const path = await configFile({
      chat: { ...valid.chat, channels: { toString: { options: {}, allowlist: [] } } },
    });
    await expect(loadChatConfig(path, slackEnv)).rejects.toThrow(
      `hex config ${path}: channel "toString": unknown adapter; known: slack, signal`,
    );
  });

  test("malformed JSON fails as such", async () => {
    const path = await configFile('{"chat": ');
    await expect(loadChatConfig(path, slackEnv)).rejects.toThrow(
      `hex config ${path}: not valid JSON`,
    );
  });

  test("a missing file fails as unreadable", async () => {
    const path = join(directory, "absent.json");
    await expect(loadChatConfig(path, slackEnv)).rejects.toThrow(
      `hex config ${path}: cannot read the file`,
    );
  });

  test.each([
    ["webhook mode", { ...valid.chat.channels.slack, options: { mode: "webhook" } }],
    [
      "an unknown Slack option",
      { ...valid.chat.channels.slack, options: { mode: "socket", botToken: "xoxb-in-file" } },
    ],
  ])("%s fails on the channel's options", async (_case, slack) => {
    const path = await configFile({ chat: { ...valid.chat, channels: { slack } } });
    await expect(loadChatConfig(path, slackEnv)).rejects.toThrow(
      `hex config ${path}: channel "slack": options: `,
    );
  });

  test.each([
    ["no chat", {}],
    ["a model without provider", { chat: { ...valid.chat, model: "gpt-5" } }],
    [
      "an allowlist ID with whitespace",
      { chat: { ...valid.chat, channels: { slack: { options: {}, allowlist: ["U0 X"] } } } },
    ],
    [
      "an empty allowlist ID",
      { chat: { ...valid.chat, channels: { slack: { options: {}, allowlist: [""] } } } },
    ],
    [
      "a channel without allowlist",
      { chat: { ...valid.chat, channels: { slack: { options: {} } } } },
    ],
    ["an unknown key", { ...valid, slackToken: "xoxb-in-file" }],
  ])("%s fails as invalid config", async (_case, content) => {
    const path = await configFile(content);
    await expect(loadChatConfig(path, slackEnv)).rejects.toThrow(
      `hex config ${path}: invalid config: `,
    );
  });

  describe("signal", () => {
    test("builds a Signal adapter and the allowlist from env and empty options", async () => {
      const chat = await loadChatConfig(await configFile(signalConfig), signalEnv);
      const signal = chat?.channels["signal"];
      expect(signal?.adapter.name).toBe("signal");
      expect(signal?.allowlist).toEqual([DANIEL_ACI]);
      // initialize() itself rejects when signal-cli can't serve the account.
      expect(signal?.verify).toBeUndefined();
    });

    test("an ACI works as the bot account", async () => {
      const env = { ...signalEnv, SIGNAL_ACCOUNT: BOT_ACI };
      const chat = await loadChatConfig(await configFile(signalConfig), env);
      expect(chat?.channels["signal"]?.adapter.name).toBe("signal");
    });

    test.each(["SIGNAL_ACCOUNT", "SIGNAL_CLI_URL"])(
      "a missing %s fails, naming it, even when process.env has it",
      async (name) => {
        const path = await configFile(signalConfig);
        const saved = process.env[name];
        // The adapter would fall back to process.env; hex passes both, so it must not.
        process.env[name] = signalEnv[name as keyof typeof signalEnv];
        try {
          await expect(loadChatConfig(path, { ...signalEnv, [name]: undefined })).rejects.toThrow(
            `hex config ${path}: channel "signal": environment variable ${name} is not set`,
          );
        } finally {
          if (saved === undefined) delete process.env[name];
          else process.env[name] = saved;
        }
      },
    );

    test.each([
      ["SIGNAL_ACCOUNT", "15555550100", "be the bot account's number (+ and digits) or ACI"],
      ["SIGNAL_ACCOUNT", "+1 555 555 0100", "be the bot account's number (+ and digits) or ACI"],
      ["SIGNAL_CLI_URL", "127.0.0.1:8080", "be an http(s) URL"],
      ["SIGNAL_CLI_URL", "file:///tmp/signal.sock", "be an http(s) URL"],
    ])("%s=%j fails without echoing the value", async (name, value, must) => {
      const path = await configFile(signalConfig);
      const loading = loadChatConfig(path, { ...signalEnv, [name]: value });
      await expect(loading).rejects.toThrow(
        `hex config ${path}: channel "signal": environment variable ${name} must ${must}`,
      );
      await expect(loading).rejects.not.toThrow(value);
    });

    test.each([
      ["a transport in the file", { transport: { type: "spawn" } }],
      ["the account in the file", { account: BOT_ACCOUNT }],
    ])("%s fails: Signal takes no options", async (_case, options) => {
      const path = await configFile({
        chat: { ...signalConfig.chat, channels: { signal: { options, allowlist: [] } } },
      });
      await expect(loadChatConfig(path, signalEnv)).rejects.toThrow(
        `hex config ${path}: channel "signal": options: signal takes no options; the account and the URL come from SIGNAL_ACCOUNT and SIGNAL_CLI_URL`,
      );
    });

    test.each([
      ["a phone number", "+15555550199"],
      ["an uppercase ACI", DANIEL_ACI.toUpperCase()],
      ["an ACI without dashes", DANIEL_ACI.replaceAll("-", "")],
    ])("%s in the allowlist fails, naming its position, not its value", async (_case, entry) => {
      const path = await configFile({
        chat: {
          ...signalConfig.chat,
          channels: { signal: { options: {}, allowlist: [DANIEL_ACI, entry] } },
        },
      });
      const loading = loadChatConfig(path, signalEnv);
      await expect(loading).rejects.toThrow(
        `hex config ${path}: channel "signal": allowlist entry 2 must be a Signal ACI (a lowercase UUID with dashes), not a phone number`,
      );
      await expect(loading).rejects.not.toThrow(entry);
    });

    test("Slack allowlist entries keep any form", async () => {
      const path = await configFile({
        chat: {
          ...valid.chat,
          channels: { slack: { options: { mode: "socket" }, allowlist: ["anything-goes"] } },
        },
      });
      expect((await loadChatConfig(path, slackEnv))?.channels["slack"]?.allowlist).toEqual([
        "anything-goes",
      ]);
    });
  });
});

describe("loadIntakeConfig", () => {
  const defaults = { category: "ER", model: "anthropic/claude-haiku-5-5" } as const;

  test("without a config file: Category ER, model anthropic/claude-haiku-5-5", async () => {
    expect(await loadIntakeConfig(undefined)).toEqual(defaults);
  });

  test.each([
    ["no intake section", valid],
    ["no category or model", { ...valid, intake: {} }],
    ["category ER", { ...valid, intake: { category: "ER" } }],
  ])("%s: the defaults", async (_case, content) => {
    expect(await loadIntakeConfig(await configFile(content))).toEqual(defaults);
  });

  test("reads the intake section without the chat secrets", async () => {
    // Slack tokens are missing from the environment; only the chat config would need them.
    const path = await configFile({
      ...valid,
      intake: { category: "ER", model: "anthropic/claude-haiku-4-5" },
    });
    expect(await loadIntakeConfig(path)).toEqual({
      category: "ER",
      model: "anthropic/claude-haiku-4-5",
    });
  });

  test.each([
    ["another Category", { category: "AR" }, '["intake"]["category"]'],
    ["a lowercase er", { category: "er" }, '["intake"]["category"]'],
    ["an unknown intake key", { category: "ER", folder: "x" }, '["intake"]["folder"]'],
    ["a model without provider", { model: "claude-haiku-5-5" }, '["intake"]["model"]'],
    ["a model with whitespace", { model: "openai/gpt 5" }, '["intake"]["model"]'],
    ["an empty provider", { model: "/gpt-5" }, '["intake"]["model"]'],
    ["a model that is no string", { model: 5 }, '["intake"]["model"]'],
  ])("%s fails, naming the file and the key", async (_case, intake, at) => {
    const path = await configFile({ ...valid, intake });
    const loading = loadIntakeConfig(path);
    await expect(loading).rejects.toThrow(`hex config ${path}: invalid config`);
    await expect(loadIntakeConfig(path)).rejects.toThrow(`at ${at}`);
  });

  test("a missing file fails, naming it", async () => {
    const path = join(directory, "missing.json");
    await expect(loadIntakeConfig(path)).rejects.toThrow(
      `hex config ${path}: cannot read the file`,
    );
  });
});

describe("loadEvalConfig", () => {
  test("the models of the eval section, in file order", async () => {
    const models = [
      "openai/gpt-5.4-mini",
      "anthropic/claude-haiku-4-5",
      "google/gemini-2.5-flash-lite",
    ] as const;
    const path = await configFile({
      ...valid,
      intake: { model: "anthropic/claude-haiku-5-5" },
      eval: { models },
    });
    expect(await loadEvalConfig(path)).toEqual({ models });
  });

  test.each([
    ["without a config file", undefined, "anthropic/claude-haiku-5-5"],
    ["without an eval section", { ...valid }, "anthropic/claude-haiku-5-5"],
    [
      "without an eval section, with intake.model",
      { intake: { model: "openai/gpt-5.4-nano" } },
      "openai/gpt-5.4-nano",
    ],
  ])("%s: the Intake's model alone", async (_case, content, model) => {
    const path = content === undefined ? undefined : await configFile(content);
    expect(await loadEvalConfig(path)).toEqual({ models: [model] });
  });

  test("needs no chat section", async () => {
    const path = await configFile({ eval: { models: ["openai/gpt-5.4-nano"] } });
    expect(await loadEvalConfig(path)).toEqual({ models: ["openai/gpt-5.4-nano"] });
  });

  test.each([
    ["an empty model list", { eval: { models: [] } }, '["eval"]["models"]'],
    [
      "a model listed twice",
      { eval: { models: ["openai/gpt-5", "openai/gpt-5"] } },
      '["eval"]["models"]',
    ],
    ["a model without provider", { eval: { models: ["gpt-5"] } }, '["eval"]["models"][0]'],
    [
      "a model that is no string",
      { eval: { models: ["openai/gpt-5", 5] } },
      '["eval"]["models"][1]',
    ],
    ["models that are no list", { eval: { models: "openai/gpt-5" } }, '["eval"]["models"]'],
    ["an eval section without models", { eval: {} }, '["eval"]["models"]'],
    ["an unknown eval key", { eval: { models: ["openai/gpt-5"], runs: 3 } }, '["eval"]["runs"]'],
    ["an unknown top-level key", { eval: { models: ["openai/gpt-5"] }, evals: {} }, '["evals"]'],
    ["an invalid intake section", { intake: { category: "AR" } }, '["intake"]["category"]'],
  ])("%s fails, naming the file and the key", async (_case, content, at) => {
    const path = await configFile(content);
    const loading = loadEvalConfig(path);
    await expect(loading).rejects.toThrow(`hex config ${path}: invalid config`);
    await expect(loadEvalConfig(path)).rejects.toThrow(`at ${at}`);
  });

  test("the server's loaders read a full config that has an eval section too", async () => {
    const path = await configFile({
      ...valid,
      intake: { model: "anthropic/claude-haiku-4-5" },
      eval: { models: ["openai/gpt-5-mini", "anthropic/claude-haiku-4-5"] },
    });
    expect(await loadIntakeConfig(path)).toEqual({
      category: "ER",
      model: "anthropic/claude-haiku-4-5",
    });
    expect((await loadChatConfig(path, slackEnv))?.model).toBe("anthropic/claude-opus-5-5");
    expect(await loadForwardingConfig(path, {})).toBeUndefined();
  });

  test("the server's loaders still need the chat section", async () => {
    const path = await configFile({ eval: { models: ["openai/gpt-5.4-nano"] } });
    await expect(loadIntakeConfig(path)).rejects.toThrow('at ["chat"]');
  });
});

describe("loadForwardingConfig", () => {
  const PASSWORD = "smtp-secret-0123456789";
  const smtpEnv = {
    HEX_SMTP_HOST: "smtp.example.com",
    HEX_SMTP_USER: "hex@example.com",
    HEX_SMTP_PASSWORD: PASSWORD,
  };
  const forwarding = {
    from: "hex@example.com",
    targets: {
      sevdesk: { to: "autobox@sevdesk.example", enabled: true },
      paperless: { to: "bill@paperless.example", enabled: false },
    },
  };

  test("the enabled targets, and the SMTP settings from the environment, credentials redacted", async () => {
    const config = await loadForwardingConfig(await configFile({ ...valid, forwarding }), smtpEnv);
    expect(config).toMatchObject({
      from: "hex@example.com",
      targets: [{ name: "sevdesk", to: "autobox@sevdesk.example" }],
      smtp: { host: "smtp.example.com", port: 465, security: "tls" },
    });
    // The credentials are there, but never show when the settings are printed or serialised.
    expect(Redacted.value(config!.smtp.password)).toBe(PASSWORD);
    expect(Redacted.value(config!.smtp.user)).toBe("hex@example.com");
    for (const shown of [
      String(config!.smtp.password),
      JSON.stringify(config),
      Bun.inspect(config),
    ]) {
      expect(shown).not.toContain(PASSWORD);
    }
  });

  test.each([
    ["587, no security", { HEX_SMTP_PORT: "587" }, { port: 587, security: "starttls" }],
    ["465, no security", { HEX_SMTP_PORT: "465" }, { port: 465, security: "tls" }],
    [
      "implicit TLS on 2465",
      { HEX_SMTP_PORT: "2465", HEX_SMTP_SECURITY: "tls" },
      { port: 2465, security: "tls" },
    ],
    ["STARTTLS on 465", { HEX_SMTP_SECURITY: "starttls" }, { port: 465, security: "starttls" }],
    [
      "plain on 127.0.0.2",
      { HEX_SMTP_HOST: "127.0.0.2", HEX_SMTP_PORT: "2525", HEX_SMTP_SECURITY: "plain" },
      { host: "127.0.0.2", port: 2525, security: "plain" },
    ],
    [
      "plain on 127.0.0.1",
      { HEX_SMTP_HOST: "127.0.0.1", HEX_SMTP_SECURITY: "plain" },
      { host: "127.0.0.1", security: "plain" },
    ],
    ["plain on ::1", { HEX_SMTP_HOST: "::1", HEX_SMTP_SECURITY: "plain" }, { security: "plain" }],
  ])("%s", async (_case, env, smtp) => {
    const path = await configFile({ ...valid, forwarding });
    expect((await loadForwardingConfig(path, { ...smtpEnv, ...env }))?.smtp).toMatchObject(smtp);
  });

  test.each([
    ["no config file", undefined],
    ["no forwarding section", valid],
    [
      "every target disabled",
      {
        ...valid,
        forwarding: {
          ...forwarding,
          targets: { sevdesk: { ...forwarding.targets.sevdesk, enabled: false } },
        },
      },
    ],
    ["no targets", { ...valid, forwarding: { ...forwarding, targets: {} } }],
  ])("%s: Forwarding off, no SMTP setting needed", async (_case, content) => {
    const path = content === undefined ? undefined : await configFile(content);
    expect(await loadForwardingConfig(path, {})).toBeUndefined();
  });

  test.each(["HEX_SMTP_HOST", "HEX_SMTP_USER", "HEX_SMTP_PASSWORD"])(
    "a missing %s with a target enabled fails, naming it",
    async (name) => {
      const path = await configFile({ ...valid, forwarding });
      await expect(loadForwardingConfig(path, { ...smtpEnv, [name]: undefined })).rejects.toThrow(
        `hex config ${path}: forwarding: environment variable ${name} is not set`,
      );
    },
  );

  test.each([
    ["HEX_SMTP_PORT", "70000"],
    ["HEX_SMTP_PORT", "smtp"],
    ["HEX_SMTP_SECURITY", "ssl"],
  ])("%s=%j fails, naming the variable and never the password", async (name, value) => {
    const path = await configFile({ ...valid, forwarding });
    const loading = loadForwardingConfig(path, { ...smtpEnv, [name]: value });
    await expect(loading).rejects.toThrow(
      `hex config ${path}: forwarding: unusable environment variable: `,
    );
    await expect(loading).rejects.toThrow(`at ["${name}"]`);
    await expect(loading).rejects.not.toThrow(PASSWORD);
  });

  test.each([
    "smtp.example.com",
    "127.0.0.1.example.com",
    "10.0.0.1",
    // Names are resolved by DNS, not /etc/hosts; no IPv4 address; brackets can't connect.
    "localhost",
    "127.999.999.999",
    "[::1]",
  ])(
    "plaintext SMTP to %s is refused: only a loopback IP address may go without TLS",
    async (host) => {
      const path = await configFile({ ...valid, forwarding });
      const loading = loadForwardingConfig(path, {
        ...smtpEnv,
        HEX_SMTP_HOST: host,
        HEX_SMTP_SECURITY: "plain",
      });
      await expect(loading).rejects.toThrow(
        `hex config ${path}: forwarding: HEX_SMTP_SECURITY=plain is only allowed for a loopback IP address`,
      );
      await expect(loading).rejects.not.toThrow(PASSWORD);
    },
  );

  test.each([
    ["a sender that is no address", { ...forwarding, from: "hex" }, '["forwarding"]["from"]'],
    [
      "a target address with a display name",
      {
        ...forwarding,
        targets: { sevdesk: { to: "SevDesk <autobox@sevdesk.example>", enabled: true } },
      },
      '["forwarding"]["targets"]["sevdesk"]["to"]',
    ],
    [
      "two addresses",
      { ...forwarding, targets: { sevdesk: { to: "a@x.example,b@x.example", enabled: true } } },
      '["forwarding"]["targets"]["sevdesk"]["to"]',
    ],
    [
      "a target without enabled",
      { ...forwarding, targets: { sevdesk: { to: "autobox@sevdesk.example" } } },
      '["forwarding"]["targets"]["sevdesk"]["enabled"]',
    ],
    [
      "an unknown target key",
      {
        ...forwarding,
        targets: { sevdesk: { to: "autobox@sevdesk.example", enabled: true, password: "x" } },
      },
      '["forwarding"]["targets"]["sevdesk"]["password"]',
    ],
    [
      "an unknown forwarding key",
      { ...forwarding, smtpHost: "smtp.example.com" },
      '["forwarding"]["smtpHost"]',
    ],
    [
      "a target name that is no lowercase word",
      { ...forwarding, targets: { "Sev Desk": { to: "autobox@sevdesk.example", enabled: true } } },
      '["forwarding"]["targets"]',
    ],
  ])("%s fails, naming the file and the key", async (_case, content, at) => {
    const path = await configFile({ ...valid, forwarding: content });
    const loading = loadForwardingConfig(path, smtpEnv);
    await expect(loading).rejects.toThrow(`hex config ${path}: invalid config`);
    await expect(loading).rejects.toThrow(`at ${at}`);
  });
});
