/**
 * Where the server listens, shared by the server (`main.ts`) and the container health check.
 * Only Node built-ins, so the health check's bundle loads nothing else. Adapted from
 * stibbons-ai/iconograph `packages/server/src/listen-address.ts` (MIT).
 */
import { isIP } from "node:net";

export const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4111;

/** Whether `hostname` binds every interface; such a server is reachable on loopback too. */
export function isWildcardHost(hostname: string): boolean {
  return hostname === "0.0.0.0" || hostname === "::";
}

/**
 * `HEX_HOST` (default 127.0.0.1; an IPv4 or IPv6 address, never a name) and `HEX_PORT` (default
 * 4111; 0 picks a free port). Empty values count as unset; the generic `HOST`/`PORT` never apply.
 * Throws naming the variable and the value it got.
 */
export function listenAddress(env: Readonly<Record<string, string | undefined>> = process.env): {
  /** An IP address: loopback by default, `0.0.0.0` in the container image (ADR 0005). */
  hostname: string;
  /** TCP port; 0 picks a free one. */
  port: number;
} {
  const portText = env["HEX_PORT"] || String(DEFAULT_PORT);
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port > 65535) {
    throw new Error(`HEX_PORT must be an integer from 0 to 65535, got ${JSON.stringify(portText)}`);
  }
  const hostname = env["HEX_HOST"] || DEFAULT_HOST;
  // A name could resolve to any interface, or to another machine's address.
  if (isIP(hostname) === 0) {
    throw new Error(
      `HEX_HOST must be an IP address (127.0.0.1, or 0.0.0.0 inside a container), got ${JSON.stringify(hostname)}`,
    );
  }
  return { hostname, port };
}

/** A host as it appears in a URL or a `Host` header: IPv6 addresses in brackets. */
export const urlHost = (hostname: string) => (isIP(hostname) === 6 ? `[${hostname}]` : hostname);
