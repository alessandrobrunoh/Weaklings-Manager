# syntax=docker/dockerfile:1

# Stage 1: Build the Angular 21 application with SSR output.
# Produces `dist/frontend/browser` (static assets) and
# `dist/frontend/server/server.mjs` (Express SSR entrypoint).
FROM node:22-slim AS builder
WORKDIR /app

# Match the npm version pinned via `packageManager` in package.json
# to keep CI/local build outputs identical.
RUN npm install -g npm@11.11.0

# Layer-cache: copy manifests first so `npm ci` is only invalidated
# when package-lock.json actually changes.
COPY package.json package-lock.json ./
RUN npm ci

# Angular build needs the entire project sources (templates, styles, assets).
COPY . .

# Production build (defaultConfiguration = production in angular.json).
RUN npm run build

# Stage 2: Minimal Node runtime serving the SSR Express server.
FROM node:22-slim AS runtime

WORKDIR /app

# SSR still requires express + @angular/* at runtime, so we install
# only production dependencies (no dev tooling like tailwind/postcss).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Bring in the compiled bundles from the builder stage.
COPY --from=builder /app/dist ./dist

# Angular SSR Express server listens on $PORT (defaults to 4000).
ENV PORT=3000
EXPOSE 3000

# `serve:ssr:frontend` resolves to: node dist/frontend/server/server.mjs
CMD ["node", "dist/frontend/server/server.mjs"]
