import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadChatConfig } from "../src/config";
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

  test.each(["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"])(
    "a missing %s fails, naming it",
    async (name) => {
      const path = await configFile(valid);
      await expect(loadChatConfig(path, { ...slackEnv, [name]: undefined })).rejects.toThrow(
        `hex config ${path}: channel "slack": environment variable ${name} is not set`,
      );
    },
  );

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
