/**
 * Host headers the server answers (DNS rebinding guard): loopback names with the bound port, and
 * without it on port 80, where clients omit the default port.
 */
export function allowedHosts(port: number): Set<string> {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  return new Set(port === 80 ? [...hosts, "127.0.0.1", "localhost"] : hosts);
}
