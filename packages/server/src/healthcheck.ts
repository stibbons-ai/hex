/**
 * The container's health check: distroless has no shell or curl, so the image runs this with
 * `bun`. Exits 0 when the server's `/health` answers 200 with `{"status":"ok"}`; else writes why,
 * with the URL it checked, to stderr (Docker keeps it in the health log) and exits 1. Adapted from
 * stibbons-ai/iconograph `packages/server/src/healthcheck.ts` (MIT).
 */
import { isWildcardHost, listenAddress, urlHost } from "./listen-address";

let url = "/health";
try {
  const { hostname, port } = listenAddress();
  // A wildcard bind is reachable on loopback, whose Host header the server allows.
  const host = isWildcardHost(hostname) ? "127.0.0.1" : urlHost(hostname);
  url = `http://${host}:${port}/health`;
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  const body = await response.text();
  let healthy = false;
  try {
    healthy = response.ok && (JSON.parse(body) as { status?: unknown } | null)?.status === "ok";
  } catch {
    // Not JSON: unhealthy, reported with the body below.
  }
  if (!healthy) {
    process.stderr.write(`${url} answered ${response.status}: ${body}\n`);
    process.exit(1);
  }
} catch (error) {
  process.stderr.write(`${url}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
