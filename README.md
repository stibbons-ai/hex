# hex

Daniel's personal agentic assistant (see [GLOSSARY.md](GLOSSARY.md) and [docs/adr](docs/adr)).
This workspace is the skeleton: a Bun server tracer with Mastra mounted, and the tooling every
later slice builds on.

## Install

Requires Bun 1.4.2 (the `packageManager` pin).

```sh
bun install --frozen-lockfile
```

`bunfig.toml` installs exact versions only and refuses packages published less than three days
ago. Every external dependency version lives in the root `package.json` `catalog`; packages
depend on externals with `catalog:` and on each other with `workspace:*` (ADR 0003). To add a
dependency, add the catalog entry first, then reference it with `catalog:`.

## Run

```sh
bun run start
```

The server binds to `127.0.0.1` only, on `HEX_PORT` (default `4111`; `0` picks a free port), and
stores Mastra's state in a LibSQL file at `<data dir>/mastra.db`. The data directory is
`HEX_DATA_DIR`, default `./.data` (git-ignored); it is created on start.

```sh
curl http://127.0.0.1:4111/health        # {"status":"ok"}
curl http://127.0.0.1:4111/api/workflows # Mastra's routes, mounted through @mastra/hono
```

## Check

```sh
bun run check         # everything below, in this order; CI runs it on Ubuntu and macOS
bun run format:check  # oxfmt (bun run format writes)
bun run lint          # oxlint --deny-warnings
bun run typecheck     # tsc --noEmit
bun run catalog       # ADR 0003 specifier policy, exact @mastra/* pins
bun run licenses      # dependency licence policy
bun run test          # bun test
```

## Packages

| Package             | Holds                                                                          |
| ------------------- | ------------------------------------------------------------------------------ |
| `@hex/domain`       | Pure domain: Effect only. Lint rejects Mastra, LibSQL, Hono, Node, Bun imports |
| `@hex/adapters`     | Effect Schema → Mastra helper (`toMastraSchema`, ADR 0002); LibSQL storage     |
| `@hex/server`       | `Bun.serve` entrypoint mounting Mastra's routes via `@mastra/hono`             |
| `@hex/eval-harness` | Empty until the evaluation slice                                               |

Mastra does not validate step output, so every step decodes its own output with its Effect schema;
`packages/adapters/test/schema.test.ts` pins that contract against real workflow runs.

## Telemetry and licences

Every script that runs code sets `MASTRA_TELEMETRY_DISABLED=1` (read by `@mastra/core`'s usage
telemetry) and `DO_NOT_TRACK=1` (Bun's crash reports; `bunfig.toml` also sets `telemetry =
false`), and so does CI. When you run `bun` or Mastra directly instead of through a script, set
both yourself.

`bun run licenses` audits every installed package's manifest plus the lockfile. Only MIT,
Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, CC0-1.0, Unlicense and BlueOak-1.0.0 pass;
copyleft (GPL, LGPL, AGPL, MPL, …), non-commercial and unknown licences fail unless
`scripts/license-allowlist.json` has an exact package, version and licence entry with a reviewed
reason. Packages for other platforms, which are never installed locally, are audited from
`scripts/platform-license-metadata.json` (licence, lockfile integrity and npm URL per exact
version); a dependency update that adds or changes a platform package must update that file after
reviewing each licence. Notable licences and attributions are in
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES). Mastra's `ee/` directories are not Apache-2.0; lint
rejects importing them.
