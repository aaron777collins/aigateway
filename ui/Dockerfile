FROM node:20-alpine

# Install docker CLI so the server can restart the litellm container.
# We only need the CLI binary, not the daemon.
RUN apk add --no-cache docker-cli

WORKDIR /app

# Copy dependency manifests first so Docker layer caching skips npm install
# on subsequent builds when only source files changed.
COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public/   ./public/

# The config file is bind-mounted at runtime (see docker-compose.yml).
ENV CONFIG_PATH=/config/litellm_config.yaml
ENV LITELLM_URL=http://litellm:4000
ENV LITELLM_CONTAINER=aigateway-litellm
ENV PORT=4002

EXPOSE 4002

CMD ["node", "server.js"]
