import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunningServer } from "../src";
import { INTAKE_WORKFLOW_ID } from "../src/intake-workflow";
import { DANIEL, DM_CHANNEL, fakeSlack, slackEnv } from "./fake-slack";
import { fakeImap } from "./fake-imap";
import { client } from "./server-helpers";
import { freePort } from "./timeouts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const telemetryOff = { MASTRA_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" };
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "hex-main-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function spawnMain(env: Record<string, string>) {
  return Bun.spawn(["bun", main], {
    cwd: directory,
    // HEX_CONFIG cleared so a developer's own config can't leak in; tests that need one set it.
    env: { ...process.env, ...telemetryOff, HEX_CONFIG: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Reads stdout until the "listening on" line; returns its URL and everything read so far. */
async function listeningUrl(
  stdout: ReadableStream<Uint8Array>,
): Promise<{ url: URL; output: string }> {
  const decoder = new TextDecoder();
  let output = "";
  for await (const chunk of stdout) {
    output += decoder.decode(chunk, { stream: true });
    const match = /hex listening on (\S+)/.exec(output);
    if (match) return { url: new URL(match[1]!), output };
  }
  throw new Error(`Server exited before listening:\n${output}`);
}

describe("bun packages/server/src/main.ts", () => {
  test.each(["SIGTERM", "SIGINT"] as const)(
    "serves health from HEX_DATA_DIR, says chat is off once, and exits 0 on %s",
    async (signal) => {
      const dataDirectory = join(directory, signal, "data");
      const child = spawnMain({ HEX_PORT: "0", HEX_DATA_DIR: dataDirectory });
      try {
        const { url, output } = await listeningUrl(child.stdout);
        expect(output.match(/hex: chat off: HEX_CONFIG is not set/g)).toHaveLength(1);
        expect(output.match(/hex: mailbox off: HEX_CONFIG is not set/g)).toHaveLength(1);
        expect(output.match(/hex: Intake reports off: HEX_CONFIG is not set/g)).toHaveLength(1);
        expect(url.hostname).toBe("127.0.0.1");
        const health = await fetch(new URL("/health", url));
        expect(health.status).toBe(200);
        expect(await health.json()).toEqual({ status: "ok" });
      } finally {
        child.kill(signal);
      }
      expect(await child.exited).toBe(0);
      expect((await stat(join(dataDirectory, "mastra.db"))).size).toBeGreaterThan(0);
      expect((await stat(join(dataDirectory, "observability.duckdb"))).size).toBeGreaterThan(0);
    },
  );

  test("defaults the data directory to .data under the working directory", async () => {
    const child = spawnMain({ HEX_PORT: "0", HEX_DATA_DIR: "" });
    try {
      await listeningUrl(child.stdout);
    } finally {
      child.kill("SIGTERM");
    }
    expect(await child.exited).toBe(0);
    expect((await stat(join(directory, ".data", "mastra.db"))).size).toBeGreaterThan(0);
    expect((await stat(join(directory, ".data", "observability.duckdb"))).size).toBeGreaterThan(0);
  });

  test("a failed startup exits 1 with the listen error reported once", async () => {
    const taken = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    try {
      const child = spawnMain({
        HEX_PORT: String(taken.port),
        HEX_DATA_DIR: join(directory, "taken"),
      });
      try {
        expect(await child.exited).toBe(1);
      } finally {
        child.kill();
      }
      const stderr = await new Response(child.stderr).text();
      // Count Bun's printed error lines only: under GitHub Actions, Bun also emits an
      // `::error …::` annotation for the same uncaught error. The whole stderr is part of the
      // received value, so a failure shows what was reported.
      const reports = stderr.match(/^error: Failed to start server/gm)?.length ?? 0;
      expect({ reports, stderr }).toMatchObject({ reports: 1 });
    } finally {
      await taken.stop(true);
    }
  });

  test.each([" ", "1e3", "0x10", "-1", "65536", "80.5", "port"])(
    "rejects HEX_PORT=%j",
    async (port) => {
      const child = spawnMain({ HEX_PORT: port, HEX_DATA_DIR: join(directory, "rejected") });
      try {
        expect(await child.exited).toBe(1);
      } finally {
        child.kill();
      }
      expect(await new Response(child.stderr).text()).toContain(
        `HEX_PORT must be an integer from 0 to 65535, got ${JSON.stringify(port)}`,
      );
    },
  );

  test("rejects a HEX_HOST that isn't an IP address before opening any file", async () => {
    const dataDirectory = join(directory, "rejected-host");
    const child = spawnMain({ HEX_HOST: "localhost", HEX_PORT: "0", HEX_DATA_DIR: dataDirectory });
    try {
      expect(await child.exited).toBe(1);
    } finally {
      child.kill();
    }
    expect(await new Response(child.stderr).text()).toContain(
      'HEX_HOST must be an IP address (127.0.0.1, or 0.0.0.0 inside a container), got "localhost"',
    );
    expect(await Bun.file(join(dataDirectory, "mastra.db")).exists()).toBe(false);
  });

  test("HEX_HOST=0.0.0.0 warns that there is no authentication and serves loopback Host headers only", async () => {
    const child = spawnMain({
      HEX_HOST: "0.0.0.0",
      HEX_PORT: "0",
      HEX_DATA_DIR: join(directory, "wildcard"),
    });
    try {
      const { url } = await listeningUrl(child.stdout);
      const loopback = `http://127.0.0.1:${url.port}/health`;
      expect(await (await fetch(loopback)).json()).toEqual({ status: "ok" });
      const rebound = await fetch(loopback, { headers: { host: `evil.example:${url.port}` } });
      expect(rebound.status).toBe(403);
    } finally {
      child.kill("SIGTERM");
    }
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toContain(
      "hex: listening on 0.0.0.0, beyond loopback: the server has no authentication",
    );
  });

  test("a config that can't be used fails startup with the file and the problem", async () => {
    const config = join(directory, "hex.json");
    await Bun.write(
      config,
      JSON.stringify({
        chat: {
          model: "anthropic/claude-opus-5-5",
          channels: { slack: { options: { mode: "socket" }, allowlist: ["U0DANIEL"] } },
        },
      }),
    );
    const child = spawnMain({
      HEX_PORT: "0",
      HEX_DATA_DIR: join(directory, "bad-config"),
      HEX_CONFIG: config,
      SLACK_APP_TOKEN: "",
    });
    try {
      expect(await child.exited).toBe(1);
    } finally {
      child.kill();
    }
    expect(await new Response(child.stderr).text()).toContain(
      `hex config ${config}: channel "slack": environment variable SLACK_APP_TOKEN is not set`,
    );
  });

  test("a config with no channels runs without chat, saying so", async () => {
    const config = join(directory, "no-channels.json");
    await Bun.write(config, JSON.stringify({ chat: { model: "openai/gpt-5", channels: {} } }));
    const child = spawnMain({
      HEX_PORT: "0",
      HEX_DATA_DIR: join(directory, "no-channels"),
      HEX_CONFIG: config,
    });
    try {
      const { output } = await listeningUrl(child.stdout);
      expect(output).toContain(`hex: chat off: ${config} configures no channels`);
      expect(output).toContain(`hex: mailbox off: ${config} configures no mailbox`);
      expect(
        output.split(`hex: Intake reports off: ${config} configures no Main channel`),
      ).toHaveLength(2);
    } finally {
      child.kill("SIGTERM");
    }
    expect(await child.exited).toBe(0);
  });

  test("a config with a Main channel posts each Intake's report to Daniel's Slack DM", async () => {
    const slack = fakeSlack();
    const config = join(directory, "main-channel.json");
    await Bun.write(
      config,
      JSON.stringify({
        chat: {
          model: "openai/gpt-5",
          channels: { slack: { options: { mode: "socket" }, allowlist: [DANIEL] } },
          mainChannel: { channel: "slack", user: DANIEL },
        },
      }),
    );
    const child = spawnMain({
      ...slackEnv(slack),
      HEX_PORT: "0",
      HEX_DATA_DIR: join(directory, "main-channel"),
      HEX_CONFIG: config,
    });
    try {
      const { url, output } = await listeningUrl(child.stdout);
      expect(output).not.toContain("Intake reports off");
      // An Intake without Documents: processed without asking a model.
      const started = await client({ url } as RunningServer).workflows.start({
        workflowId: INTAKE_WORKFLOW_ID,
        inputData: {
          messageId: "<main@shop.example>",
          receivedAt: "2026-11-02T07:15:00.000Z",
          subject: "Rechnung",
          sender: "billing@shop.example",
          cidReferences: [],
          attachments: [],
        },
      });
      expect(started).toMatchObject({ status: "success", result: { report: { status: "sent" } } });
      const post = await slack.posted();
      expect(post.get("channel")).toBe(DM_CHANNEL);
      expect(post.get("text")).toBe(
        "Intake processed: `Rechnung` from `billing@shop.example`\nNo Documents; nothing filed.",
      );
    } finally {
      child.kill("SIGTERM");
      await child.exited;
      await slack.server.stop(true);
    }
  });

  test("an Intake ledger that can't be opened fails startup, naming it", async () => {
    const dataDirectory = join(directory, "broken-ledger");
    await mkdir(dataDirectory, { recursive: true });
    // Mastra can open this database, but the ledger table's name is taken by an index.
    const database = new Database(join(dataDirectory, "mastra.db"));
    database.run("CREATE TABLE x (a)");
    database.run("CREATE INDEX hex_intake_ledger ON x (a)");
    database.close();
    const child = spawnMain({ HEX_PORT: "0", HEX_DATA_DIR: dataDirectory });
    try {
      expect(await child.exited).toBe(1);
    } finally {
      child.kill();
    }
    const stderr = await new Response(child.stderr).text();
    expect(stderr).toContain("Intake ledger: opening");
    expect(stderr).toContain("already an index named hex_intake_ledger");
  });

  describe("with a mailbox", () => {
    // With `"` and `\`, which LOGIN sends escaped: `imap-se\"cr\\et-0123456789`.
    const PASSWORD = 'imap-se"cr\\et-0123456789';
    const ESCAPED = 'imap-se\\"cr\\\\et-0123456789';
    /** hex with a config watching INBOX on the IMAP server at 127.0.0.1:`port`, in plaintext. */
    async function spawnWithMailbox(name: string, port: number) {
      const config = join(directory, `${name}.json`);
      await Bun.write(
        config,
        JSON.stringify({ chat: { model: "openai/gpt-5", channels: {} }, mailbox: {} }),
      );
      return spawnMain({
        HEX_PORT: "0",
        HEX_DATA_DIR: join(directory, name),
        HEX_CONFIG: config,
        HEX_IMAP_HOST: "127.0.0.1",
        HEX_IMAP_PORT: String(port),
        HEX_IMAP_SECURITY: "plain",
        HEX_IMAP_USER: "intake@example.com",
        HEX_IMAP_PASSWORD: PASSWORD,
      });
    }

    test("a mailbox it can open is watched, saying so on stdout", async () => {
      const imap = fakeImap();
      try {
        const child = await spawnWithMailbox("watching", imap.port);
        try {
          const { output } = await listeningUrl(child.stdout);
          expect(output).toContain(
            `hex: mailbox on: watching INBOX on 127.0.0.1:${imap.port}, looking again 60 s after a look without news`,
          );
        } finally {
          child.kill("SIGTERM");
        }
        expect(await child.exited).toBe(0);
      } finally {
        imap.server.stop(true);
      }
    });

    test("an IMAP server that refuses the login fails startup, never showing the credentials", async () => {
      const imap = fakeImap({ refuseLogin: true });
      try {
        const child = await spawnWithMailbox("refused-login", imap.port);
        try {
          expect(await child.exited).toBe(1);
        } finally {
          child.kill();
        }
        const stderr = await new Response(child.stderr).text();
        // The server got the password, escaped, and echoed it back in its refusal.
        expect(imap.logins.join("\n")).toContain(ESCAPED);
        expect(stderr).toContain(`127.0.0.1:${imap.port}, folder INBOX: logging in failed`);
        expect(stderr).toContain('LOGIN "***" "***"');
        for (const form of [PASSWORD, ESCAPED, Buffer.from(PASSWORD).toString("base64")]) {
          expect(stderr).not.toContain(form);
        }
      } finally {
        imap.server.stop(true);
      }
    });

    test("an IMAP server without MOVE fails startup, naming the extension", async () => {
      const imap = fakeImap({ capabilities: "IMAP4rev1 IDLE UIDPLUS" });
      try {
        const child = await spawnWithMailbox("no-move", imap.port);
        try {
          expect(await child.exited).toBe(1);
        } finally {
          child.kill();
        }
        expect(await new Response(child.stderr).text()).toContain(
          `127.0.0.1:${imap.port}, folder INBOX: checking the server failed: the server lacks the IMAP MOVE extension (RFC 6851)`,
        );
        // Never got as far as touching the folder.
        expect(imap.commands.some((line) => /\b(SELECT|EXAMINE)\b/i.test(line))).toBe(false);
      } finally {
        imap.server.stop(true);
      }
    });

    test("an IMAP server that can't be reached fails startup, naming it", async () => {
      const port = await freePort();
      const child = await spawnWithMailbox("unreachable", port);
      try {
        expect(await child.exited).toBe(1);
      } finally {
        child.kill();
      }
      expect(await new Response(child.stderr).text()).toContain(
        `127.0.0.1:${port}, folder INBOX: connecting failed`,
      );
    });
  });
});
