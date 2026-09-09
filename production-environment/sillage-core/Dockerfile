# Sillage engine — API, scheduler and CLIs in one image.
#
# Three stages so the shipped layer carries only what runs. The dashboard's build chain (vite,
# react, tailwind, typescript) is ~185 MB of devDependencies used for about three seconds and
# never again; the engine itself needs four runtime packages. Building in a throwaway stage and
# copying out `web/dist` keeps that toolchain out of the pushed image.

# --- supercronic --------------------------------------------------------------------------------
# supercronic runs the sync schedule as a non-root, log-to-stdout cron. Ordinary crond in a
# container swallows output and insists on running as root. Fetched in its own stage so curl and
# its certificate chain never reach the runtime layer.
FROM alpine:3.21 AS supercronic
ARG SUPERCRONIC_VERSION=v0.2.33
RUN apk add --no-cache curl \
 && ARCH="$(uname -m)" \
 && case "$ARCH" in \
      x86_64)  SC_ARCH=amd64 ;; \
      aarch64) SC_ARCH=arm64 ;; \
      *) echo "unsupported arch $ARCH" && exit 1 ;; \
    esac \
 && curl -fsSLo /supercronic \
      "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${SC_ARCH}" \
 && chmod +x /supercronic

# --- dashboard build ----------------------------------------------------------------------------
FROM oven/bun:1-alpine AS web
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run web:build

# --- runtime ------------------------------------------------------------------------------------
FROM oven/bun:1-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache tzdata
COPY --from=supercronic /supercronic /usr/local/bin/supercronic

# --production resolves the same lockfile without the dashboard toolchain: hono, mysql2,
# fast-xml-parser, php-serialize.
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json crontab ./
COPY src ./src
COPY migrations ./migrations
COPY data ./data
COPY --from=web /app/web/dist ./web/dist

# Which commit built this. `ship.sh` reads the label instead of starting a container to diff the
# source tree, so a stale tag is caught before anything is deployed.
ARG SOURCE_SHA=unknown
LABEL org.opencontainers.image.revision="${SOURCE_SHA}"
LABEL org.opencontainers.image.source="https://github.com/unseencurtain/sillage-b2b"

ENV NODE_ENV=production \
    PORT=4000 \
    TZ=UTC \
    SILLAGE_SOURCE_SHA=${SOURCE_SHA}

EXPOSE 4000

# One image, two roles. The default is the scheduler; the dashboard service overrides `command`.
# Keeping them as separate containers means a long sync cannot stall the API, and either can be
# restarted alone.
#
# The absolute path is required, not stylistic: as PID 1 supercronic re-execs itself to install a
# process reaper, and it does that with argv[0] and no PATH lookup. A bare "supercronic" makes it
# exit immediately with "Failed to fork exec".
CMD ["/usr/local/bin/supercronic", "-passthrough-logs", "/app/crontab"]
