# syntax=docker/dockerfile:1
# The server image (ADR 0002, ADR 0005): distroless glibc with `bun`, the server bundle and a
# production install of only its external packages (LibSQL's and DuckDB's native addons), pruned
# to the target platform. Adapted from stibbons-ai/iconograph's Dockerfile (MIT).

# Base images pinned by digest (multi-arch indexes); bump tag and digest together. Bun matches CI.
ARG BUN_IMAGE=oven/bun:1.4.2-debian@sha256:4f6e31d1a54d6a3dd312daef655fc998101b5043d52e12592ac293ef04b9bc73
ARG RUNTIME_IMAGE=gcr.io/distroless/cc-debian13:nonroot@sha256:08476c244888bfb425bae1ae4dd7c17f093e972aab8426883d97f3c6f280f7c1

# Bundling is platform-independent, so it runs on the build machine's platform and installs
# the externals for the target one (no emulation).
FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS build
WORKDIR /src
# Owned by distroless's nonroot user below, so an empty named volume or an unmounted Outbox is
# writable. Their own layer, so a source change doesn't give them a new digest.
RUN mkdir /data /outbox
COPY package.json bun.lock bunfig.toml ./
COPY packages/adapters/package.json packages/adapters/
COPY packages/domain/package.json packages/domain/
COPY packages/eval-harness/package.json packages/eval-harness/
COPY packages/server/package.json packages/server/
# The bundle needs only runtime dependencies; dev tools stay out.
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
  bun install --frozen-lockfile --ignore-scripts --production
COPY packages packages
COPY scripts/build-server.ts scripts/bun-lock.ts scripts/externals-manifest.ts scripts/
# Declared here, so the install above is shared by every target platform.
ARG TARGETOS
ARG TARGETARCH
# npm names Docker's amd64 x64.
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
  cpu="$(if [ "$TARGETARCH" = amd64 ]; then echo x64; else echo "$TARGETARCH"; fi)" \
  && bun scripts/build-server.ts --os "$TARGETOS" --cpu "$cpu" --libc glibc --out /out

# The target platform's bun binary.
FROM ${BUN_IMAGE} AS bun

FROM ${RUNTIME_IMAGE}
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=build /out /app
LABEL org.opencontainers.image.source="https://github.com/stibbons-ai/hex" \
      org.opencontainers.image.licenses="MIT"
COPY --from=build --chown=nonroot:nonroot /data /data
COPY --from=build --chown=nonroot:nonroot /outbox /outbox
WORKDIR /app
# Listening on every interface is needed inside the container's own network namespace for a
# published port to reach the server; the host-side exposure is the publish address
# (compose.yaml: 127.0.0.1 only, ADR 0005).
ENV HEX_HOST=0.0.0.0 \
    HEX_PORT=4111 \
    HEX_DATA_DIR=/data \
    HEX_OUTBOX_DIR=/outbox \
    MASTRA_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1 \
    NODE_ENV=production
USER nonroot
VOLUME /data
EXPOSE 4111
# Distroless has no shell or curl, so the image's bun runs the check against /health.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --start-interval=2s --retries=3 \
  CMD ["/usr/local/bin/bun", "/app/healthcheck.js"]
ENTRYPOINT ["/usr/local/bin/bun", "/app/main.js"]
