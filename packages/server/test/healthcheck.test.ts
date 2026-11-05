import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const healthcheck = fileURLToPath(new URL("../src/healthcheck.ts", import.meta.url));

/** Runs the container health check against 127.0.0.1:`port`; its exit code and stderr. */
async function check(port: number) {
  const child = Bun.spawn([process.execPath, healthcheck], {
    env: { ...process.env, HEX_HOST: "0.0.0.0", HEX_PORT: String(port) },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr };
}

/** Runs the health check against a stub server answering every request with `respond()`. */
async function checkAgainst(respond: () => Response) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: respond });
  try {
    return { ...(await check(server.port!)), port: server.port! };
  } finally {
    await server.stop(true);
  }
}

describe("healthcheck.ts", () => {
  test('exits 0 when /health answers 200 {"status":"ok"}, asked on loopback for a wildcard bind', async () => {
    const hosts: (string | null)[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        hosts.push(request.headers.get("host"));
        return Response.json({ status: "ok" });
      },
    });
    try {
      expect((await check(server.port!)).code).toBe(0);
      // The Host header the server's allow-list sees: loopback with the port.
      expect(hosts).toEqual([`127.0.0.1:${server.port}`]);
    } finally {
      await server.stop(true);
    }
  });

  test("exits 1 with the URL when nothing listens", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = closed.port!;
    await closed.stop(true);
    const { code, stderr } = await check(port);
    expect(code).toBe(1);
    expect(stderr).toContain(`http://127.0.0.1:${port}/health: `);
  });

  test.each([
    ["a 403", () => new Response("Forbidden host", { status: 403 }), "403: Forbidden host"],
    [
      'a 503 whose body says {"status":"ok"}',
      () => Response.json({ status: "ok" }, { status: 503 }),
      '503: {"status":"ok"}',
    ],
    [
      "a 200 with another status",
      () => Response.json({ status: "starting" }),
      '200: {"status":"starting"}',
    ],
    ["a 200 that isn't JSON", () => new Response("ok"), "200: ok"],
    ["a 200 with JSON null", () => Response.json(null), "200: null"],
  ])("exits 1 on %s, with the URL and the body", async (_, respond, reported) => {
    const { code, stderr, port } = await checkAgainst(respond);
    expect(code).toBe(1);
    expect(stderr).toContain(`http://127.0.0.1:${port}/health answered ${reported}`);
  });
});
