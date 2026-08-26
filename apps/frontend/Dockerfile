# syntax=docker/dockerfile:1

# Stage 1: Build the Analog (Angular + Vite) application with SSR output.
# Produces `dist/analog/public` (static assets) and
# `dist/analog/server/index.mjs` (Nitro SSR entrypoint).
FROM node:22-slim AS builder
WORKDIR /app

# Match the npm version pinned via `packageManager` in package.json
# to keep CI/local build outputs identical.
RUN npm install -g npm@11.11.0

# Layer-cache: copy manifests first so the install is only invalidated
# when package-lock.json actually changes.
COPY package.json package-lock.json ./
# `--legacy-peer-deps` is required: @analogjs/platform declares optional peer
# dependencies on the Nx toolchain, which this project does not use, and npm
# would otherwise try to resolve them and fail on an unrelated conflict.
RUN npm ci --legacy-peer-deps

# The build needs the whole project: templates, styles, assets, server routes.
COPY . .

RUN npm run build

# Stage 2: Minimal Node runtime serving the Nitro server.
# The Nitro output bundles its dependencies, so no install is needed here.
FROM node:22-slim AS runtime
WORKDIR /app

COPY --from=builder /app/dist/analog ./dist/analog

ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/analog/server/index.mjs"]
