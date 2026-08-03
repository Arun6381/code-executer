FROM node:20-slim

# Install Docker CLI (to spawn sibling containers)
RUN apt-get update && apt-get install -y \
    docker.io \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY server.js ./

# Temp dir for sandboxes
RUN mkdir -p /tmp/code-runner

EXPOSE 3001

CMD ["node", "server.js"]
