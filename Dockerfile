FROM node:24-alpine AS builder

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

FROM node:24-alpine

ARG COPA_VERSION=0.14.1
ARG TARGETARCH=amd64
# sha256 of copa_${COPA_VERSION}_linux_${TARGETARCH}.tar.gz, taken from
# copacetic_checksums.txt on the GitHub release. The default matches
# linux_amd64; update it together with COPA_VERSION (and for other arches).
ARG COPA_SHA256=a780f62c054f60cd1aecbbf4a4b2665a816aa852534e6b0b9592cf96a327fdc9

RUN apk add --no-cache wget tar docker-cli \
  && wget -qO /tmp/copa.tar.gz \
  "https://github.com/project-copacetic/copacetic/releases/download/v${COPA_VERSION}/copa_${COPA_VERSION}_linux_${TARGETARCH}.tar.gz" \
  && echo "${COPA_SHA256}  /tmp/copa.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/copa.tar.gz -C /usr/local/bin copa \
  && chmod +x /usr/local/bin/copa \
  && rm /tmp/copa.tar.gz

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

RUN chown -R node:node /app

# Non-root; Docker socket access comes from `group_add` in docker-compose.yml
USER node

VOLUME /data

EXPOSE 5432

CMD ["node", "dist/index.js"]
