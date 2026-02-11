export const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000'
export const WS_BASE = API_BASE.replace(/^http/, 'ws')
export const CLOUDINARY_UPLOAD_URL = `https://api.cloudinary.com/v1_1/${import.meta.env.VITE_CLOUDINARY_CLOUD_NAME}/image/upload`
export const CLOUDINARY_UPLOAD_PRESET = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET || 'twinlens'

export async function createRoom() {
  const res = await fetch(`${API_BASE}/api/room/create`, { method: 'POST' })
  if (!res.ok) throw new Error('Failed to create room')
  return res.json()
}

export async function fetchServerTime() {
  const res = await fetch(`${API_BASE}/api/time`)
  return res.json()
}

export async function requestStitch(payload) {
  const res = await fetch(`${API_BASE}/api/stitch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return res.json()
}

export async function pollStitch(sessionId, maxAttempts = 20, intervalMs = 1500) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs))
    const res = await fetch(`${API_BASE}/api/stitch/${sessionId}`)
    const data = await res.json()
    if (data.status === 'done') return data
    if (data.status === 'error') throw new Error(data.error || 'Stitch failed')
  }
  throw new Error('Stitch timed out')
}

/** Upload raw Blob to Cloudinary, return secure_url */
export async function uploadToCloudinary(blob, sessionId, peerIndex) {
  const fd = new FormData()
  fd.append('file', blob, `${sessionId}_peer${peerIndex}.jpg`)
  fd.append('upload_preset', CLOUDINARY_UPLOAD_PRESET)
  fd.append('folder', 'twinlens')
  fd.append('public_id', `twinlens/${sessionId}/peer_${peerIndex}`)
  fd.append('tags', `twinlens,${sessionId}`)

  const res = await fetch(CLOUDINARY_UPLOAD_URL, { method: 'POST', body: fd })
  if (!res.ok) throw new Error('Cloudinary upload failed')
  const data = await res.json()
  return data.secure_url
}
