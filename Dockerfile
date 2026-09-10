# ── Stage 1: Build ────────────────────────────────────────────────────────────
# Install ALL dependencies (including devDeps) and compile TypeScript to JS.
# This stage is discarded after dist/ is extracted -- it never ships.
FROM node:22-alpine AS builder
WORKDIR /app

# Copy manifests first so Docker layer-caches the npm ci step separately
# from source changes. Rebuilds only re-run npm ci when package*.json changes.
COPY package*.json ./
RUN npm ci

# Copy source and tsconfig, then compile.
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
# A lean image containing ONLY compiled JS and production dependencies.
# No TypeScript source, no devDependencies, no test files, no ts-node.
FROM node:22-alpine AS runtime
WORKDIR /app

# Create a dedicated non-root user before any file is copied.
#
# Why non-root?  Two reasons worth knowing for an interview:
#   1. Blast-radius containment: if an attacker exploits the Node process and
#      escapes the container, a root container grants host-root access to the
#      kernel surface.  A non-root user limits what they can do even if they
#      escape.
#   2. Compliance: GKE, ECS, and most enterprise Kubernetes policies enforce
#      runAsNonRoot by default.  Building the habit here costs nothing.
RUN addgroup -S vulcan \
 && adduser  -S -G vulcan -u 1001 vulcan

# Install ONLY production deps.  npm ci --omit=dev skips the entire devDeps
# tree (typescript, ts-node, jest, ts-jest, @types/*) -- typically halves
# the image size versus a naive COPY node_modules approach.
COPY package*.json ./
RUN npm ci --omit=dev \
 && chown -R vulcan:vulcan /app

# Copy compiled output from builder -- nothing else.
COPY --from=builder --chown=vulcan:vulcan /app/dist ./dist

# All subsequent RUN / CMD instructions run as this user.
USER vulcan

# Default port; overridden per-container by the PORT env var in docker-compose.
# EXPOSE is metadata only -- the actual port is configured via PORT and mapped
# in docker-compose.yml.
ENV PORT=5001
EXPOSE 5001

# Invoke node directly (not via npm run) so the process receives SIGTERM
# from Docker stop without an intermediate shell that would swallow it.
# The existing graceful-shutdown handler in node.ts handles SIGTERM correctly.
CMD ["node", "dist/server/node.js"]
