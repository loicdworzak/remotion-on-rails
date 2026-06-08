# Playwright's official image ships Chromium + every system dependency it needs.
# Match the tag to the playwright version in package.json.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
