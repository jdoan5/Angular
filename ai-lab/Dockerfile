# ai-lab agent backend — the same code Vercel runs as serverless functions,
# packaged for GKE. Auth in-cluster is Workload Identity (GEMINI_AUTH=adc):
# no API key is baked in, mounted, or env-injected.
#
#   docker build -t ai-lab-agent .
#   docker run -p 8080:8080 --env-file .env.local ai-lab-agent   # local smoke test

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Prod deps only. (This still pulls the Angular runtime libs listed under
# "dependencies" — harmless bloat; the server itself needs only @google/genai.)
RUN npm ci --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY agent-core ./agent-core
COPY api ./api
COPY server.mjs ./

# Run as the unprivileged user the base image ships with.
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
