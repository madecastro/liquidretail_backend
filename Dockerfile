# Ad-generation microservice.
#
# One image, three roles selected by ADGEN_ROLE (api | orchestrator | renderer).
# Same image ships to all three Render services in render.yaml.
#
# Node 20 for parity with backend + Remotion 4.x requirements. Phase 1 adds
# Remotion + its Chrome/ffmpeg deps to the renderer image; Phase 0 stays lean.

FROM node:20-slim

WORKDIR /app

# Install deps first (better layer caching).
COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/

# api role listens on PORT; orchestrator/renderer are workers with no port.
# EXPOSE is docs-only in Render — actual port comes from PORT env at runtime.
EXPOSE 3100

CMD ["node", "src/entrypoint.js"]
