FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY tsconfig.json ./
# Os dados ficam em /app/data: monte um volume persistente nesse caminho
EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
