# syntax=docker/dockerfile:1.7
# Static dashboard export for the host's Nginx:
#   docker build --output type=local,dest=/var/www/system-monitor frontend
ARG BUN_VERSION=1.3.14

FROM oven/bun:${BUN_VERSION}-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src src
RUN bun run build

FROM scratch AS dashboard
COPY --from=build /app/dist/ /
