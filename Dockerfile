FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim AS runtime

ENV HOST=0.0.0.0
ENV NODE_ENV=production

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/packages ./packages

USER node
STOPSIGNAL SIGTERM

# Railway overrides this with `npm run start:web` for the web service. The MCP
# service uses the image default. Both services receive Railway's injected PORT.
CMD ["npm", "run", "start:mcp"]
