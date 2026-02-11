import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createRoom } from '../utils/api.js'

export default function Home() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [roomInput, setRoomInput] = useState('')
  const [error, setError] = useState('')

  async function handleStart() {
    setLoading(true)
    setError('')
    try {
      const { room_id } = await createRoom()
      navigate(`/booth/${room_id}`)
    } catch (e) {
      setError('Could not reach server. Is the backend running?')
      setLoading(false)
    }
  }

  function handleJoin(e) {
    e.preventDefault()
    const id = roomInput.trim().toUpperCase()
    if (!id) return
    navigate(`/booth/${id}`)
  }

  return (
    <div style={styles.page}>
      {/* Background orbs */}
      <div style={styles.orb1} />
      <div style={styles.orb2} />

      <main style={styles.main}>
        {/* Logo */}
        <div style={styles.logoWrap}>
          <HeartIcon style={styles.logoIcon} />
          <span style={styles.logoText}>TwinLens</span>
        </div>

        <h1 style={styles.headline}>
          A moment,<br />
          <em>shared exactly.</em>
        </h1>

        <p style={styles.sub}>
          Synchronized photography for long-distance couples.<br />
          Both shutters fire at the same millisecond — no matter the distance.
        </p>

        <div style={styles.actions}>
          <button
            style={{ ...styles.btn, ...styles.btnPrimary, opacity: loading ? 0.6 : 1 }}
            onClick={handleStart}
            disabled={loading}
          >
            {loading ? (
              <span style={styles.spinner} />
            ) : (
              <>
                <CameraIcon style={{ width: 18, height: 18 }} />
                Start Session
              </>
            )}
          </button>

          <div style={styles.divider}><span>or join with a code</span></div>

          <form onSubmit={handleJoin} style={styles.joinForm}>
            <input
              value={roomInput}
              onChange={e => setRoomInput(e.target.value)}
              placeholder="Room code  e.g. A3F7B2C1"
              style={styles.input}
              maxLength={8}
              spellCheck={false}
              autoCapitalize="characters"
            />
            <button type="submit" style={{ ...styles.btn, ...styles.btnSecondary }}>
              Join →
            </button>
          </form>

          {error && <p style={styles.error}>{error}</p>}
        </div>

        {/* Feature pills */}
        <div style={styles.pills}>
          {['95% sync accuracy', 'P2P encrypted', '< 60s setup', 'Polaroid keepsakes'].map(t => (
            <span key={t} style={styles.pill}>{t}</span>
          ))}
        </div>
      </main>

      <footer style={styles.footer}>
        <span style={{ color: 'var(--text-muted)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
          TwinLens MVP · Built with ❤
        </span>
      </footer>
    </div>
  )
}

function HeartIcon({ style }) {
  return (
    <svg style={style} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 21C12 21 3 15 3 9C3 6 5.5 4 8 4C9.5 4 11 4.9 12 6C13 4.9 14.5 4 16 4C18.5 4 21 6 21 9C21 15 12 21 12 21Z"
        fill="var(--amber)" fillOpacity="0.9" />
    </svg>
  )
}

function CameraIcon({ style }) {
  return (
    <svg style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  )
}

const styles = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    overflow: 'hidden',
    padding: '24px',
  },
  orb1: {
    position: 'fixed', top: '10%', right: '5%',
    width: 320, height: 320, borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(232,168,124,0.12) 0%, transparent 70%)',
    pointerEvents: 'none',
    animation: 'pulse 4s ease-in-out infinite',
  },
  orb2: {
    position: 'fixed', bottom: '10%', left: '5%',
    width: 240, height: 240, borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(212,130,122,0.1) 0%, transparent 70%)',
    pointerEvents: 'none',
    animation: 'pulse 5s ease-in-out infinite 1s',
  },
  main: {
    maxWidth: 520,
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 28,
    animation: 'fadeUp 0.8s ease both',
    zIndex: 1,
  },
  logoWrap: {
    display: 'flex', alignItems: 'center', gap: 10,
  },
  logoIcon: { width: 32, height: 32 },
  logoText: {
    fontFamily: 'var(--font-serif)',
    fontSize: 22, fontWeight: 700,
    color: 'var(--amber)',
    letterSpacing: '0.04em',
  },
  headline: {
    fontFamily: 'var(--font-serif)',
    fontSize: 'clamp(32px, 6vw, 52px)',
    fontWeight: 400,
    textAlign: 'center',
    lineHeight: 1.25,
    color: 'var(--cream)',
  },
  sub: {
    textAlign: 'center',
    color: 'var(--cream-dim)',
    fontSize: 15,
    lineHeight: 1.7,
    maxWidth: 400,
  },
  actions: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 16,
  },
  btn: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '12px 28px',
    borderRadius: 6,
    fontSize: 15, fontWeight: 500,
    letterSpacing: '0.02em',
    transition: 'all 0.2s',
  },
  btnPrimary: {
    background: 'var(--amber)',
    color: '#1a0f07',
    width: '100%',
    justifyContent: 'center',
    boxShadow: '0 0 24px rgba(232,168,124,0.3)',
  },
  btnSecondary: {
    background: 'var(--surface-2)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    whiteSpace: 'nowrap',
  },
  divider: {
    width: '100%', textAlign: 'center', position: 'relative',
    color: 'var(--text-muted)', fontSize: 12, fontFamily: 'var(--font-mono)',
    '::before': { content: '""' },
  },
  joinForm: {
    width: '100%', display: 'flex', gap: 8,
  },
  input: {
    flex: 1,
    fontFamily: 'var(--font-mono)',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    fontSize: 14,
  },
  error: {
    color: 'var(--red)', fontSize: 13,
    textAlign: 'center',
  },
  pills: {
    display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center',
  },
  pill: {
    padding: '4px 12px',
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 20,
    fontSize: 12, fontFamily: 'var(--font-mono)',
    color: 'var(--text-muted)',
  },
  spinner: {
    width: 18, height: 18,
    border: '2px solid rgba(26,15,7,0.3)',
    borderTop: '2px solid #1a0f07',
    borderRadius: '50%',
    display: 'inline-block',
    animation: 'spin 0.7s linear infinite',
  },
  footer: {
    position: 'fixed', bottom: 16,
    display: 'flex', alignItems: 'center',
  },
}
