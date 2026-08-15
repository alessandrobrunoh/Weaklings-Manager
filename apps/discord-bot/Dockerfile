# syntax=docker/dockerfile:1

# Stage 1: Build TypeScript sources to JavaScript.
# Uses a slim Node image to keep the build layer small while still
# providing git/python-free compilation of `tsc`.
FROM node:22-slim AS builder
WORKDIR /app

# Install exact npm version pinned in package.json (`packageManager` field)
# to guarantee reproducible installs across CI and local environments.
RUN npm install -g npm@11.11.0

# Copy lockfile + manifest first to maximise Docker layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Copy only what is required to compile: TS config + sources.
COPY tsconfig.json ./
COPY src ./src

# Emit JavaScript to `dist/` (see tsconfig.json `outDir`).
RUN npm run build

# Prune the runtime dependency set so the next stage carries only
# production modules (no TypeScript compiler, no dev types).
RUN npm prune --omit=dev

# Stage 2: Minimal runtime image with only production deps + compiled output.
FROM node:22-slim AS runtime

# Run as a non-root user for defence-in-depth: limits blast radius if the
# process is ever compromised via a dependency vulnerability.
WORKDIR /app
RUN groupadd --system bot \
  && useradd --system --gid bot --create-home bot \
  && mkdir -p /app/data \
  && chown -R bot:bot /app/data

COPY --from=builder --chown=bot:bot /app/package.json ./package.json
COPY --from=builder --chown=bot:bot /app/node_modules ./node_modules
COPY --from=builder --chown=bot:bot /app/dist ./dist

USER bot

# Keep poller checkpoints under the image-owned writable directory even when
# the container is launched without the repository Compose environment block.
ENV POLLER_STATE_DIR=/app/data

# Discord bot is a long-running polling process; no inbound port needed.
CMD ["node", "dist/index.js"]
