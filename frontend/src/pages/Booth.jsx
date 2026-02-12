import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useCamera } from '../hooks/useCamera.js'
import { useWebRTC, ConnectionState } from '../hooks/useWebRTC.js'
import { useNTPSync } from '../hooks/useNTPSync.js'
import { useOfflineQueue } from '../hooks/useIndexedDB.js'
import { uploadToCloudinary, requestStitch, pollStitch } from '../utils/api.js'

const BOOTH_URL = () => window.location.href

export default function Booth() {
  const { roomId } = useParams()
  const navigate = useNavigate()

  // ── Camera & Media ─────────────────────────────
  const { stream, error: camError, ready: camReady, videoRef, start: startCam, captureStill } = useCamera()

  // ── NTP Sync & Timing ──────────────────────────
  const { syncClock, serverToLocal } = useNTPSync()

  // ── Offline Queue Handling ─────────────────────
  const handleRetryUpload = useCallback(async (item) => {
    return await uploadToCloudinary(item.blob, item.sessionId, item.peerIndex)
  }, [])
  const { enqueue } = useOfflineQueue(handleRetryUpload)

  // ── UI & Connection State ──────────────────────
  const [phase, setPhase] = useState('permission') 
  const [copied, setCopied] = useState(false)
  const [countdown, setCountdown] = useState(null)
  const [captureFlash, setCaptureFlash] = useState(false)
  const [myPhotoUrl, setMyPhotoUrl] = useState(null)
  const [finalUrl, setFinalUrl] = useState(null)
  const [stitchStatus, setStitchStatus] = useState(null) // null | 'uploading' | 'stitching' | 'done' | 'error'
  const [sessionId, setSessionId] = useState(null)
  const [peerInfo, setPeerInfo] = useState({ index: null, count: 0 })
  const [ghostOpacity, setGhostOpacity] = useState(0.3)
  const [filterName, setFilterName] = useState('polaroid')
  const [layout, setLayout] = useState('horizontal')
  const [syncOffset, setSyncOffset] = useState(null)
  const [networkStatus, setNetworkStatus] = useState(navigator.onLine ? 'online' : 'offline')

  const remoteVideoRef = useRef(null)
  const ghostVideoRef = useRef(null) 
  const pendingSessionRef = useRef(null)
  const myUploadUrlRef = useRef(null)

  // ── Network monitoring ────────────────────────
  useEffect(() => {
    const setOnline = () => setNetworkStatus('online')
    const setOffline = () => setNetworkStatus('offline')
    window.addEventListener('online', setOnline)
    window.addEventListener('offline', setOffline)
    return () => { window.removeEventListener('online', setOnline); window.removeEventListener('offline', setOffline) }
  }, [])

  // ── Signaling Handlers ────────────────────────
  const handleSignal = useCallback((msg) => {
    switch (msg.type) {
      case 'FIRE_AT': {
        const localFireTime = serverToLocal(msg.fire_at_ms)
        const delay = localFireTime - Date.now()
        setSessionId(msg.session_id)
        pendingSessionRef.current = msg.session_id

        setPhase('countdown')
        const totalMs = Math.max(delay, 0)
        let remaining = Math.ceil(totalMs / 1000)
        setCountdown(remaining)
        
        const tick = setInterval(() => {
          remaining -= 1
          setCountdown(remaining)
          if (remaining <= 0) clearInterval(tick)
        }, 1000)

        const fireTimer = setTimeout(() => {
          doCapture(msg.session_id)
        }, totalMs)

        return () => { clearInterval(tick); clearTimeout(fireTimer) }
      }
      case 'STITCH_READY': {
        if (msg.peer_index !== peerInfo.index && myUploadUrlRef.current && pendingSessionRef.current) {
          const urlA = peerInfo.index === 0 ? myUploadUrlRef.current : msg.url
          const urlB = peerInfo.index === 0 ? msg.url : myUploadUrlRef.current
          triggerStitch(pendingSessionRef.current, urlA, urlB)
        }
        break
      }
      default:
        break
    }
  }, [serverToLocal, peerInfo.index])

  const onJoin = useCallback(() => {
    console.log("[WebRTC] Partner joined event triggered");
    setPhase('booth');
  }, []);

  const onLeft = useCallback(() => {
    console.log("[WebRTC] Partner left event triggered");
    setPhase('waiting');
  }, []);

  const { state: rtcState, remoteStream, peerIndex, peerCount, connect, sendSignal } = useWebRTC({
    roomId,
    localStream: stream,
    onSignal: handleSignal,
    onPartnerJoined: onJoin,
    onPartnerLeft: onLeft,
  })

  // ── Initialization ─────────────────────────────
  useEffect(() => {
    async function init() {
      try {
        await startCam()
        setPhase('waiting')
        const offset = await syncClock()
        setSyncOffset(offset)
      } catch (e) {
        setPhase('permission')
      }
    }
    init()
  }, [startCam, syncClock])

  useEffect(() => {
    if (camReady && stream && roomId) {
      connect(roomId);
    }
  }, [camReady, stream, roomId, connect])

  useEffect(() => {
    setPeerInfo({ index: peerIndex, count: peerCount })
  }, [peerIndex, peerCount])

  // ── Stream Connection ──────────────────────────
  useEffect(() => {
    if (remoteStream) {
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream
      if (ghostVideoRef.current) ghostVideoRef.current.srcObject = remoteStream
    }
  }, [remoteStream])

  // ── Capture & Stitching ────────────────────────
  const doCapture = useCallback(async (sid) => {
    setCaptureFlash(true)
    setTimeout(() => setCaptureFlash(false), 300)
    setPhase('flash')

    try {
      const blob = await captureStill()
      if (!(blob instanceof Blob)) {
        console.error("Capture failed: No Blob returned");
        return;
      }

      const url = URL.createObjectURL(blob)
      setMyPhotoUrl(url)
      setStitchStatus('uploading')
      setPhase('result')

      if (!navigator.onLine) {
        await enqueue({ id: sid + '_upload', blob, sessionId: sid, peerIndex: peerInfo.index })
        setStitchStatus('error')
        return
      }

      const cloudUrl = await uploadToCloudinary(blob, sid, peerInfo.index)
      myUploadUrlRef.current = cloudUrl
      setStitchStatus('stitching')

      sendSignal({
        type: 'STITCH_READY',
        session_id: sid,
        peer_index: peerInfo.index,
        url: cloudUrl,
      })

    } catch (e) {
      console.error('[Capture] Error', e)
      setStitchStatus('error')
    }
  }, [captureStill, enqueue, peerInfo.index, sendSignal])

  const triggerStitch = useCallback(async (sid, urlA, urlB) => {
    try {
      await requestStitch({ session_id: sid, url_a: urlA, url_b: urlB, layout, filter_name: filterName })
      const result = await pollStitch(sid)
      setFinalUrl(result.url)
      setStitchStatus('done')
    } catch (e) {
      console.error('[Stitch] Error', e)
      setStitchStatus('error')
    }
  }, [layout, filterName])

  const handleCapture = () => {
    if (peerCount < 2) return
    sendSignal({ type: 'CAPTURE_REQUEST' })
  }

  const resetBooth = useCallback(() => {
    setPhase(peerCount === 2 ? 'booth' : 'waiting')
    setMyPhotoUrl(null)
    setFinalUrl(null)
    setStitchStatus(null)
    pendingSessionRef.current = null
    myUploadUrlRef.current = null
  }, [peerCount])

  // ── Rendering ──────────────────────────────────
  return (
    <div style={s.page}>
      {captureFlash && <div style={s.flashOverlay} />}

      <header style={s.header}>
        <button style={s.backBtn} onClick={() => navigate('/')}>← Back</button>
        <div style={s.roomBadge}>
          <span style={s.roomLabel}>Room</span>
          <span style={s.roomCode}>{roomId}</span>
        </div>
        <div style={s.headerRight}>
          {networkStatus === 'offline' && <span style={s.offlineBadge}>Offline</span>}
          <StatusDot state={rtcState} peerCount={peerCount} />
        </div>
      </header>

      {phase === 'permission' && (
        <PermissionScreen camError={camError} onRetry={() => startCam().then(() => setPhase('waiting'))} />
      )}

      {(phase === 'waiting' || phase === 'booth' || phase === 'countdown') && (
        <BoothView
          phase={phase}
          videoRef={videoRef}
          remoteVideoRef={remoteVideoRef}
          ghostVideoRef={ghostVideoRef}
          remoteStream={remoteStream}
          peerCount={peerCount}
          roomId={roomId}
          copied={copied}
          onCopyLink={() => {
            navigator.clipboard.writeText(BOOTH_URL())
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          }}
          countdown={countdown}
          ghostOpacity={ghostOpacity}
          setGhostOpacity={setGhostOpacity}
          filterName={filterName}
          setFilterName={setFilterName}
          layout={layout}
          setLayout={setLayout}
          onCapture={handleCapture}
          syncOffset={syncOffset}
        />
      )}

      {phase === 'flash' && (
        <div style={s.flashScreen}>📸<p style={{ marginTop: 12 }}>Capturing…</p></div>
      )}

      {phase === 'result' && (
        <ResultView
          myPhotoUrl={myPhotoUrl}
          finalUrl={finalUrl}
          stitchStatus={stitchStatus}
          sessionId={sessionId}
          onReset={resetBooth}
        />
      )}
    </div>
  )
}

// ── Sub-components ─────────────────────────────

function StatusDot({ state, peerCount }) {
  const color = state === ConnectionState.CONNECTED ? 'var(--green)'
    : (state === ConnectionState.CONNECTING || state === ConnectionState.PARTNER_JOINED) ? 'var(--amber)'
    : 'var(--text-muted)'
  
  const labels = {
    [ConnectionState.CONNECTED]: `Connected · ${peerCount}/2`,
    [ConnectionState.CONNECTING]: 'Connecting…',
    [ConnectionState.PARTNER_JOINED]: 'Partner joining…',
    [ConnectionState.ERROR]: 'Error',
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, boxShadow: `0 0 6px ${color}` }} />
      {labels[state] || 'Waiting'}
    </div>
  )
}

function PermissionScreen({ camError, onRetry }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20, padding: 24 }}>
      <div style={{ fontSize: 48 }}>📷</div>
      <h2 style={s.sectionTitle}>Camera Access Needed</h2>
      {camError ? <p style={{ color: 'var(--red)', fontSize: 14 }}>{camError}</p> : <p style={{ color: 'var(--cream-dim)', fontSize: 14 }}>Please allow camera access.</p>}
      <button style={s.btnPrimary} onClick={onRetry}>Allow Camera</button>
    </div>
  )
}

function BoothView({
  phase, videoRef, remoteVideoRef, ghostVideoRef, remoteStream, peerCount, roomId,
  copied, onCopyLink, countdown, ghostOpacity, setGhostOpacity,
  filterName, setFilterName, layout, setLayout, onCapture, syncOffset
}) {
  return (
    <div style={s.boothLayout}>
      <div style={s.viewfinderRow}>
        <div style={s.viewfinderWrap}>
          <div style={s.viewfinderLabel}>You</div>
          <video ref={videoRef} autoPlay muted playsInline style={s.video} />
          {remoteStream && (
            <video ref={ghostVideoRef} autoPlay muted playsInline style={{ ...s.video, ...s.ghostOverlay, opacity: ghostOpacity }} />
          )}
          {phase === 'countdown' && countdown !== null && (
            <div style={s.countdownOverlay}>
              <div style={{ fontSize: 48, color: 'var(--amber)', fontFamily: 'var(--font-serif)' }}>{countdown}</div>
            </div>
          )}
        </div>

        {peerCount === 2 ? (
          <div style={s.viewfinderWrap}>
            <div style={s.viewfinderLabel}>Partner</div>
            <video ref={remoteVideoRef} autoPlay playsInline muted style={s.video} />
          </div>
        ) : (
          <div style={s.waitingSlot}>
            <div style={s.waitingPulse} />
            <p style={s.waitingText}>Waiting for partner…</p>
            <div style={s.inviteBox}>
              <code style={s.inviteCode}>{roomId}</code>
              <button style={s.btnSecondary} onClick={onCopyLink}>{copied ? '✓ Copied!' : 'Copy Link'}</button>
            </div>
          </div>
        )}
      </div>

      <div style={s.controls}>
        {peerCount === 2 && (
          <label style={s.sliderLabel}>
            <span>Ghost {Math.round(ghostOpacity * 100)}%</span>
            <input type="range" min="0" max="0.6" step="0.05" value={ghostOpacity} onChange={e => setGhostOpacity(+e.target.value)} style={s.slider} />
          </label>
        )}
        <div style={s.filterRow}>
          {['polaroid', 'warm', 'noir'].map(f => (
            <button key={f} style={{ ...s.filterBtn, ...(filterName === f ? s.filterBtnActive : {}) }} onClick={() => setFilterName(f)}>{f}</button>
          ))}
          <div style={{ width: 1, height: 20, background: 'var(--border)' }} />
          {['horizontal', 'vertical'].map(l => (
            <button key={l} style={{ ...s.filterBtn, ...(layout === l ? s.filterBtnActive : {}) }} onClick={() => setLayout(l)}>{l === 'horizontal' ? '⬛⬜' : '⬛⬜'}</button>
          ))}
        </div>
        <button style={s.shutterBtn} onClick={onCapture} disabled={peerCount < 2 || phase === 'countdown'}>
          <div style={s.shutterInner} />
        </button>
        {syncOffset !== null && <span style={s.syncBadge}>⏱ offset: {syncOffset > 0 ? '+' : ''}{Math.round(syncOffset)}ms</span>}
      </div>
    </div>
  )
}

function ResultView({ myPhotoUrl, finalUrl, stitchStatus, sessionId, onReset }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24, padding: 24 }}>
      <h2 style={s.sectionTitle}>{stitchStatus === 'done' ? 'Your TwinLens ✦' : 'Processing…'}</h2>
      {stitchStatus === 'done' && finalUrl ? (
        <div style={{ textAlign: 'center' }}>
          <img src={finalUrl} alt="Final" style={s.finalPhoto} />
          <div style={{ marginTop: 20, display: 'flex', gap: 12, justifyContent: 'center' }}>
            <a href={finalUrl} download={`twinlens_${sessionId}.jpg`} style={{ textDecoration: 'none' }}>
              <button style={s.btnPrimary}>↓ Save Keepsake</button>
            </a>
          </div>
        </div>
      ) : (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
          <p>{stitchStatus === 'uploading' ? '⬆ Uploading photo…' : '🧩 Stitched in progress…'}</p>
          {myPhotoUrl && <img src={myPhotoUrl} alt="Preview" style={{ ...s.finalPhoto, opacity: 0.5, maxWidth: 280, marginTop: 20 }} />}
        </div>
      )}
      <button style={s.btnSecondary} onClick={onReset}>← Take another</button>
    </div>
  )
}

// ── Styles (Internal s object) ─────────────────
const s = {
  page: { minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderBottom: '1px solid var(--border)', background: 'rgba(13,10,7,0.8)', backdropFilter: 'blur(8px)', position: 'sticky', top: 0, zIndex: 100 },
  backBtn: { background: 'none', color: 'var(--text-muted)', fontSize: 13, fontFamily: 'var(--font-mono)', border: 'none', cursor: 'pointer' },
  roomBadge: { display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 12px' },
  roomLabel: { fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase' },
  roomCode: { fontSize: 14, color: 'var(--amber)', fontFamily: 'var(--font-mono)', fontWeight: 500 },
  headerRight: { display: 'flex', alignItems: 'center', gap: 10 },
  offlineBadge: { padding: '2px 8px', background: 'rgba(235,87,87,0.15)', border: '1px solid var(--red)', borderRadius: 10, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--red)' },
  boothLayout: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, padding: '20px 16px' },
  viewfinderRow: { display: 'flex', gap: 12, width: '100%', maxWidth: 900, justifyContent: 'center', flexWrap: 'wrap' },
  viewfinderWrap: { position: 'relative', width: 'min(420px, calc(50vw - 20px))', aspectRatio: '4/3', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' },
  viewfinderLabel: { position: 'absolute', top: 10, left: 10, padding: '2px 8px', background: 'rgba(13,10,7,0.7)', borderRadius: 4, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--amber)', zIndex: 10 },
  video: { width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' },
  ghostOverlay: { position: 'absolute', inset: 0, mixBlendMode: 'lighten' },
  countdownOverlay: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(13,10,7,0.5)', zIndex: 20 },
  waitingSlot: { width: 'min(420px, calc(50vw - 20px))', aspectRatio: '4/3', background: 'var(--surface)', border: '2px dashed var(--border)', borderRadius: 8, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 },
  waitingPulse: { width: 48, height: 48, borderRadius: '50%', background: 'var(--amber-glow)', border: '2px solid var(--amber-dim)', animation: 'pulse 2s infinite' },
  waitingText: { color: 'var(--text-muted)', fontSize: 14, fontFamily: 'var(--font-mono)' },
  inviteBox: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, width: '80%' },
  inviteCode: { fontFamily: 'var(--font-mono)', fontSize: 18, color: 'var(--amber)', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 16px', textAlign: 'center', width: '100%' },
  controls: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, width: '100%', maxWidth: 500 },
  sliderLabel: { display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', width: '100%' },
  slider: { flex: 1, accentColor: 'var(--amber)' },
  filterRow: { display: 'flex', alignItems: 'center', gap: 8 },
  filterBtn: { padding: '5px 14px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 20, fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', cursor: 'pointer' },
  filterBtnActive: { borderColor: 'var(--amber)', color: 'var(--amber)', background: 'var(--amber-glow)' },
  shutterBtn: { width: 72, height: 72, borderRadius: '50%', background: 'var(--cream)', border: '4px solid var(--amber)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 20px rgba(232,168,124,0.4)', cursor: 'pointer' },
  shutterInner: { width: 48, height: 48, borderRadius: '50%', background: 'var(--cream)', border: '3px solid rgba(26,15,7,0.15)' },
  syncBadge: { fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' },
  flashOverlay: { position: 'fixed', inset: 0, background: 'white', opacity: 0.8, zIndex: 9999, pointerEvents: 'none' },
  flashScreen: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', fontSize: 64 },
  finalPhoto: { maxWidth: '100%', borderRadius: 8, border: '1px solid var(--border)', boxShadow: 'var(--shadow)' },
  btnPrimary: { background: 'var(--amber)', color: '#1a0f07', border: 'none', padding: '10px 22px', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer' },
  btnSecondary: { background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', padding: '10px 22px', borderRadius: 6, fontSize: 14, cursor: 'pointer' },
  sectionTitle: { fontFamily: 'var(--font-serif)', fontSize: 24, color: 'var(--cream)' }
};