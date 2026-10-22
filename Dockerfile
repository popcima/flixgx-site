FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY assets ./assets
COPY *.html data.json noirx-supabase.js ./
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8788
EXPOSE 8788
CMD ["node", "server/index.js"]
