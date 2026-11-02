# Dependency versions live only in the root catalog

Every external dependency version is declared once, in the top-level `catalog` field of the root `package.json` (Bun catalogs; not nested under `workspaces`). Workspace packages never state a version: external dependencies are always `"catalog:"`, internal ones always `"workspace:*"`. One place to read and bump versions keeps all packages on the same Mastra and Effect release, which matters because the exact Mastra pins of ADR 0002 must move together; CI fails on any workspace dependency that uses another specifier.

## Consequences

- Adding a dependency means `bun add <pkg> --catalog` from the package, or adding the catalog entry first.
- Named catalogs (`catalogs`) are not used until a real need for divergent versions appears.
