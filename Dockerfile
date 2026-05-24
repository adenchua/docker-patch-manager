FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine

ARG COPA_VERSION=0.14.1
ARG TARGETARCH=amd64

RUN apk add --no-cache wget tar docker-cli \
  && wget -qO /tmp/copa.tar.gz \
  "https://github.com/project-copacetic/copacetic/releases/download/v${COPA_VERSION}/copa_${COPA_VERSION}_linux_${TARGETARCH}.tar.gz" \
  && tar -xzf /tmp/copa.tar.gz -C /usr/local/bin copa \
  && chmod +x /usr/local/bin/copa \
  && rm /tmp/copa.tar.gz

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

VOLUME /data

EXPOSE 5432

CMD ["node", "dist/index.js"]
