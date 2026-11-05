import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
        expect(url.hostname).toBe("127.0.0.1");
        const health = await fetch(new URL("/health", url));
        expect(health.status).toBe(200);
        expect(await health.json()).toEqual({ status: "ok" });
      } finally {
        child.kill(signal);
      }
      expect(await child.exited).toBe(0);
      expect((await stat(join(dataDirectory, "mastra.db"))).size).toBeGreaterThan(0);
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
    } finally {
      child.kill("SIGTERM");
    }
    expect(await child.exited).toBe(0);
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
});
