# Our own oRPC API instead of Mastra's routes

hex no longer mounts Mastra's REST routes through `@mastra/hono`. Our `Bun.serve` entrypoint answers `GET /health` itself and serves a small contract-first oRPC API under `/rpc` (`@orpc/server` with its fetch `RPCHandler`), whose procedures call Mastra in-process: `health`, `workflows.list`, `workflows.start` and `workflows.runs`. Their schemas are Effect Schemas handed to oRPC as Standard Schema through the ADR 0002 helper. The reason is licensing: `@mastra/hono` 1.7.22 wraps `@mastra/server` 1.80.0, which statically imports `@mastra/core/auth/ee`, content under the Mastra Enterprise Edition licence rather than Apache-2.0. Dropping both packages removes that import from our dependency graph, and callers get a typed client (`@orpc/client`) instead of hand-written REST calls.

## Consequences

- `@mastra/server` and `@mastra/hono` are not dependencies; lint rejects importing them, and a test fails if either reappears in the lockfile.
- Mastra Studio and any other client of Mastra's REST routes (`/api/...`) do not work against our entrypoint. Every operation a caller needs becomes an oRPC procedure here.
- The `mastra` CLI (`mastra dev`) brings `@mastra/server` back: `mastra` 1.36.0 depends on `@mastra/deployer` ^1.80.0, and `@mastra/deployer` 1.80.0 and 1.81.0 each pin `@mastra/server` exactly (npm registry, checked 2026-11-02). Using it means installing the ee-importing server, so it is not a hex dependency.
- Residual: `@mastra/core` 1.80.0 still ships its ee code, and its agent and tool modules statically import the compiled auth ee chunk (`dist/ee-*.js`; `dist/auth/ee/fga-check.js` re-exports it), so Bun loads that chunk at startup. Loading only defines its functions and permission-name constants. Every call into it is gated on an FGA provider (`if (fgaProvider)` around the call or inside `requireFGA`, sometimes behind an `await import()`), and hex configures no auth, so apart from reading those constants the ee code does not run. Re-check on every Mastra upgrade.
- `hono` stays in the lockfile as a dependency of `@mastra/core` itself, not of ours.
