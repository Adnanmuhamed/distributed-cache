# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — builder
#
# Installs ALL dependencies (including devDependencies needed for tsc) and
# compiles TypeScript to dist/.  The compiled output is then copied into the
# lean production image so devDependencies never reach the final layer.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

# Create app directory
WORKDIR /app

# Copy manifests first — maximises layer-cache hits when only src changes.
COPY package.json package-lock.json ./

# Install ALL deps (dev + prod) for the build step.
# --frozen-lockfile keeps the build hermetic.
RUN npm ci --frozen-lockfile

# Copy source and compiler config.
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript → dist/
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — production runtime
#
# Starts from the same base to avoid OS-version skew, but installs only the
# production subset of packages.  The compiled JS is copied from the builder.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS production

# Install curl for Docker health-check probes.
# dumb-init gives proper PID-1 signal forwarding (SIGTERM → child process).
RUN apk add --no-cache curl dumb-init

WORKDIR /app

# Copy manifests
COPY package.json package-lock.json ./

# Install production dependencies only.
RUN npm ci --frozen-lockfile --omit=dev

# Copy compiled JavaScript from the builder stage.
COPY --from=builder /app/dist ./dist

# ── Security: run as a non-root user ─────────────────────────────────────────
# node:22-alpine ships with a built-in "node" user (uid 1000).
RUN chown -R node:node /app
USER node

# ── Runtime metadata ──────────────────────────────────────────────────────────
EXPOSE 3000

# The CMD is overridden per-service in docker-compose.yml using
# "npm run start:node" or "npm run start:gateway".
# dumb-init wraps node to guarantee SIGTERM is delivered correctly.
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "run", "start:gateway"]
