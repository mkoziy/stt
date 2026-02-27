FROM oven/bun:1 AS base

# Install OS dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    build-essential \
    cmake \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Setup whisper.cpp
WORKDIR /app/whisper
RUN git clone https://github.com/ggerganov/whisper.cpp.git . && \
    make

# The compiled binary is usually named `main` or `whisper-cli` depending on the version.
# Let's map both to a common known alias
RUN cp ./build/bin/whisper-cli /usr/local/bin/whisper-cli || cp ./build/bin/main /usr/local/bin/whisper-cli || cp ./main /usr/local/bin/whisper-cli || cp ./whisper-cli /usr/local/bin/whisper-cli

# Download the model
RUN mkdir -p /models && \
    curl -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin -o /models/ggml-small.bin

# Setup the app
WORKDIR /app
COPY package.json ./
# Install deps without lockfile since we didn't generate one properly due to missing bun on host
RUN bun install

COPY . .

# No CMD — overridden by docker-compose command per service
