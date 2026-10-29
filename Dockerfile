# syntax=docker/dockerfile:1.7
# Targets: app (API/worker/migrations), dashboard (static files for the host's Nginx), agent-binaries.
ARG BUN_VERSION=1.3.14

FROM oven/bun:${BUN_VERSION}-alpine AS manifests
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/agent/package.json apps/agent/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/config/package.json packages/config/
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/

FROM manifests AS deps-prod
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM manifests AS deps-all
RUN bun install --frozen-lockfile --ignore-scripts

# ---------------------------------------------------------------- dashboard build
FROM deps-all AS dashboard-build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/dashboard apps/dashboard
RUN bun run --cwd apps/dashboard build

# ---------------------------------------------------------------- agent binaries
FROM deps-all AS agent-build
COPY tsconfig.base.json ./
COPY packages/config packages/config
COPY packages/shared packages/shared
COPY apps/agent apps/agent
RUN bun build apps/agent/src/index.ts --compile --minify --target=bun-linux-x64 --outfile /out/system-monitor-agent-linux-x64 \
 && bun build apps/agent/src/index.ts --compile --minify --target=bun-linux-arm64 --outfile /out/system-monitor-agent-linux-arm64

FROM scratch AS agent-binaries
COPY --from=agent-build /out/ /

# ---------------------------------------------------------------- runtime (API + worker + migrate)
FROM deps-prod AS app
ENV NODE_ENV=production
COPY packages packages
COPY apps/api apps/api
COPY apps/worker apps/worker
COPY scripts scripts
# Source is owned by root and read-only for the runtime user.
RUN chmod -R a-w /app
USER bun
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["bun", "apps/api/src/index.ts"]

# ---------------------------------------------------------------- static dashboard export
# docker build --target dashboard --output type=local,dest=./public .
FROM scratch AS dashboard
COPY --from=dashboard-build /app/apps/dashboard/dist/ /
