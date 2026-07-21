FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

RUN apk add --no-cache wget

COPY . .

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget --spider http://localhost:8080 || exit 1


CMD ["npm","run","dev","--","--host","0.0.0.0"]