import { useRef, useState, useCallback, useEffect } from 'react'
import SimplePeer from 'simple-peer'
import { WS_BASE } from '../utils/api.js'

export const ConnectionState = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  PARTNER_JOINED: 'partner_joined',
  DISCONNECTED: 'disconnected',
  ERROR: 'error',
}

export function useWebRTC({ roomId, localStream, onSignal, onPartnerJoined, onPartnerLeft }) {
  const wsRef = useRef(null)
  const peerRef = useRef(null)
  const [state, setState] = useState(ConnectionState.IDLE)
  const [remoteStream, setRemoteStream] = useState(null)
  const [peerIndex, setPeerIndex] = useState(null)
  const [peerCount, setPeerCount] = useState(0)
  const localStreamRef = useRef(localStream)

  useEffect(() => { localStreamRef.current = localStream }, [localStream])

  const destroyPeer = useCallback(() => {
    peerRef.current?.destroy()
    peerRef.current = null
  }, [])

 const createPeer = useCallback((initiator) => {
  // CRITICAL: If no stream yet, don't create the peer. 
  // Wait for the next render when stream is available.
  if (!localStream) return; 

  destroyPeer();

    const peer = new SimplePeer({
      initiator,
      stream: localStream, // Use the prop directly
      trickle: true,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      },
    })

    peer.on('signal', (data) => {
      if (!wsRef.current) return
      const type = data.type === 'offer' ? 'OFFER' : data.type === 'answer' ? 'ANSWER' : 'ICE_CANDIDATE'
      wsRef.current.send(JSON.stringify({ type, signal: data }))
    })

    peer.on('stream', (stream) => {
      setRemoteStream(stream)
      setState(ConnectionState.CONNECTED)
    })

    peer.on('connect', () => {
      setState(ConnectionState.CONNECTED)
    })

    peer.on('error', (err) => {
      console.error('[WebRTC] Peer error', err)
      setState(ConnectionState.ERROR)
    })

    peer.on('close', () => {
      setState(ConnectionState.DISCONNECTED)
      setRemoteStream(null)
    })

    peerRef.current = peer
    return peer
  }, [destroyPeer])

  const connect = useCallback((rId) => {
    const targetRoom = rId || roomId
    if (!targetRoom) return

    setState(ConnectionState.CONNECTING)
    const ws = new WebSocket(`${WS_BASE}/ws/booth/${targetRoom}`)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('[WS] Connected to signaling server')
    }

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data)

      switch (msg.type) {
        case 'JOINED':
          setPeerIndex(msg.peer_index);
          setPeerCount(msg.peers_count);
          
          if (msg.peers_count === 2) {
            // We are the second person. Do NOT createPeer yet.
            // Wait for the 'OFFER' message to trigger createPeer(false).
            console.log("[WebRTC] Joined as Peer 1, waiting for offer...");
        }
        break;

        case 'PARTNER_JOINED':
          setPeerCount(2);
          setState(ConnectionState.PARTNER_JOINED);
          onPartnerJoined?.();
          
          // Only the first person (index 0) should initiate the call
          if (peerIndex === 0 && localStreamRef.current) {
            console.log("[WebRTC] I am Peer 0, initiating offer...");
            createPeer(true);
        }
        break;

        case 'OFFER':
          if (!peerRef.current) {
            console.log("[WebRTC] Received Offer, creating answerer peer...");
            createPeer(false);
          }
          peerRef.current.signal(msg.signal);
          break;

        case 'ANSWER':
        case 'ICE_CANDIDATE':
          if (peerRef.current) {
            peerRef.current.signal(msg.signal);
          }
        break;

        case 'FIRE_AT':
        case 'STITCH_READY':
          onSignal?.(msg)
          break

        case 'PARTNER_LEFT':
          onPartnerLeft?.()
          setPeerCount(1)
          setState(ConnectionState.DISCONNECTED)
          destroyPeer()
          setRemoteStream(null)
          break

        case 'ERROR':
          setState(ConnectionState.ERROR)
          break

        default:
          onSignal?.(msg)
      }
    }

    ws.onclose = () => {
      console.log('[WS] Disconnected')
      setState(ConnectionState.DISCONNECTED)
    }

    ws.onerror = (e) => {
      console.error('[WS] Error', e)
      setState(ConnectionState.ERROR)
    }

    return ws
  }, [roomId, createPeer, destroyPeer, onSignal, onPartnerJoined, onPartnerLeft, peerIndex])

  const disconnect = useCallback(() => {
    wsRef.current?.close()
    wsRef.current = null
    destroyPeer()
    setState(ConnectionState.IDLE)
    setRemoteStream(null)
  }, [destroyPeer])

  const sendSignal = useCallback((msg) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  useEffect(() => () => disconnect(), [disconnect])

  return {
    state,
    remoteStream,
    peerIndex,
    peerCount,
    connect,
    disconnect,
    sendSignal,
  }
}
