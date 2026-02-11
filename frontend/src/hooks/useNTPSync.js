import { useRef, useCallback } from 'react'
import { API_BASE } from '../utils/api.js'

/**
 * NTP-style clock sync over REST.
 * Sends 5 pings, takes median offset.
 * Returns { syncClock, getLocalOffset }
 * localOffset: server_time - local_time (ms)
 */
export function useNTPSync() {
  const offsetRef = useRef(0)

  const syncClock = useCallback(async () => {
    const samples = []
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now()
      const res = await fetch(`${API_BASE}/api/time`)
      const t3 = Date.now()
      const { server_time_ms } = await res.json()
      const rtt = t3 - t0
      const serverAtMidpoint = server_time_ms + rtt / 2
      const offset = serverAtMidpoint - t3
      samples.push(offset)
      await new Promise(r => setTimeout(r, 100))
    }
    samples.sort((a, b) => a - b)
    offsetRef.current = samples[Math.floor(samples.length / 2)]
    console.log(`[NTP] Clock offset: ${offsetRef.current.toFixed(1)}ms`)
    return offsetRef.current
  }, [])

  /** Convert a server-epoch timestamp to local-epoch for use with setTimeout */
  const serverToLocal = useCallback((serverMs) => {
    return serverMs - offsetRef.current
  }, [])

  return { syncClock, serverToLocal, getOffset: () => offsetRef.current }
}
