# Ad-generation microservice.
#
# One image, three roles selected by ADGEN_ROLE (api | orchestrator | renderer).
# Same image ships to all three Render services in render.yaml.
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

# api role listens on PORT; orchestrator/renderer are workers with no port.
EXPOSE 3100

CMD ["node", "src/entrypoint.js"]
