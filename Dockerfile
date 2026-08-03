FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Asia/Kolkata

# Install all language runtimes in one layer
RUN apt-get update && apt-get install -y \
    # C / C++
    gcc g++ \
    # Python
    python3 python3-pip \
    # Java
    default-jdk \
    # Node.js
    nodejs npm \
    # Utilities
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 (replace default)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Create temp dir
RUN mkdir -p /tmp/code-runner && chmod 777 /tmp/code-runner

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY server.js ./

EXPOSE 3001

CMD ["node", "server.js"]
