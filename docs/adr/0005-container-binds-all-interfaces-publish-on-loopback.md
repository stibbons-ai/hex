# In a container hex binds every interface; the host publishes it on loopback only

hex runs on Daniel's Mac as one locally built arm64 image under `docker compose` (issue #5), adopting iconograph's decision (iconograph ADR-0012). The server listens on `127.0.0.1` by default; `HEX_HOST` (an IP address, never a name) and `HEX_PORT` change that, and any non-loopback address logs a warning at start that the server has no authentication. A loopback listener inside a container is unreachable through a published port, so the image sets `HEX_HOST=0.0.0.0` inside its own network namespace, and `compose.yaml` publishes the port as `127.0.0.1:4111:4111`. The host-side publish address, not the bind address, then decides who can reach the server.

The image follows ADR 0002's Bun JS bundle with the native addons external: `scripts/build-server.ts` bundles `packages/server/src/main.ts` (with the smoke test and the health check) using `bun build --target bun`, leaving `libsql` (LibSQL) and `@duckdb/node-api` (DuckDB, via `@mastra/duckdb`) external; installs only those, production-only, from a lockfile subset generated from `bun.lock` and pruned to the target platform (by `os`/`cpu`, and by libc from the entry's `libc` field or, for LibSQL, its name); and copies `@mastra/core`'s `package.json` and `dist/capabilities` beside them. The final stage is `gcr.io/distroless/cc-debian13` (non-root) with `bun` 1.4.2, both pinned by digest.

## Consequences

- `docker run -p 4111:4111` (without `127.0.0.1:`) exposes the unauthenticated server, its Documents and the model keys to the network; the README says so next to the compose instructions.
- The `Host` allow-list is unchanged for the container: a wildcard bind adds no name, so only `127.0.0.1:4111` and `localhost:4111` are answered, which is what the Mac and the in-container health check send. The host port must therefore stay 4111; publishing on another host port answers 403. A specific `HEX_HOST` address is allowed as a `Host` too.
- When an authenticated LAN mode is added, it must decide what a non-loopback bind requires, for the container's wildcard bind as for any other: the server can't tell them apart.
- The generic `HOST`/`PORT` variables never change the bind; `compose.yaml` pins the `HEX_*` settings and the telemetry opt-outs over `.env`.
- Bundling breaks Mastra's model-capability lookup silently (it reads JSON next to its own `package.json`, else every capability is `undefined`); the CI `image` job, on GitHub's arm64 runner, runs `/app/smoke.js` (capabilities resolve, LibSQL and DuckDB open) on the built image and boots it until its health check reports `healthy`. A Mastra upgrade re-checks where it reads capabilities from.
- No registry publishing and no multi-arch build: the image is built where it runs.
