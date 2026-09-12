FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.mjs ./

ENV HOST=0.0.0.0
ENV PORT=3777
ENV ALLOWED_HOSTS=127.0.0.1,localhost,obsidian-mcp
ENV OBSIDIAN_BACKEND=filesystem
ENV OBSIDIAN_VAULT_ROOT=/vault

USER node
EXPOSE 3777
CMD ["node", "server-http.mjs"]
