# syntax=docker/dockerfile:1.7
# Agent binaries for x64 and arm64 Linux:
#   docker build --output type=local,dest=dist agent
ARG BUN_VERSION=1.3.14

FROM oven/bun:${BUN_VERSION}-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src src
RUN bun build src/index.ts --compile --minify --target=bun-linux-x64 --outfile /out/system-monitor-agent-linux-x64 \
 && bun build src/index.ts --compile --minify --target=bun-linux-arm64 --outfile /out/system-monitor-agent-linux-arm64

FROM scratch AS agent-binaries
COPY --from=build /out/ /
