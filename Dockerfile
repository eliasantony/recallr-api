# Dockerfile
FROM node:20-alpine

# ffmpeg + yt-dlp + python (yt-dlp dependency path)
RUN apk add --no-cache ffmpeg curl python3 py3-pip && \
    pip3 install --no-cache-dir yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY .env ./.env

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/server.mjs"]