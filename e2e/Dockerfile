# Inline e2e runner: starts backend + frontend inside this container and
# runs Playwright against them. Lightnet and Postgres live in sibling
# containers on the same compose network (see preview-env/docker-compose.e2e.yml).
#
# Base: the Playwright image ships with chromium + all system deps preinstalled.
# Bun is layered on top because the repo is a bun workspace.
FROM mcr.microsoft.com/playwright:v1.50.0-jammy

# curl — used by the entrypoint to poll backend/frontend health
# lsof — global-setup's clearPorts() helper invokes it
# unzip — required by the bun.sh/install script in the next step
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl lsof ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*

# Install bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

WORKDIR /app

# Layer the workspace install so bun install is cached when only sources change.
COPY package.json bun.lock ./
COPY contracts/package.json contracts/
COPY backend/package.json backend/
COPY ui/package.json ui/
COPY ui/deps/ ui/deps/
COPY dev-helpers/package.json dev-helpers/
COPY e2e/package.json e2e/

RUN bun install

# The playwright base image ships browsers for its own version tag, but bun
# installs whatever `^` range e2e/package.json resolves to — which drifts ahead
# of the image. Re-install chromium here so it always matches the locked
# Playwright version. All system deps are already in the base image.
RUN cd e2e && bunx playwright install chromium

# Now the rest of the repo — e2e/ is intentionally COPY-last so test-source
# iterations don't invalidate the contracts-build + prisma-generate cache.
COPY contracts/ contracts/
COPY backend/ backend/
COPY ui/ ui/
COPY dev-helpers/ dev-helpers/

# Contracts is a workspace dep for backend, ui, and e2e — build once here.
RUN cd contracts && bun run build

# Compile contract circuit and extract verification key hash
RUN bun run dev-helpers/cli.ts vk-hash compile 2>&1 | awk '/^vkHash:/{print $2}' > /app/.vk-hash

# Production build of the frontend. `next start` serves the pre-built bundle,
# which starts ~30× faster than `next dev` and matches how real users hit the
# app. NEXT_PUBLIC_* are inlined into the browser bundle at build time;
# runtime env vars don't affect client code.
ENV NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
ENV NEXT_PUBLIC_MINA_ENDPOINT=http://lightnet:8080/graphql
ENV NEXT_PUBLIC_ARCHIVE_ENDPOINT=http://lightnet:8282
ENV NEXT_PUBLIC_E2E_TEST=true
ENV NEXT_PUBLIC_POLL_INTERVAL_MS=3000
RUN cd ui && bun run build

# Prisma client must be generated in-image; `bun run --filter backend dev`
# shells into `db:push` which expects the client to exist.
RUN cd backend && bunx prisma generate

# Chromium calculates IDB quota from the partition hosting its profile dir.
# Default /tmp is often a small tmpfs — point it to the working directory.
ENV TMPDIR=/app/.tmp
RUN mkdir -p /app/.tmp

COPY e2e/ e2e/

ENTRYPOINT ["/app/e2e/entrypoint.sh"]
