# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim
# Tools Claude commonly shells out to. Add more (python3, build-essential, ...) if your tasks need them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep curl ca-certificates jq less procps \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8787 \
    WORKSPACE_DIR=/workspace \
    HOME=/home/node

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Non-root user "node" (uid 1000) ships with the base image.
RUN mkdir -p /workspace /home/node/.claude && chown -R node:node /workspace /home/node
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD curl -fsS http://127.0.0.1:8787/health || exit 1
CMD ["node", "dist/server.js"]
