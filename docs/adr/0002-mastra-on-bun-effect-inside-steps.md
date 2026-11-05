# Mastra on Bun, Effect inside Mastra steps (inherited from iconograph)

hex adopts the decisions proven in `stibbons-ai/iconograph` instead of re-running the spike: Bun is the runtime, with our own `Bun.serve` entrypoint mounting Mastra's routes via `@mastra/hono` (`mastra dev` for development only), shipped as a Bun JS bundle with native addons external (iconograph ADR-0007, ADR-0009). Mastra owns workflow durability; Effect runs inside steps through one shared `ManagedRuntime`, schemas are Effect Schemas handed to Mastra through a helper that applies both `Schema.toStandardSchemaV1` and `Schema.toStandardJSONSchemaV1`, and every step decodes its own output because Mastra does not validate step output (iconograph ADR-0006).

Superseded in part: mounting Mastra's routes via `@mastra/hono` is replaced by our own oRPC API ([ADR 0004](0004-orpc-api-instead-of-mastra-routes.md)).

## Consequences

- Mastra versions are pinned exactly; a Mastra upgrade re-checks the bundle's model-capability metadata, the schema helper, and hex's sendability sniff in `packages/domain/src/document.ts` (mirrors Mastra's `isValidInlineContent`; the contract tests in `packages/adapters/test/date-extractor.test.ts` catch a tightened check).
- Not covered by iconograph and still to prove in hex: Mastra Channels (Slack socket mode) under the Bun entrypoint.
- The bundle's details (the externals `libsql` and `@duckdb/node-api`, the pruned install, the copied capability metadata) and the container image are recorded in [ADR 0005](0005-container-binds-all-interfaces-publish-on-loopback.md).
