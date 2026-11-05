import { isWildcardHost, urlHost } from "./listen-address";

/**
 * Host headers the server bound to `hostname` answers (DNS rebinding guard): loopback names with
 * the bound port, and without it on port 80, where clients omit the default port. A specific bind
 * address other than 127.0.0.1 (`HEX_HOST`) is allowed as well, being what clients of that
 * address send; a wildcard bind adds nothing, so behind a published port only the loopback names
 * work (ADR 0005).
 */
export function allowedHosts(port: number, hostname: string): Set<string> {
  const names = ["127.0.0.1", "localhost"];
  if (!isWildcardHost(hostname)) names.push(urlHost(hostname));
  const hosts = new Set(names.map((name) => `${name}:${port}`));
  if (port === 80) for (const name of names) hosts.add(name);
  return hosts;
}
