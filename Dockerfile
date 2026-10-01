FROM oven/bun:1.4.2
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
RUN bunx playwright install --with-deps chromium
COPY . .
ENV HEADLESS_BROWSER=1 CC_OUTPUT_DIR=/app/output
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD bun -e 'const r=await fetch("http://127.0.0.1:3000/api/health",{signal:AbortSignal.timeout(3000)});if(!r.ok)process.exit(1)'
CMD ["bun", "run", "gui"]
