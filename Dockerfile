# syntax=docker/dockerfile:1

# Self-hosting is not optional for this project: you are asking operators for an
# admin-scoped API key, so running it entirely on their own infrastructure has
# to be a first-class path rather than an afterthought.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 builds a native addon; the toolchain is confined to this stage.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
# Never run the dashboard as root: it holds decryptable credentials at rest.
RUN useradd --system --uid 10001 --create-home soif
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY package.json factors.json next.config.ts drizzle.config.ts ./
COPY drizzle ./drizzle
COPY scripts ./scripts
COPY cli ./cli
COPY src ./src
COPY tsconfig.json ./
RUN mkdir -p /app/data && chown -R soif:soif /app/data
USER soif
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "run", "start"]
