# ScanWise API — production Dockerfile
# Multi-stage build to keep the final image small.

# ---- Build stage ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# better-sqlite3 needs a C++ toolchain to build the native binding.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

# ---- Runtime stage ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# Copy built node_modules and the seed data
COPY --from=builder /app/node_modules ./node_modules
COPY server.js ./
COPY package.json ./
# Seed data is one level up, in /home/team/shared/data at dev time.
# In the deployed image, copy the seed into the image so the DB is
# initialised on first boot.
COPY ../data/seed-data.json ./seed-data.json

ENV PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/data/scanwise.db

# Persist the SQLite DB across restarts by mounting a volume here.
VOLUME ["/data"]

EXPOSE 3000

# Health check — pings /api/health every 30s
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+process.env.PORT+'/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1));"

CMD ["node", "server.js"]
