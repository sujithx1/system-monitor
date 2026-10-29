# syntax=docker/dockerfile:1.7
# Runtime image for the API, the worker and the migration step (see docker-compose.yml).
ARG BUN_VERSION=1.3.14

FROM oven/bun:${BUN_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM deps AS app
ENV NODE_ENV=production
COPY src src
COPY migrations migrations
COPY scripts scripts
# Source is owned by root and read-only for the runtime user.
RUN chmod -R a-w /app
USER bun
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["bun", "src/api/index.ts"]
