# TwinLens 📷🤍

> **Synchronized photography for long-distance couples.**  
> Both shutters fire at the same millisecond — no matter the distance.

[![Deploy Backend](https://img.shields.io/badge/Backend-Render-46E3B7?logo=render)](https://render.com)
[![Deploy Frontend](https://img.shields.io/badge/Frontend-Vercel-000?logo=vercel)](https://vercel.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-amber.svg)](LICENSE)

---

## What It Does

TwinLens solves a simple but hard problem: **two people, miles apart, taking a photo together at the exact same moment** — and getting a high-quality stitched keepsake, not a compressed video-call screenshot.

### Key Features

- **< 50ms sync accuracy** via NTP-style clock offset calculation
- **< 60s link-to-shutter** — share a URL, that's it
- **P2P WebRTC** — video goes direct between browsers, not through the server
- **Ghost overlay** — see your partner's feed as a semi-transparent layer to align poses
- **High-res capture** — uses `ImageCapture` API at max resolution, not a video screenshot
- **Polaroid stitching** — Python/OpenCV merges both shots into a framed keepsake
- **Offline-safe** — failed uploads queue in IndexedDB and retry when you're back online

---

## Project Structure

```
twinlens/
├── .github/
│   └── workflows/
│       ├── deploy-backend.yml    # Render deploy on push to main/backend/**
│       └── deploy-frontend.yml   # Vercel deploy on push to main/frontend/**
│
├── backend/                      # Python FastAPI — Signaling + Stitching
│   ├── main.py                   # All server logic (rooms, WS, NTP, stitch)
│   ├── requirements.txt
│   ├── Procfile                  # Render start command
│   ├── render.yaml               # Render IaC config
│   └── .env.example
│
├── frontend/                     # React + Vite — Booth UI
│   ├── index.html
│   ├── package.json
│   ├── vite.config.js
│   ├── vercel.json               # SPA rewrite rule
│   ├── .env.example
│   └── src/
│       ├── main.jsx              # React root
│       ├── App.jsx               # Router
│       ├── pages/
│       │   ├── Home.jsx          # Landing — create/join session
│       │   └── Booth.jsx         # Live booth — viewfinder, shutter, result
│       ├── hooks/
│       │   ├── useCamera.js      # getUserMedia + ImageCapture
│       │   ├── useWebRTC.js      # SimplePeer + WebSocket signaling
│       │   ├── useNTPSync.js     # Clock offset (5-sample median)
│       │   └── useIndexedDB.js   # Offline upload queue
│       ├── utils/
│       │   └── api.js            # Fetch helpers + Cloudinary upload
│       └── styles/
│           └── global.css        # CSS variables + animations
│
└── docs/
    └── DEPLOYMENT.md             # Step-by-step deploy guide
```

---

## Quick Start

```bash
# Backend
cd backend && python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in Cloudinary keys
uvicorn main:app --reload

# Frontend (new terminal)
cd frontend && npm install
cp .env.example .env.local   # set VITE_API_URL=http://localhost:8000
npm run dev
```

Open `http://localhost:5173` in two tabs to test both peers.

→ **Full deployment guide**: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

---

## Architecture

```
┌─────────────┐   WebSocket    ┌─────────────────────┐
│  Browser A  │◄──────────────►│  FastAPI (Render)   │
│             │   (signaling)  │                     │
│  React SPA  │                │  • Room management  │
│  SimplePeer │◄──────────────►│  • NTP /api/time    │
│             │   WebRTC P2P   │  • Sync-shutter     │
└─────────────┘   (video/data) │  • Image stitching  │
                               │    (OpenCV → CDN)   │
┌─────────────┐   WebSocket    └─────────────────────┘
│  Browser B  │◄──────────────►           │
│             │                           ▼
│  React SPA  │                    ┌─────────────┐
│  SimplePeer │◄──────────────────►│  Cloudinary │
└─────────────┘   WebRTC P2P       │  (images)   │
                                   └─────────────┘
```

### Sync-Shutter Logic

```
1. On page load: client pings /api/time × 5, takes median RTT
   → clockOffset = serverTime - localTime

2. User presses shutter:
   Client → WS → { type: "CAPTURE_REQUEST" }

3. Server broadcasts to both peers:
   { type: "FIRE_AT", fire_at_ms: server_now + 2000 }

4. Each client:
   localFireTime = fire_at_ms - clockOffset
   setTimeout(capture, localFireTime - Date.now())

Both cameras trigger at the same server-epoch millisecond.
Target: < 50ms delta between peers.
```

---

## Deployment

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full step-by-step guide.

**TL;DR:**
1. Cloudinary → create free account + `twinlens` unsigned upload preset
2. Render → deploy `backend/` as Python web service, add 3 env vars
3. Vercel → deploy `frontend/` as Vite app, add 3 env vars
4. GitHub → add 7 secrets to enable CI/CD on every push

---

## Performance Targets

| Metric | Target | How |
|--------|--------|-----|
| Capture sync delta | < 50ms | NTP offset + 2s scheduled fire |
| Link-to-Shutter | < 60s | Direct URL, no account required |
| Preview frame rate | 15fps @ 360p | `getUserMedia` constraints |
| Capture resolution | Max supported | `ImageCapture.takePhoto()` |
| Upload retry | Automatic | IndexedDB queue + `online` event |
| Image retention | ≤ 24h | Cloudinary auto-delete |

---

## License

MIT
