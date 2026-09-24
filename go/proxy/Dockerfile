FROM node:24-alpine
WORKDIR /app
COPY server.mjs versions.json ./
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
