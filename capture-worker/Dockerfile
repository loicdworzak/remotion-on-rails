# Playwright's official image is just used here as a convenient base: it
# ships Chromium + every system dependency it needs (fonts, libs, etc.).
# We do NOT use the `playwright` npm package anymore — we only reuse the
# Chromium binary baked into this image via raw CDP (chrome-launcher +
# chrome-remote-interface). Match the tag to the Chromium build you want.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

# We don't want npm trying to download a browser for a `playwright` package
# (we don't even depend on it anymore, but this is harmless to keep as a
# safety net in case it's still listed as a transitive/dev dependency).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

# ── Locate the Chromium binary baked into this base image ──────────────────
# The exact path is version-specific and not predictable from the image tag
# alone (e.g. /ms-playwright/chromium-1187/chrome-linux/chrome — the number
# changes per Playwright internal build, not per our tag). We resolve it once
# at BUILD time here, fail loudly if not found, and bake the resolved path
# into an env var — no guessing, no runtime `find` needed, no risk of picking
# the wrong binary if multiple browsers are present in the image.
RUN CHROME_BIN="$(find /ms-playwright -type f -iname 'chrome' -path '*chrome-linux*' | head -n 1)" && \
    if [ -z "$CHROME_BIN" ]; then \
        echo "ERROR: no Chromium binary found under /ms-playwright" >&2; \
        find /ms-playwright -maxdepth 3 >&2; \
        exit 1; \
    fi && \
    echo "Resolved Chromium binary: $CHROME_BIN" && \
    echo "CHROME_PATH=$CHROME_BIN" >> /etc/environment

# Make it available to the actual running process too (ENV is baked at build
# time, but we need the value computed in the RUN step above — so we re-read
# it via a tiny wrapper script rather than a static ENV line).
RUN find /ms-playwright -type f -iname 'chrome' -path '*chrome-linux*' | head -n 1 > /app/.chrome-path

ENV PORT=8080
EXPOSE 8080

# Read the resolved path at container start and export it before launching
# node — this is the one place we still need a shell, everything else above
# is resolved once at build time so startup stays fast and deterministic.
CMD ["sh", "-c", "export CHROME_PATH=$(cat /app/.chrome-path) && echo \"Using Chromium at: $CHROME_PATH\" && exec node server.js"]
