# syntax=docker/dockerfile:1
FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine AS mcp-build
WORKDIR /app/mcp
COPY mcp/package*.json ./
RUN npm install
COPY mcp/ ./
RUN npm run bundle

FROM node:22-alpine AS backend-build
# toolchain for better-sqlite3 when no prebuilt binary matches (musl)
RUN apk add --no-cache python3 make g++
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3030 \
    DB_PATH=/data/pjplanner.db \
    STATIC_DIR=/app/frontend/dist \
    MCP_BUNDLE=/app/mcp/pjplanner-mcp.mjs \
    MCP_SKILLS=/app/mcp/skills
WORKDIR /app/backend
COPY --from=backend-build /app/backend/package*.json ./
COPY --from=backend-build /app/backend/node_modules ./node_modules
COPY --from=backend-build /app/backend/dist ./dist
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist
COPY --from=mcp-build /app/mcp/dist/pjplanner-mcp.mjs /app/mcp/pjplanner-mcp.mjs
COPY mcp/skills /app/mcp/skills
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3030
CMD ["node", "dist/index.js"]
