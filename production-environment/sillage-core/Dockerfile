FROM oven/bun:1-alpine

# supercronic runs the sync schedule as a non-root, log-to-stdout cron. Ordinary crond in a
# container swallows output and insists on running as root.
ARG SUPERCRONIC_VERSION=v0.2.33
RUN apk add --no-cache curl tzdata ca-certificates \
 && ARCH="$(uname -m)" \
 && case "$ARCH" in \
      x86_64)  SC_ARCH=amd64 ;; \
      aarch64) SC_ARCH=arm64 ;; \
      *) echo "unsupported arch $ARCH" && exit 1 ;; \
    esac \
 && curl -fsSLo /usr/local/bin/supercronic \
      "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${SC_ARCH}" \
 && chmod +x /usr/local/bin/supercronic

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

COPY . .

RUN if [ -f web/vite.config.ts ]; then bun run web:build; fi

ENV NODE_ENV=production \
    PORT=4000 \
    TZ=UTC

EXPOSE 4000

# One image, two roles. The default is the scheduler; the dashboard service overrides `command`.
# Keeping them as separate containers means a long sync cannot stall the API, and either can be
# restarted alone.
#
# The absolute path is required, not stylistic: as PID 1 supercronic re-execs itself to install a
# process reaper, and it does that with argv[0] and no PATH lookup. A bare "supercronic" makes it
# exit immediately with "Failed to fork exec".
CMD ["/usr/local/bin/supercronic", "-passthrough-logs", "/app/crontab"]
