# Ad-generation microservice.
#
# One image, four roles selected by ADGEN_ROLE (api | orchestrator | renderer | titler).
# Same image ships to all four Render services in render.yaml.
#
# Node 20 for parity with backend + Remotion 4.x requirements. Phase 1 adds
# Remotion + its Chrome/ffmpeg deps to the renderer image; Phase 0 stays lean.

FROM node:20-slim

# Native runtime deps:
# - Chrome/Puppeteer needs an X11-less font/render stack: libnss3, libatk*,
#   libcups2, libdrm2, libgbm1, libasound2, ca-certificates, fonts-liberation.
# - Remotion's headless render + ffmpeg-static ships its own ffmpeg binary
#   but needs the shared libs for the Chrome side of the render.
# - sharp uses a prebuilt libvips binary on x64 linux; no apt package needed
#   beyond glibc which is in node:20-slim.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-liberation \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libx11-xcb1 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxrandr2 \
      libxrender1 \
      libxss1 \
      libxtst6 \
      wget \
      xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better layer caching). --omit=dev skips eslint etc.
# Puppeteer's postinstall downloads Chrome (~150MB). Remotion's postinstall
# is a no-op — its renderer downloads headless-shell on first use.
COPY package*.json ./
RUN npm install --omit=dev

# Copy everything the app needs at runtime: source + committed non-secret
# defaults + Remotion compositions. config/defaults.env is loaded by
# src/config.js on boot.
COPY src/ ./src/
COPY config/ ./config/
COPY scripts/ ./scripts/

# Pre-bundle Remotion at BUILD time so runtime children skip the ~5-15s
# webpack step per render. Output lands at /app/.remotion-bundle;
# remotionRenderService.getServeUrl() detects and uses it. Absent this
# step the runtime falls back to on-the-fly bundling (existing behaviour),
# so the change is purely additive.
RUN node scripts/prebuildRemotionBundle.js

# Pre-warm @remotion/renderer's chrome-headless-shell at BUILD time — see
# scripts/ensureRemotionBrowser.js's header for the full incident writeup.
# Without this, resolveBrowserExecutable() returns null and EVERY spawned
# render child independently calls @remotion/renderer's ensureBrowser() at
# runtime; ensureBrowser()'s only serialization is per-process, so N sibling
# children racing the same shared cache path is exactly what produced
# adgen-titler's 2026-08-26 ETXTBSY/ENOENT/ENOTEMPTY "No browser found"
# incident. Baking it here means every runtime child instead resolves the
# browser via REMOTION_BROWSER_EXECUTABLE below on its very first check
# (remotionRenderService.js:96) and NEVER calls ensureBrowser() at all — the
# race is structurally unreachable, not just less likely.
#
# The path is HARDCODED here (not read from the script's own
# .remotion-browser-path hint file) so any drift between what the script
# actually verified and what this image ships FAILS THE BUILD instead of
# silently shipping a wrong path — scripts/verifyRemotionBrowserPrewarm.js
# Group C pins that this literal matches ensureRemotionBrowser.js's own
# derivation formula.
RUN node scripts/ensureRemotionBrowser.js
ENV REMOTION_BROWSER_EXECUTABLE=/app/node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell

# api role listens on PORT; orchestrator/renderer are workers with no port.
EXPOSE 3100

CMD ["node", "src/entrypoint.js"]
