FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 GEV_STATE_DIR=/app/state
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8080
CMD ["node", "host/start.mjs"]
