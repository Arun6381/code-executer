FROM node:20-slim

ENV DEBIAN_FRONTEND=noninteractive

# Install C, C++, Python, Java on top of the node:20 base image
# This avoids Node.js version conflicts entirely
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    python3 \
    default-jdk \
    && rm -rf /var/lib/apt/lists/*

# Create temp dir for code execution
RUN mkdir -p /tmp/code-runner && chmod 777 /tmp/code-runner

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY server.js ./

EXPOSE 3001

CMD ["node", "server.js"]
