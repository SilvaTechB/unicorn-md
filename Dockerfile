FROM node:20

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install --legacy-peer-deps --production

COPY . .

EXPOSE 3000

CMD ["node", "unicorn-md.js"]
