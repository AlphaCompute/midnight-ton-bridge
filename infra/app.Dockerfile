# Bridge web app (app/server.ts). Build from the repository root:
#   docker build -f infra/app.Dockerfile --platform linux/arm64 .
FROM node:24-bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils unzip perl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
# Pinned Compact toolchain, npm ci and contract compilation, exactly as for a
# developer checkout. Proof keys are not needed: the app only reads the ledger.
RUN bash scripts/bootstrap.sh

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3080
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/tsconfig.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/app ./app
COPY --from=build --chown=node:node /app/docs ./docs
COPY --from=build --chown=node:node /app/build/midnight/contract ./build/midnight/contract
USER node
EXPOSE 3080
CMD ["node_modules/.bin/tsx", "app/server.ts"]
