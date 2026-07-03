# Build context is the repository ROOT (see demo/compose.yaml: context: ..),
# so both the library source and this demo are available to COPY.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /repo

# 1. Build the library — produces dist/, which the demo links via `link:..`.
FROM base AS lib
COPY package.json pnpm-lock.yaml tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm install --frozen-lockfile
RUN pnpm build

# 2. Install + build the demo against the built library.
FROM base AS build
# Bring the library (with dist + node_modules) to the path the demo's
# `link:..` resolves to — one level up from /repo/demo.
COPY --from=lib /repo /repo
WORKDIR /repo/demo
COPY demo/package.json ./
RUN pnpm install --no-frozen-lockfile
COPY demo/ ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# 3. Runtime.
FROM base AS run
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=build /repo /repo
WORKDIR /repo/demo
EXPOSE 3000
CMD ["pnpm", "start"]
