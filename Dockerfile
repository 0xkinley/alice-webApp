# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build

WORKDIR /app

ADD --checksum=sha256:56a0cae044b6cc433971d964347401692a92ea0294e392753a3ebdaee54d8b84 \
  https://truststore.pki.rds.amazonaws.com/eu-central-1/eu-central-1-bundle.pem \
  ./certs/eu-central-1-bundle.pem

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts/migrate-postgres.mjs scripts/migrate-postgres-container.mjs ./scripts/

RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim AS runtime

# Lambda Web Adapter is inert outside AWS Lambda, so the same immutable image
# remains usable for ordinary local containers and the ECS fallback.
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.0.1@sha256:1e5ab4d9242167500ed8a7bed8a79b448228aaa51cf382fb51fe4bf8a5f9a811 /lambda-adapter /opt/extensions/lambda-adapter

ENV HOST=0.0.0.0
ENV NODE_ENV=production
ENV NODE_EXTRA_CA_CERTS=/app/certs/eu-central-1-bundle.pem

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node --chmod=0644 /app/certs/eu-central-1-bundle.pem ./certs/eu-central-1-bundle.pem
RUN chmod 0755 ./certs && chmod 0644 ./certs/eu-central-1-bundle.pem
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/scripts ./scripts

USER node
STOPSIGNAL SIGTERM

# The web runtime overrides this with `npm run start:web`; MCP uses the image
# default. Both runtimes inject their own PORT.
CMD ["npm", "run", "start:mcp"]
