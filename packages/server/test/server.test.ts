import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { type RunningServer, startServer } from "../src";

const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((address) => address && address.family === "IPv4" && !address.internal)?.address;

describe("hex server", () => {
  let directory: string;
  let databasePath: string;
  let server: RunningServer;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "hex-server-"));
    // A missing parent directory is created on start.
    databasePath = join(directory, "data", "mastra.db");
    server = await startServer({ databasePath, port: 0 });
  });

  afterAll(async () => {
    await server?.stop();
    await rm(directory, { recursive: true, force: true });
  });

  test("binds to 127.0.0.1 on an ephemeral port", () => {
    expect(server.url.hostname).toBe("127.0.0.1");
    expect(Number(server.url.port)).toBeGreaterThan(0);
  });

  test("answers the health route", async () => {
    const response = await fetch(new URL("/health", server.url));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("mounts Mastra's routes through the Hono adapter", async () => {
    const workflows = await fetch(new URL("/api/workflows", server.url));
    expect(workflows.status).toBe(200);
    expect(await workflows.json()).toEqual({});
    expect((await fetch(new URL("/api/no-such-route", server.url))).status).toBe(404);
  });

  test("stores Mastra state in the LibSQL file", async () => {
    expect((await stat(databasePath)).size).toBeGreaterThan(0);
  });

  test.skipIf(lanAddress === undefined)(
    "refuses connections on a non-loopback address",
    async () => {
      const url = new URL("/health", server.url);
      url.hostname = lanAddress!;
      await expect(fetch(url)).rejects.toThrow();
    },
  );
});
