FROM node:20-alpine
WORKDIR /app

# Copy the lockfile too, and install from it: npm ci gives a reproducible tree,
# where `npm install` silently drifts as transitive versions move.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 5000

# Was `npm run dev`, which runs nodemon -- a file watcher has no business
# supervising a production container.
CMD ["npm", "start"]
