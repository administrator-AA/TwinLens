"""
TwinLens Signaling Server
FastAPI + WebSocket signaling, NTP-style clock sync, image stitching
"""
import asyncio
import json
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Dict, List, Optional

import cloudinary
import cloudinary.uploader
import cv2
import numpy as np
from fastapi import BackgroundTasks, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

cloudinary.config(
    cloud_name=os.getenv("CLOUDINARY_CLOUD_NAME", ""),
    api_key=os.getenv("CLOUDINARY_API_KEY", ""),
    api_secret=os.getenv("CLOUDINARY_API_SECRET", ""),
)

rooms: Dict[str, List[WebSocket]] = {}
room_metadata: Dict[str, dict] = {}
pending_images: Dict[str, dict] = {}
MAX_ROOM_AGE_SECONDS = 86_400


@asynccontextmanager
async def lifespan(app: FastAPI):
    asyncio.create_task(cleanup_stale_rooms())
    yield


async def cleanup_stale_rooms():
    while True:
        await asyncio.sleep(600)
        now = time.time()
        stale = [rid for rid, meta in list(room_metadata.items())
                 if now - meta.get("created_at", now) > MAX_ROOM_AGE_SECONDS]
        for rid in stale:
            rooms.pop(rid, None)
            room_metadata.pop(rid, None)
            logger.info(f"Cleaned stale room {rid}")


app = FastAPI(title="TwinLens Signaling", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    return {"service": "TwinLens Signaling Server", "status": "online"}


@app.get("/health")
async def health():
    return {"status": "ok", "rooms_active": len(rooms)}


@app.post("/api/room/create")
async def create_room():
    room_id = str(uuid.uuid4())[:8].upper()
    rooms[room_id] = []
    room_metadata[room_id] = {"created_at": time.time(), "peer_ids": []}
    return {"room_id": room_id}


@app.get("/api/room/{room_id}/status")
async def room_status(room_id: str):
    if room_id not in rooms:
        raise HTTPException(status_code=404, detail="Room not found")
    return {"room_id": room_id, "peers": len(rooms[room_id]), "full": len(rooms[room_id]) >= 2}


@app.get("/api/time")
async def server_time():
    return {"server_time_ms": int(time.time() * 1000)}


@app.websocket("/ws/booth/{room_id}")
async def websocket_booth(websocket: WebSocket, room_id: str):
    await websocket.accept()

    if room_id not in rooms:
        rooms[room_id] = []
        room_metadata[room_id] = {"created_at": time.time(), "peer_ids": []}

    if len(rooms[room_id]) >= 2:
        await websocket.send_json({"type": "ERROR", "message": "Room is full"})
        await websocket.close()
        return

    peer_index = len(rooms[room_id])
    peer_id = str(uuid.uuid4())[:8]
    rooms[room_id].append(websocket)
    room_metadata[room_id]["peer_ids"].append(peer_id)

    await websocket.send_json({
        "type": "JOINED",
        "peer_id": peer_id,
        "peer_index": peer_index,
        "room_id": room_id,
        "peers_count": len(rooms[room_id]),
    })

    if len(rooms[room_id]) == 2:
        for ws in rooms[room_id]:
            await ws.send_json({"type": "PARTNER_JOINED", "peers_count": 2})

    logger.info(f"Peer {peer_id} joined room {room_id} ({len(rooms[room_id])}/2)")

    try:
        async for raw in websocket.iter_text():
            msg = json.loads(raw)
            msg_type = msg.get("type", "")

            if msg_type in ("OFFER", "ANSWER", "ICE_CANDIDATE"):
                for ws in rooms[room_id]:
                    if ws is not websocket:
                        await ws.send_json(msg)

            elif msg_type == "CAPTURE_REQUEST":
                fire_at = int(time.time() * 1000) + 2000
                session_id = str(uuid.uuid4())
                for ws in rooms[room_id]:
                    await ws.send_json({
                        "type": "FIRE_AT",
                        "fire_at_ms": fire_at,
                        "session_id": session_id,
                    })

            elif msg_type == "NTP_PING":
                await websocket.send_json({
                    "type": "NTP_PONG",
                    "client_send_time": msg.get("client_send_time"),
                    "server_recv_time": int(time.time() * 1000),
                })

            elif msg_type == "STITCH_READY":
                for ws in rooms[room_id]:
                    if ws is not websocket:
                        await ws.send_json(msg)

            elif msg_type == "PING":
                await websocket.send_json({"type": "PONG"})

    except WebSocketDisconnect:
        pass
    finally:
        if room_id in rooms and websocket in rooms[room_id]:
            rooms[room_id].remove(websocket)
            for ws in rooms[room_id]:
                await ws.send_json({"type": "PARTNER_LEFT"})
            if not rooms[room_id]:
                rooms.pop(room_id, None)
                room_metadata.pop(room_id, None)
        logger.info(f"Peer {peer_id} left room {room_id}")


class StitchRequest(BaseModel):
    session_id: str
    url_a: str
    url_b: str
    layout: str = "horizontal"
    filter_name: str = "polaroid"


def download_image_from_url(url: str) -> Optional[np.ndarray]:
    import urllib.request
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            data = resp.read()
        arr = np.frombuffer(data, np.uint8)
        return cv2.imdecode(arr, cv2.IMREAD_COLOR)
    except Exception as e:
        logger.error(f"Failed to download {url}: {e}")
        return None


def apply_filter(img: np.ndarray, filter_name: str) -> np.ndarray:
    if filter_name == "noir":
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    if filter_name == "warm":
        b, g, r = cv2.split(img)
        r = cv2.add(r, 20)
        b = cv2.subtract(b, 10)
        return cv2.merge([b, g, r])
    # polaroid: warm + vignette
    warm = img.astype(np.float32)
    warm[:, :, 2] = np.clip(warm[:, :, 2] + 15, 0, 255)
    warm[:, :, 0] = np.clip(warm[:, :, 0] - 8, 0, 255)
    h, w = img.shape[:2]
    Y, X = np.ogrid[:h, :w]
    cx, cy = w / 2, h / 2
    dist = np.sqrt(((X - cx) / cx) ** 2 + ((Y - cy) / cy) ** 2)
    mask = np.clip(1 - dist * 0.6, 0.3, 1.0)
    warm *= mask[:, :, np.newaxis]
    return warm.astype(np.uint8)


def add_polaroid_border(canvas: np.ndarray) -> np.ndarray:
    bs, bb = 24, 72
    h, w = canvas.shape[:2]
    result = np.ones((h + bs * 2 + bb, w + bs * 2, 3), dtype=np.uint8) * 250
    result[bs:bs + h, bs:bs + w] = canvas
    return result


def stitch_images(img_a: np.ndarray, img_b: np.ndarray, layout: str, filter_name: str) -> bytes:
    TARGET = (900, 900)

    def fit(img):
        h, w = img.shape[:2]
        scale = min(TARGET[0] / w, TARGET[1] / h)
        nw, nh = int(w * scale), int(h * scale)
        resized = cv2.resize(img, (nw, nh))
        canvas = np.zeros((TARGET[1], TARGET[0], 3), dtype=np.uint8)
        ox, oy = (TARGET[0] - nw) // 2, (TARGET[1] - nh) // 2
        canvas[oy:oy + nh, ox:ox + nw] = resized
        return canvas

    a = apply_filter(fit(img_a), filter_name)
    b = apply_filter(fit(img_b), filter_name)
    divider = np.ones((TARGET[1], 4, 3), dtype=np.uint8) * 255

    if layout == "vertical":
        h_div = np.ones((4, TARGET[0], 3), dtype=np.uint8) * 255
        canvas = np.vstack([a, h_div, b])
    else:
        canvas = np.hstack([a, divider, b])

    framed = add_polaroid_border(canvas)
    _, buf = cv2.imencode(".jpg", framed, [cv2.IMWRITE_JPEG_QUALITY, 92])
    return buf.tobytes()


def do_stitch_and_upload(session_id: str, url_a: str, url_b: str, layout: str, filter_name: str):
    img_a = download_image_from_url(url_a)
    img_b = download_image_from_url(url_b)
    if img_a is None or img_b is None:
        pending_images[session_id] = {"status": "error", "error": "Could not load images"}
        return
    jpeg_bytes = stitch_images(img_a, img_b, layout, filter_name)
    try:
        result = cloudinary.uploader.upload(
            jpeg_bytes,
            public_id=f"twinlens/{session_id}/final",
            resource_type="image",
            tags=["twinlens", session_id],
        )
        pending_images[session_id] = {"status": "done", "url": result.get("secure_url", "")}
        logger.info(f"Stitched image: {result.get('secure_url')}")
    except Exception as e:
        logger.error(f"Cloudinary upload failed: {e}")
        pending_images[session_id] = {"status": "error", "error": str(e)}


@app.post("/api/stitch")
async def stitch_endpoint(body: StitchRequest, background_tasks: BackgroundTasks):
    pending_images[body.session_id] = {"status": "processing"}
    background_tasks.add_task(
        do_stitch_and_upload, body.session_id, body.url_a, body.url_b, body.layout, body.filter_name
    )
    return {"session_id": body.session_id, "status": "processing"}


@app.get("/api/stitch/{session_id}")
async def stitch_status(session_id: str):
    return pending_images.get(session_id, {"status": "not_found"})
