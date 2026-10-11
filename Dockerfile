# syntax=docker/dockerfile:1.7
#
# Agent Bank: one Dockerfile for every deployable Node service in the monorepo.
#
#   docker build --build-arg APP=api         -t agent-bank/api .          # REST API          :8080
#   docker build --build-arg APP=cosigner    -t agent-bank/cosigner .     # policy + KMS      :8081
#   docker build --build-arg APP=indexer     -t agent-bank/indexer .      # indexer + recon   :8082
#   docker build --build-arg APP=facilitator -t agent-bank/facilitator .  # x402 facilitator  :8083
#   docker build --build-arg APP=console     -t agent-bank/console .      # Next.js console   :3000
#
# Recommended extra build args for traceability:
#   --build-arg GIT_SHA=$(git rev-parse HEAD) --build-arg VERSION=<semver or sha>
#   --build-arg BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
#
# apps/docs is a static site and is intentionally not containerised. An APP value without a
# matching `runtime-<APP>` stage below fails with "pull access denied for runtime-<APP>".
#
# Stages: base -> pruner (turbo prune) -> builder (pnpm install + turbo build + pnpm deploy)
#         -> runtime-base (distroless, non-root) -> runtime-<APP> (port + start command).
#
# Local runs: pass `--init` (ECS sets initProcessEnabled) so SIGTERM reaches Node, e.g.
#   docker run --init --rm -p 8080:8080 --env-file .env.local agent-bank/api

# Base images are pinned by digest for reproducible, reviewable builds; bump them with
# Renovate/Dependabot. Builder (Debian 13 "trixie") and runtime (distroless Debian 13) share
# the same glibc, so native addons compiled in the builder load in the runtime image.
ARG NODE_IMAGE=node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs22-debian13:nonroot@sha256:ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c
ARG APP

# -----------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ARG COREPACK_VERSION=0.36.0
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    TURBO_TELEMETRY_DISABLED=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1
# The corepack bundled with Node 22 can carry stale npm signing keys; install a pinned one.
# pnpm itself is resolved from the repository's `packageManager` field.
RUN npm install --global --no-fund --no-audit "corepack@${COREPACK_VERSION}" \
 && corepack enable
WORKDIR /repo

# -----------------------------------------------------------------------------------------
# 1. Prune the workspace down to APP and the internal packages it depends on.
FROM base AS pruner
ARG APP
# Defaults to the turbo version pinned in the root package.json.
ARG TURBO_VERSION=""
COPY . .
RUN set -eu; \
    if [ -z "${APP}" ]; then \
      echo "error: --build-arg APP=<api|cosigner|indexer|facilitator|console> is required" >&2; exit 1; \
    fi; \
    if [ ! -f "apps/${APP}/package.json" ]; then \
      echo "error: apps/${APP}/package.json not found" >&2; exit 1; \
    fi; \
    turbo_version="${TURBO_VERSION:-$(node -p "const p=require('./package.json');(p.devDependencies||{}).turbo||(p.dependencies||{}).turbo||'2'")}"; \
    pnpm dlx "turbo@${turbo_version}" prune "@agentbank/${APP}" --docker

# -----------------------------------------------------------------------------------------
# 2. Install (cached on lockfile + manifests only), build, and assemble a production tree.
FROM base AS builder
ARG APP
COPY --from=pruner /repo/out/json/ ./
COPY --from=pruner /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN --mount=type=cache,id=agentbank-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ ./
RUN pnpm exec turbo run build --filter="@agentbank/${APP}"
# `pnpm deploy` writes APP plus production-only node_modules (workspace deps injected) to
# /out. Legacy mode works on pnpm 9-12 without requiring `injectWorkspacePackages`. Build
# output is copied explicitly because deploy honours `files`/.npmignore/.gitignore, which
# commonly exclude dist/ and .next/.
RUN --mount=type=cache,id=agentbank-pnpm-store,target=/pnpm/store \
    pnpm --filter "@agentbank/${APP}" --prod --config.force-legacy-deploy=true deploy /out \
 && for output in dist .next public; do \
      if [ -e "apps/${APP}/${output}" ]; then rm -rf "/out/${output}" && cp -a "apps/${APP}/${output}" "/out/${output}"; fi; \
    done \
 && rm -rf /out/.next/cache \
 && if [ ! -f /out/dist/index.js ] && [ ! -d /out/.next ]; then \
      echo "error: apps/${APP} produced neither dist/index.js nor .next/" >&2; exit 1; \
    fi

# -----------------------------------------------------------------------------------------
# 3. Runtime: distroless (no shell, no package manager), non-root uid 65532. Application
#    files are root-owned and read-only to the runtime user, which suits ECS
#    readonlyRootFilesystem (writable scratch paths are mounted as volumes).
FROM ${RUNTIME_IMAGE} AS runtime-base
ARG APP
ARG VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
ARG SOURCE_URL=https://github.com/agent-bank/agent-bank
LABEL org.opencontainers.image.title="agent-bank-${APP}" \
      org.opencontainers.image.description="Agent Bank ${APP} service. Base Sepolia (testnet) only." \
      org.opencontainers.image.vendor="Agent Bank" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.base.name="gcr.io/distroless/nodejs22-debian13:nonroot" \
      com.agentbank.app="${APP}"
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    HEALTHCHECK_PATH=/healthz
WORKDIR /app
COPY --from=builder --chown=0:0 /out/ /app/
# Health probe shared by Docker HEALTHCHECK and the ECS task definition (no shell or curl in
# distroless). Healthy = GET http://127.0.0.1:$PORT$HEALTHCHECK_PATH returns 2xx within 3s.
COPY --chown=0:0 --chmod=0444 <<'EOF' /usr/local/lib/agentbank/healthcheck.cjs
"use strict";
const http = require("node:http");
const port = Number(process.env.PORT || 8080);
const path = process.env.HEALTHCHECK_PATH || "/healthz";
const req = http.get({ host: "127.0.0.1", port, path, timeout: 3000 }, (res) => {
  res.resume();
  process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
});
req.on("timeout", () => req.destroy(new Error("timeout")));
req.on("error", () => process.exit(1));
EOF
USER 65532:65532
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/nodejs/bin/node", "/usr/local/lib/agentbank/healthcheck.cjs"]
# The distroless entrypoint is /nodejs/bin/node, so CMD is the script plus its arguments.

FROM runtime-base AS runtime-api
ENV PORT=8080
EXPOSE 8080
CMD ["dist/index.js"]

FROM runtime-base AS runtime-cosigner
ENV PORT=8081
EXPOSE 8081
CMD ["dist/index.js"]

FROM runtime-base AS runtime-indexer
ENV PORT=8082
EXPOSE 8082
CMD ["dist/index.js"]

FROM runtime-base AS runtime-facilitator
ENV PORT=8083
EXPOSE 8083
CMD ["dist/index.js"]

FROM runtime-base AS runtime-console
ENV PORT=3000 \
    HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["node_modules/next/dist/bin/next", "start"]

# Final image: the runtime stage named after APP.
FROM runtime-${APP}
