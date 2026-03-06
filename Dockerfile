# ── Stage 1: Build React frontend ────────────────────────────────────────────
FROM node:20-alpine AS frontend-build

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install

COPY frontend/ ./
RUN npm run build

# ── Stage 2: Build Express server ────────────────────────────────────────────
FROM node:20-alpine AS server-build

WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm install

COPY server/ ./
RUN npm run build

# ── Stage 3: Final runtime (Node + Python) ──────────────────────────────────
FROM node:20-alpine

# Install Python 3 and pip
RUN apk add --no-cache python3 py3-pip

WORKDIR /app

# ── Python backend (Sports API) ──
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r backend/requirements.txt

COPY backend/ ./backend/

# ── Express server (Games API + proxy + static serving) ──
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev

# Copy compiled Express server
COPY --from=server-build /app/server/dist ./server/dist

# Copy built React app into Express's public dir
COPY --from=frontend-build /app/frontend/dist ./server/dist/public

# Copy user static files (loading.png etc.)
COPY static/ ./server/dist/user_static/

# Express is the main entry point on $PORT
# Python/FastAPI runs internally on port 8000
ENV PORT=7860
ENV PYTHON_BACKEND_URL=http://127.0.0.1:8000

EXPOSE 7860

# Start both: Python backend on 8000, Express on $PORT
CMD sh -c '\
  cd /app/backend && python3 -m uvicorn main:app --host 127.0.0.1 --port 8000 & \
  sleep 2 && \
  cd /app/server && node dist/index.js \
'
