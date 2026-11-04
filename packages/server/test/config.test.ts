import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadChatConfig } from "../src/config";

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
      `hex config ${path}: channel "toString": unknown adapter; known: slack`,
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
});
