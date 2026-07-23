FROM oven/bun:latest

WORKDIR /app

# Copy package files and install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Expose GUI port
EXPOSE 3000

# Default command — start GUI server
CMD ["bun", "run", "gui"]
