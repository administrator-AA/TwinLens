# TwinLens — Deployment Guide

## Overview

TwinLens uses a **zero-cost MVP stack** deployable in under 30 minutes:

| Service | Platform | Cost | Purpose |
|---------|----------|------|---------|
| Backend (FastAPI) | Render Free | $0 | WebSocket signaling, image stitching |
| Frontend (React/Vite) | Vercel Hobby | $0 | Static SPA, WebRTC client |
| Image storage | Cloudinary Free | $0 | Photo upload + CDN delivery |
| Database | None (in-memory) | $0 | Room state (ephermal) |

---

## Step 0 — Prerequisites

- GitHub account (to connect Render + Vercel)
- Cloudinary account (free at cloudinary.com)
- Node.js 20+ and Python 3.11+ for local dev

---

## Step 1 — Cloudinary Setup (5 min)

1. Sign up at [cloudinary.com](https://cloudinary.com) → free tier gives 25 GB storage, 25 GB bandwidth/month
2. From the **Dashboard**, note:
   - `Cloud Name`
   - `API Key`
   - `API Secret`
3. Go to **Settings → Upload → Upload Presets**
   - Click **Add upload preset**
   - Name: `twinlens`
   - Signing Mode: **Unsigned**
   - Folder: `twinlens`
   - Save
4. Set up **auto-delete** (privacy requirement):
   - Settings → Upload → Auto backup / Expiration
   - Set expiry to **24 hours** for the `twinlens` folder

---

## Step 2 — Deploy Backend to Render (10 min)

### Option A — From GitHub (recommended)

1. Push the entire repo to GitHub (both `backend/` and `frontend/` subdirs in one repo)
2. Go to [render.com](https://render.com) → New → **Web Service**
3. Connect your GitHub repo
4. Configure:
   - **Root Directory**: `backend`
   - **Runtime**: Python 3
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
   - **Plan**: Free
5. Add **Environment Variables**:
   ```
   CLOUDINARY_CLOUD_NAME   = <your value>
   CLOUDINARY_API_KEY      = <your value>
   CLOUDINARY_API_SECRET   = <your value>
   ALLOWED_ORIGINS         = https://your-app.vercel.app
   ```
6. Click **Deploy** → wait ~3 min for build
7. Note your service URL: `https://twinlens-api.onrender.com`

### Option B — Using render.yaml

The `backend/render.yaml` file is pre-configured. Just link the repo and Render will auto-detect it.

### Verify

```bash
curl https://twinlens-api.onrender.com/health
# Expected: {"status":"ok","rooms_active":0}

curl https://twinlens-api.onrender.com/api/time
# Expected: {"server_time_ms":1234567890}
```

> ⚠️ **Free Tier Cold Starts**: Render free tier spins down after 15 min of inactivity. First request after sleep takes ~30s. Acceptable for MVP; upgrade to Starter ($7/mo) to eliminate this.

---

## Step 3 — Deploy Frontend to Vercel (5 min)

1. Go to [vercel.com](https://vercel.com) → Add New → **Project**
2. Import your GitHub repo
3. Configure:
   - **Root Directory**: `frontend`
   - **Framework Preset**: Vite
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
4. Add **Environment Variables**:
   ```
   VITE_API_URL                    = https://twinlens-api.onrender.com
   VITE_CLOUDINARY_CLOUD_NAME      = <your value>
   VITE_CLOUDINARY_UPLOAD_PRESET   = twinlens
   ```
5. Click **Deploy** → live in ~90 seconds
6. Note your URL: `https://twinlens.vercel.app`

### Update CORS

Go back to Render → Environment Variables → update:
```
ALLOWED_ORIGINS = https://twinlens.vercel.app
```
Trigger a redeploy.

---

## Step 4 — CI/CD via GitHub Actions

The `.github/workflows/` directory contains two pre-wired workflows:

### Secrets to add in GitHub → Settings → Secrets and Variables → Actions:

| Secret | Where to get it |
|--------|----------------|
| `RENDER_DEPLOY_HOOK_URL` | Render → Service → Settings → Deploy Hooks → Create hook |
| `VERCEL_TOKEN` | vercel.com → Account Settings → Tokens |
| `VERCEL_ORG_ID` | `.vercel/project.json` after `vercel link` |
| `VERCEL_PROJECT_ID` | `.vercel/project.json` after `vercel link` |
| `VITE_API_URL` | Your Render URL |
| `VITE_CLOUDINARY_CLOUD_NAME` | Cloudinary dashboard |
| `VITE_CLOUDINARY_UPLOAD_PRESET` | `twinlens` |

### Workflow behaviour:

- **Push to `main`** with changes in `backend/` → lints Python → triggers Render redeploy
- **Push to `main`** with changes in `frontend/` → builds Vite → deploys to Vercel production
- **Pull Request** targeting `main` → builds frontend → deploys to Vercel **preview URL** (great for testing)

---

## Step 5 — Custom Domain (optional)

### Vercel
- Dashboard → Project → Settings → Domains → Add `twinlens.io`
- Add CNAME `cname.vercel-dns.com` at your registrar

### Render
- Dashboard → Service → Settings → Custom Domains → Add `api.twinlens.io`

---

## Local Development

```bash
# 1. Clone
git clone https://github.com/yourname/twinlens.git
cd twinlens

# 2. Backend
cd backend
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your Cloudinary keys
uvicorn main:app --reload --port 8000

# 3. Frontend (new terminal)
cd frontend
npm install
cp .env.example .env.local
# Edit .env.local:
#   VITE_API_URL=http://localhost:8000
#   VITE_CLOUDINARY_CLOUD_NAME=xxx
#   VITE_CLOUDINARY_UPLOAD_PRESET=twinlens
npm run dev
```

Open `http://localhost:5173` in **two separate tabs** (or two browser windows) to simulate both peers.

---

## Scaling Beyond Free Tier

When you outgrow the free tier:

| Bottleneck | Trigger | Fix |
|------------|---------|-----|
| Render cold starts | User complaints about first-load delay | Upgrade to Render Starter $7/mo |
| Cloudinary bandwidth | >25 GB/month | Upgrade Cloudinary or switch to Bunny CDN |
| In-memory room state | Multi-instance deploys | Add Redis (Upstash free tier) |
| WebRTC connectivity | Users behind restrictive NATs | Add TURN server (Twilio TURN or Metered.ca free tier) |
| Image stitching latency | >5s stitch time | Move OpenCV to a Celery worker with Redis queue |

---

## Environment Variable Reference

### Backend

| Variable | Required | Description |
|----------|----------|-------------|
| `CLOUDINARY_CLOUD_NAME` | ✅ | Cloudinary cloud identifier |
| `CLOUDINARY_API_KEY` | ✅ | For server-side uploads |
| `CLOUDINARY_API_SECRET` | ✅ | For server-side uploads |
| `ALLOWED_ORIGINS` | Recommended | CORS whitelist (comma-separated) |
| `PORT` | Auto (Render) | HTTP port |

### Frontend

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_API_URL` | ✅ | Backend base URL |
| `VITE_CLOUDINARY_CLOUD_NAME` | ✅ | For unsigned browser uploads |
| `VITE_CLOUDINARY_UPLOAD_PRESET` | ✅ | Unsigned upload preset name |

---

## Health Check URLs

After deployment, verify these all return 200:

```
GET  https://your-render-url.onrender.com/           → service info
GET  https://your-render-url.onrender.com/health     → {"status":"ok"}
GET  https://your-render-url.onrender.com/api/time   → server timestamp
POST https://your-render-url.onrender.com/api/room/create → {"room_id":"XXXXXXXX"}
```
