FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1
COPY . .
# preinstall validates the complete checkout before it can install dependencies.
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 GEV_STATE_DIR=/app/state
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8080
CMD ["node", "host/start.mjs"]
