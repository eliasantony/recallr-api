# Dockerfile
FROM node:20-alpine

# ffmpeg + curl + yt-dlp (Alpine package pulls python3 automatically)
RUN apk add --no-cache ffmpeg curl yt-dlp

# app files
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/server.mjs"]