FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./

ENV LITELLM_HOST=litellm
ENV LITELLM_PORT=4000
ENV CONFIG_PATH=/config/litellm_config.yaml
ENV PORT=4000

EXPOSE 4000

CMD ["node", "server.js"]
