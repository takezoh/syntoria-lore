FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY Dockerfile .dockerignore .gcloudignore ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tests ./tests
COPY infra ./infra
COPY docs/eval/cloud-oauth.md ./docs/eval/cloud-oauth.md
COPY docs/api/openapi.json ./docs/api/openapi.json
COPY tsconfig.json tsconfig.base.json tsconfig.test.json vitest.config.ts eslint.config.mjs .prettierrc.json .prettierignore ./
RUN npm ci
RUN find . -type f -name '*.tsbuildinfo' -delete && npm run build

FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS runtime
ENV NODE_ENV=production
WORKDIR /workspace
RUN mkdir -p /var/memory-service /var/memory-service-issuer \
  && chown -R node:node /var/memory-service /var/memory-service-issuer /workspace
COPY --from=build --chown=node:node /workspace /workspace
USER node
EXPOSE 8080 8081 9090 9091 9092
CMD ["node", "apps/api/dist/main.js"]
