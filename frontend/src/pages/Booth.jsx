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

  // ── Camera ──────────────────────────────────────
  const { stream, error: camError, ready: camReady, videoRef, start: startCam, captureStill } = useCamera()

  // ── NTP Sync ─────────────────────────────────────
  const { syncClock, serverToLocal } = useNTPSync()

  // ── Offline queue ──────────────────────────────
  const handleRetryUpload = useCallback(async (item) => {
    const url = await uploadToCloudinary(item.blob, item.sessionId, item.peerIndex)
    return url
  }, [])
  const { enqueue, drainQueue } = useOfflineQueue(handleRetryUpload)

  // ── State ────────────────────────────────────────
  const [phase, setPhase] = useState('permission') // permission | waiting | booth | countdown | flash | result
  const [copied, setCopied] = useState(false)
  const [countdown, setCountdown] = useState(null)
  const [captureFlash, setCaptureFlash] = useState(false)
  const [myPhotoBlob, setMyPhotoBlob] = useState(null)
  const [myPhotoUrl, setMyPhotoUrl] = useState(null)
  const [partnerPhotoUrl, setPartnerPhotoUrl] = useState(null)
  const [finalUrl, setFinalUrl] = useState(null)
  const [stitchStatus, setStitchStatus] = useState(null) // null | 'uploading' | 'stitching' | 'done' | 'error'
  const [sessionId, setSessionId] = useState(null)
  const [peerInfo, setPeerInfo] = useState({ index: null, count: 0 })
  const [ghostOpacity, setGhostOpacity] = useState(0.3)
  const [filterName, setFilterName] = useState('polaroid')
  const [layout, setLayout] = useState('horizontal')
  const [feedback, setFeedback] = useState('')
  const [feedbackSent, setFeedbackSent] = useState(false)
  const [syncOffset, setSyncOffset] = useState(null)
  const [networkStatus, setNetworkStatus] = useState(navigator.onLine ? 'online' : 'offline')

  const remoteVideoRef = useRef(null)
  const ghostVideoRef = useRef(null) // 2nd ref
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

  // ── WebRTC signals ────────────────────────────
  const handleSignal = useCallback((msg) => {
    switch (msg.type) {
      case 'FIRE_AT': {
        const localFireTime = serverToLocal(msg.fire_at_ms)
        const delay = localFireTime - Date.now()
        setSessionId(msg.session_id)
        pendingSessionRef.current = msg.session_id

        // Start visual countdown
        setPhase('countdown')
        const totalMs = Math.max(delay, 0)
        let remaining = Math.ceil(totalMs / 1000)
        setCountdown(remaining)
        const tick = setInterval(() => {
          remaining -= 1
          setCountdown(remaining)
          if (remaining <= 0) clearInterval(tick)
        }, 1000)

        // Precision fire
        const fireTimer = setTimeout(() => {
          doCapture(msg.session_id)
        }, Math.max(delay, 0))

        return () => { clearInterval(tick); clearTimeout(fireTimer) }
      }
      case 'STITCH_READY': {
        // Partner uploaded; trigger stitch if we have ours too
        if (msg.peer_index !== peerInfo.index && myUploadUrlRef.current && pendingSessionRef.current) {
          const urlA = peerInfo.index === 0 ? myUploadUrlRef.current : msg.url
          const urlB = peerInfo.index === 0 ? msg.url : myUploadUrlRef.current
          triggerStitch(pendingSessionRef.current, urlA, urlB)
        }
        break
      }
    }
  }, [serverToLocal, peerInfo.index])

  const handlePartnerJoined = useCallback(() => {
    setPhase('booth')
    setPeerInfo(prev => ({ ...prev, count: 2 }))
  }, [])

  const handlePartnerLeft = useCallback(() => {
    setPeerInfo(prev => ({ ...prev, count: 1 }))
    if (phase === 'booth') setPhase('waiting')
  }, [phase])

  const { state: rtcState, remoteStream, peerIndex, peerCount, connect, disconnect, sendSignal } = useWebRTC({
    roomId,
    localStream: stream,
    onSignal: handleSignal,
    onPartnerJoined: () => console.log("Partner joined"),
    onPartnerLeft: () => console.log("Partner left"),
  })

  // ── Mount ─────────────────────────────────────
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
  }, [])

  useEffect(() => {
    // Only connect to signaling once we have a real stream to share
    if (camReady && stream && roomId) {
      console.log("Stream ready, initiating signaling...");
      connect(roomId);
    }
  }, [camReady, stream, roomId])

  useEffect(() => {
    setPeerInfo(prev => ({ ...prev, index: peerIndex, count: peerCount }))
    if (peerCount === 2) setPhase('booth')
    else if (peerCount < 2 && phase === 'booth') setPhase('waiting')
  }, [peerIndex, peerCount])

  // ── Remote stream → video element ────────────
  useEffect(() => {
  if (remoteStream) {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream
    }
    if (ghostVideoRef.current) {
      ghostVideoRef.current.srcObject = remoteStream // FEED THE GHOST REF TOO
    }
  }
}, [remoteStream])

  // ── Capture ───────────────────────────────────
  const doCapture = useCallback(async (sid) => {
    setCaptureFlash(true)
    setTimeout(() => setCaptureFlash(false), 300)
    setPhase('flash')

    try {
      const blob = await captureStill();
      if (!(blob instanceof Blob)) {
        console.error("Capture failed: result is not a Blob", blob);
        return;
      }
      const url = URL.createObjectURL(blob);
      setMyPhotoUrl(url)
      setStitchStatus('uploading')
      setPhase('result')

      let cloudUrl
      if (!navigator.onLine) {
        // Queue for offline retry
        await enqueue({ id: sid + '_upload', blob, sessionId: sid, peerIndex: peerInfo.index })
        setStitchStatus('error')
        return
      }

      cloudUrl = await uploadToCloudinary(blob, sid, peerInfo.index)
      myUploadUrlRef.current = cloudUrl
      setStitchStatus('stitching')

      // Notify partner
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

  const handleCapture = useCallback(() => {
    sendSignal({ type: 'CAPTURE_REQUEST' })
  }, [sendSignal])

  const copyLink = useCallback(() => {
    navigator.clipboard.writeText(BOOTH_URL())
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [])

  const handleFeedback = useCallback(async (rating) => {
    setFeedback(rating)
    // Log to console; swap for Supabase/PostHog in production
    console.log('[Feedback]', { session_id: sessionId, rating, offset_ms: syncOffset })
    setFeedbackSent(true)
  }, [sessionId, syncOffset])

  const resetBooth = useCallback(() => {
    setPhase(peerCount === 2 ? 'booth' : 'waiting')
    setMyPhotoUrl(null)
    setMyPhotoBlob(null)
    setPartnerPhotoUrl(null)
    setFinalUrl(null)
    setStitchStatus(null)
    setFeedback('')
    setFeedbackSent(false)
    pendingSessionRef.current = null
    myUploadUrlRef.current = null
  }, [peerCount])

  // ── Render ────────────────────────────────────
  return (
    <div style={s.page}>
      {captureFlash && <div style={s.flashOverlay} />}

      {/* Header */}
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

      {/* Main content */}
      {phase === 'permission' && (
        <PermissionScreen camError={camError} onRetry={() => startCam().then(() => setPhase('waiting'))} />
      )}

      {(phase === 'waiting' || phase === 'booth' || phase === 'countdown') && (
        <BoothView
          phase={phase}
          videoRef={videoRef}
          remoteVideoRef={remoteVideoRef}
          ghostVideoRef={ghostVideoRef} // ghost prop
          remoteStream={remoteStream}
          peerCount={peerCount}
          roomId={roomId}
          copied={copied}
          countdown={countdown}
          ghostOpacity={ghostOpacity}
          setGhostOpacity={setGhostOpacity}
          filterName={filterName}
          setFilterName={setFilterName}
          layout={layout}
          setLayout={setLayout}
          onCapture={handleCapture}
          onCopyLink={copyLink}
          syncOffset={syncOffset}
        />
      )}

      {phase === 'flash' && (
        <div style={s.flashScreen}>
          <div style={{ animation: 'pulse 0.3s ease' }}>📸</div>
          <p style={{ color: 'var(--cream)', fontFamily: 'var(--font-serif)', fontSize: 18, marginTop: 12 }}>Capturing…</p>
        </div>
      )}

      {phase === 'result' && (
        <ResultView
          myPhotoUrl={myPhotoUrl}
          finalUrl={finalUrl}
          stitchStatus={stitchStatus}
          sessionId={sessionId}
          feedback={feedback}
          feedbackSent={feedbackSent}
          onFeedback={handleFeedback}
          onReset={resetBooth}
        />
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────────────────────

function PermissionScreen({ camError, onRetry }) {
  return (
    <div style={{ ...s.center, flexDirection: 'column', gap: 20, padding: 24 }}>
      <div style={{ fontSize: 48 }}>📷</div>
      <h2 style={s.sectionTitle}>Camera Access Needed</h2>
      {camError
        ? <p style={{ color: 'var(--red)', textAlign: 'center', fontSize: 14 }}>{camError}</p>
        : <p style={{ color: 'var(--cream-dim)', textAlign: 'center', fontSize: 14 }}>Please allow camera access to continue.</p>
      }
      <button style={{ ...s.btn, ...s.btnPrimary }} onClick={onRetry}>Allow Camera</button>
    </div>
  )
}

function BoothView({
  phase, videoRef, remoteVideoRef, ghostVideoRef, remoteStream, peerCount, roomId,
  copied, countdown, ghostOpacity, setGhostOpacity,
  filterName, setFilterName, layout, setLayout,
  onCapture, onCopyLink, syncOffset,
}) {
  return (
    <div style={s.boothLayout}>
      {/* Viewfinder pair */}
      <div style={s.viewfinderRow}>
        {/* My feed */}
        <div style={s.viewfinderWrap}>
          <div style={s.viewfinderLabel}>You</div>
          <video ref={videoRef} autoPlay muted playsInline style={s.video} />
          {/* Ghost overlay of partner */}
          {remoteStream && (
            <video
              ref={ghostVideoRef} // CHANGE FROM remoteVideoRef TO ghostVideoRef
              autoPlay muted playsInline
              style={{ ...s.video, ...s.ghostOverlay, opacity: ghostOpacity }}
            />
          )}
          {/* Heart guide */}
          <div style={s.heartGuide}>
            <svg viewBox="0 0 100 90" style={{ width: 80, height: 72, opacity: 0.35 }}>
              <path d="M50 80 C50 80 5 50 5 25 C5 10 17 0 30 0 C38 0 45 5 50 12 C55 5 62 0 70 0 C83 0 95 10 95 25 C95 50 50 80 50 80Z"
                fill="none" stroke="var(--amber)" strokeWidth="2" strokeDasharray="6 4" />
              <path d="M50 80 C50 80 5 50 5 25 C5 10 17 0 30 0 C38 0 45 5 50 12 C55 5 62 0 70 0 C83 0 95 10 95 25 C95 50 50 80 50 80Z"
                fill="var(--amber)" fillOpacity="0.08" />
            </svg>
          </div>
          {/* Countdown overlay */}
          {phase === 'countdown' && countdown !== null && (
            <div style={s.countdownOverlay}>
              <CountdownRing value={countdown} max={2} />
            </div>
          )}
        </div>

        {/* Remote feed (shown separately when partner connected) */}
        {peerCount === 2 && (
          <div style={s.viewfinderWrap}>
            <div style={s.viewfinderLabel}>Partner</div>
            <video ref={remoteVideoRef} autoPlay playsInline muted style={s.video} />
          </div>
        )}

        {/* Waiting placeholder */}
        {peerCount < 2 && (
          <div style={s.waitingSlot}>
            <div style={s.waitingPulse} />
            <p style={s.waitingText}>Waiting for partner…</p>
            <div style={s.inviteBox}>
              <code style={s.inviteCode}>{roomId}</code>
              <button style={{ ...s.btn, ...s.btnSecondary, fontSize: 12, padding: '6px 14px' }} onClick={onCopyLink}>
                {copied ? '✓ Copied!' : 'Copy Link'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div style={s.controls}>
        {/* Ghost slider */}
        {peerCount === 2 && (
          <label style={s.sliderLabel}>
            <span>Ghost {Math.round(ghostOpacity * 100)}%</span>
            <input
              type="range" min="0" max="0.6" step="0.05"
              value={ghostOpacity}
              onChange={e => setGhostOpacity(+e.target.value)}
              style={s.slider}
            />
          </label>
        )}

        {/* Filter selector */}
        <div style={s.filterRow}>
          {['polaroid', 'warm', 'noir'].map(f => (
            <button
              key={f}
              style={{ ...s.filterBtn, ...(filterName === f ? s.filterBtnActive : {}) }}
              onClick={() => setFilterName(f)}
            >
              {f}
            </button>
          ))}
          <div style={{ width: 1, height: 20, background: 'var(--border)' }} />
          {['horizontal', 'vertical'].map(l => (
            <button
              key={l}
              style={{ ...s.filterBtn, ...(layout === l ? s.filterBtnActive : {}) }}
              onClick={() => setLayout(l)}
              title={l + ' split'}
            >
              {l === 'horizontal' ? '⬛⬜' : '⬛⬜'}
            </button>
          ))}
        </div>

        {/* Shutter */}
        <button
          style={{
            ...s.shutterBtn,
            opacity: peerCount < 2 || phase === 'countdown' ? 0.4 : 1,
            cursor: peerCount < 2 || phase === 'countdown' ? 'not-allowed' : 'pointer',
          }}
          onClick={onCapture}
          disabled={peerCount < 2 || phase === 'countdown'}
          aria-label="Take synchronized photo"
        >
          <div style={s.shutterInner} />
        </button>

        {syncOffset !== null && (
          <span style={s.syncBadge}>⏱ offset: {syncOffset > 0 ? '+' : ''}{Math.round(syncOffset)}ms</span>
        )}
      </div>
    </div>
  )
}

function CountdownRing({ value, max }) {
  const r = 40, circumference = 2 * Math.PI * r
  const progress = value / max
  return (
    <div style={{ position: 'relative', width: 100, height: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width="100" height="100" style={{ position: 'absolute', transform: 'rotate(-90deg)' }}>
        <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(232,168,124,0.2)" strokeWidth="4" />
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--amber)" strokeWidth="4"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.9s linear' }}
        />
      </svg>
      <span style={{ fontFamily: 'var(--font-serif)', fontSize: 36, color: 'var(--amber)', fontWeight: 700, zIndex: 1 }}>
        {value}
      </span>
    </div>
  )
}

function ResultView({ myPhotoUrl, finalUrl, stitchStatus, sessionId, feedback, feedbackSent, onFeedback, onReset }) {
  const downloadFinal = () => {
    if (!finalUrl) return
    const a = document.createElement('a')
    a.href = finalUrl
    a.download = `twinlens_${sessionId}.jpg`
    a.target = '_blank'
    a.click()
  }

  return (
    <div style={{ ...s.center, flexDirection: 'column', gap: 24, padding: '24px 16px', maxWidth: 600, margin: '0 auto', animation: 'fadeUp 0.5s ease' }}>
      <h2 style={{ fontFamily: 'var(--font-serif)', fontSize: 28, color: 'var(--cream)' }}>
        {stitchStatus === 'done' ? 'Your TwinLens ✦' : 'Processing…'}
      </h2>

      {/* Final stitched photo */}
      {stitchStatus === 'done' && finalUrl && (
        <div style={s.finalPhotoWrap}>
          <img src={finalUrl} alt="TwinLens photo" style={s.finalPhoto} />
          <button style={{ ...s.btn, ...s.btnPrimary, marginTop: 12 }} onClick={downloadFinal}>
            ↓ Save Keepsake
          </button>
        </div>
      )}

      {/* Status messages */}
      {stitchStatus === 'uploading' && (
        <StatusMessage icon="⬆" text="Uploading your photo…" />
      )}
      {stitchStatus === 'stitching' && (
        <StatusMessage icon="🧩" text="Merging both photos…" />
      )}
      {stitchStatus === 'error' && (
        <div style={{ textAlign: 'center' }}>
          <p style={{ color: 'var(--red)', fontSize: 14 }}>Something went wrong. Your photo is saved locally.</p>
          {myPhotoUrl && <img src={myPhotoUrl} alt="Your photo" style={{ ...s.finalPhoto, maxWidth: 280, marginTop: 12 }} />}
        </div>
      )}

      {/* My photo preview while waiting for stitch */}
      {stitchStatus && stitchStatus !== 'done' && myPhotoUrl && (
        <div style={{ textAlign: 'center' }}>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8, fontFamily: 'var(--font-mono)' }}>Your capture</p>
          <img src={myPhotoUrl} alt="Your preview" style={{ ...s.finalPhoto, maxWidth: 240, opacity: 0.7 }} />
        </div>
      )}

      {/* Feedback */}
      {stitchStatus === 'done' && !feedbackSent && (
        <div style={s.feedbackBox}>
          <p style={{ fontSize: 13, color: 'var(--cream-dim)', marginBottom: 10 }}>How was the sync?</p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            {['😍 Perfect', '👍 Good', '😐 Okay', '😔 Off'].map(r => (
              <button
                key={r}
                style={{ ...s.filterBtn, ...(feedback === r ? s.filterBtnActive : {}) }}
                onClick={() => onFeedback(r)}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      )}
      {feedbackSent && <p style={{ color: 'var(--green)', fontSize: 13 }}>Thanks for your feedback! 💛</p>}

      <button style={{ ...s.btn, ...s.btnSecondary }} onClick={onReset}>
        ← Take another
      </button>
    </div>
  )
}

function StatusMessage({ icon, text }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--cream-dim)', fontSize: 14 }}>
      <span style={{ animation: 'pulse 1s infinite' }}>{icon}</span>
      <span>{text}</span>
    </div>
  )
}

function StatusDot({ rtcState, peerCount }) {
  const color = rtcState === ConnectionState.CONNECTED ? 'var(--green)'
    : rtcState === ConnectionState.CONNECTING || rtcState === ConnectionState.PARTNER_JOINED ? 'var(--amber)'
    : 'var(--text-muted)'
  const label = rtcState === ConnectionState.CONNECTED ? `Connected · ${peerCount}/2`
    : rtcState === ConnectionState.CONNECTING ? 'Connecting…'
    : rtcState === ConnectionState.PARTNER_JOINED ? 'Partner joining…'
    : rtcState === ConnectionState.ERROR ? 'Error'
    : 'Waiting'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, boxShadow: `0 0 6px ${color}` }} />
      {label}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────────
// Styles
// ──────────────────────────────────────────────────────────────────────────────

const s = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg)',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '12px 20px',
    borderBottom: '1px solid var(--border)',
    background: 'rgba(13,10,7,0.8)',
    backdropFilter: 'blur(8px)',
    position: 'sticky', top: 0, zIndex: 100,
  },
  backBtn: {
    background: 'none',
    color: 'var(--text-muted)',
    fontSize: 13,
    fontFamily: 'var(--font-mono)',
    padding: '4px 8px',
  },
  roomBadge: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '4px 12px',
  },
  roomLabel: { fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.1em' },
  roomCode: { fontSize: 14, color: 'var(--amber)', fontFamily: 'var(--font-mono)', fontWeight: 500, letterSpacing: '0.08em' },
  headerRight: { display: 'flex', alignItems: 'center', gap: 10 },
  offlineBadge: {
    padding: '2px 8px',
    background: 'rgba(235,87,87,0.15)',
    border: '1px solid var(--red)',
    borderRadius: 10,
    fontSize: 11, fontFamily: 'var(--font-mono)',
    color: 'var(--red)',
  },

  boothLayout: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 20,
    padding: '20px 16px 32px',
  },
  viewfinderRow: {
    display: 'flex',
    gap: 12,
    width: '100%',
    maxWidth: 900,
    justifyContent: 'center',
    flexWrap: 'wrap',
  },
  viewfinderWrap: {
    position: 'relative',
    width: 'min(420px, calc(50vw - 20px))',
    aspectRatio: '4/3',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    overflow: 'hidden',
  },
  viewfinderLabel: {
    position: 'absolute', top: 10, left: 10,
    padding: '2px 8px',
    background: 'rgba(13,10,7,0.7)',
    borderRadius: 4,
    fontSize: 11, fontFamily: 'var(--font-mono)',
    color: 'var(--amber)',
    zIndex: 10,
    letterSpacing: '0.06em',
  },
  video: {
    width: '100%', height: '100%',
    objectFit: 'cover',
    transform: 'scaleX(-1)', // mirror
  },
  ghostOverlay: {
    position: 'absolute', inset: 0,
    mixBlendMode: 'lighten',
  },
  heartGuide: {
    position: 'absolute', inset: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    pointerEvents: 'none', zIndex: 5,
  },
  countdownOverlay: {
    position: 'absolute', inset: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(13,10,7,0.5)',
    zIndex: 20,
  },

  waitingSlot: {
    width: 'min(420px, calc(50vw - 20px))',
    aspectRatio: '4/3',
    background: 'var(--surface)',
    border: '2px dashed var(--border)',
    borderRadius: 8,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 20,
  },
  waitingPulse: {
    width: 48, height: 48, borderRadius: '50%',
    background: 'var(--amber-glow)',
    border: '2px solid var(--amber-dim)',
    animation: 'pulse 2s ease-in-out infinite',
  },
  waitingText: {
    color: 'var(--text-muted)', fontSize: 14,
    fontFamily: 'var(--font-mono)',
  },
  inviteBox: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
    width: '100%',
  },
  inviteCode: {
    fontFamily: 'var(--font-mono)',
    fontSize: 18, letterSpacing: '0.1em',
    color: 'var(--amber)',
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '6px 16px',
    display: 'block',
    textAlign: 'center',
    width: '100%',
  },

  controls: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
    width: '100%', maxWidth: 500,
  },
  sliderLabel: {
    display: 'flex', alignItems: 'center', gap: 12,
    fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
    width: '100%',
  },
  slider: {
    flex: 1, accentColor: 'var(--amber)',
  },
  filterRow: {
    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'center',
  },
  filterBtn: {
    padding: '5px 14px',
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 20,
    fontSize: 12, fontFamily: 'var(--font-mono)',
    color: 'var(--text-muted)',
    cursor: 'pointer',
  },
  filterBtnActive: {
    borderColor: 'var(--amber)',
    color: 'var(--amber)',
    background: 'var(--amber-glow)',
  },

  shutterBtn: {
    width: 72, height: 72,
    borderRadius: '50%',
    background: 'var(--cream)',
    border: '4px solid var(--amber)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 0 20px rgba(232,168,124,0.4), 0 4px 12px rgba(0,0,0,0.4)',
    transition: 'transform 0.1s, box-shadow 0.1s',
  },
  shutterInner: {
    width: 48, height: 48,
    borderRadius: '50%',
    background: 'var(--cream)',
    border: '3px solid rgba(26,15,7,0.15)',
  },

  syncBadge: {
    fontSize: 11, fontFamily: 'var(--font-mono)',
    color: 'var(--text-muted)',
  },

  flashOverlay: {
    position: 'fixed', inset: 0,
    background: 'white',
    opacity: 0.8,
    zIndex: 9999,
    animation: 'pulse 0.3s ease',
    pointerEvents: 'none',
  },
  flashScreen: {
    flex: 1,
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    fontSize: 64,
    background: 'var(--bg)',
  },

  finalPhotoWrap: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    animation: 'fadeUp 0.6s ease',
  },
  finalPhoto: {
    maxWidth: '100%',
    maxHeight: '60vh',
    borderRadius: 8,
    boxShadow: 'var(--shadow)',
    border: '1px solid var(--border)',
  },
  feedbackBox: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '16px 20px',
    textAlign: 'center',
    width: '100%',
    maxWidth: 400,
  },

  center: {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  btn: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 22px',
    borderRadius: 6, fontSize: 14, fontWeight: 500,
  },
  btnPrimary: {
    background: 'var(--amber)', color: '#1a0f07',
    justifyContent: 'center',
    boxShadow: '0 0 20px rgba(232,168,124,0.25)',
  },
  btnSecondary: {
    background: 'var(--surface-2)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
  },
  sectionTitle: {
    fontFamily: 'var(--font-serif)',
    fontSize: 22,
    color: 'var(--cream)',
  },
}
