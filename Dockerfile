# Ad-generation microservice.
#
# One image, three roles selected by ADGEN_ROLE (api | orchestrator | renderer).
# Same image ships to all three Render services in render.yaml.
#
# Node 20 for parity with backend + Remotion 4.x requirements. Phase 1 adds
# Remotion + its Chrome/ffmpeg deps to the renderer image; Phase 0 stays lean.

FROM node:20-slim

# Native runtime deps for sharp (libvips). node:20-slim is debian-based;
# sharp normally ships a prebuilt libvips binary and works out of the box
# on x64 linux, but the runtime dynamic deps (libc, libstdc++) are already
# in slim. If you see "sharp missing" errors on Render, uncomment the
# apt-get block below to install libvips explicitly.
# RUN apt-get update && apt-get install -y --no-install-recommends \
#       libvips-dev ca-certificates \
#     && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better layer caching). --omit=dev skips eslint etc.
COPY package*.json ./
RUN npm install --omit=dev

# Copy everything the app needs at runtime: source + committed non-secret
# defaults. config/defaults.env is loaded by src/config.js on boot.
COPY src/ ./src/
COPY config/ ./config/

# api role listens on PORT; orchestrator/renderer are workers with no port.
EXPOSE 3100

CMD ["node", "src/entrypoint.js"]
