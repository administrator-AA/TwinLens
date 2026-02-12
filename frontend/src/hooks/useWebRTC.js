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
  const peerIndexRef = useRef(null)
  const [state, setState] = useState(ConnectionState.IDLE)
  const [remoteStream, setRemoteStream] = useState(null)
  const [peerIndex, setPeerIndex] = useState(null)
  const [peerCount, setPeerCount] = useState(0)
  const localStreamRef = useRef(localStream)

  useEffect(() => { localStreamRef.current = localStream }, [localStream])

  useEffect(() => {
  peerIndexRef.current = peerIndex
}, [peerIndex])

  const destroyPeer = useCallback(() => {
    peerRef.current?.destroy()
    peerRef.current = null
  }, [])

 const createPeer = useCallback((initiator) => {
  // Use the ref to ensure we have the absolute latest stream object
  const currentStream = localStreamRef.current;
  
  if (!currentStream) {
    console.warn('[WebRTC] No local stream available yet');
    return;
  }
  
  destroyPeer();

  const peer = new SimplePeer({
    initiator,
    stream: currentStream,
    trickle: true,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        {
        urls: "stun:stun.relay.metered.ca:80",
      },
      {
        urls: "turn:global.relay.metered.ca:80",
        username: "5663d26a4df196d48974ad18",
        credential: "QoUV/lDtsrXh0TXl",
      },
      {
        urls: "turn:global.relay.metered.ca:80?transport=tcp",
        username: "5663d26a4df196d48974ad18",
        credential: "QoUV/lDtsrXh0TXl",
      },
      {
        urls: "turn:global.relay.metered.ca:443",
        username: "5663d26a4df196d48974ad18",
        credential: "QoUV/lDtsrXh0TXl",
      },
      {
        urls: "turns:global.relay.metered.ca:443?transport=tcp",
        username: "5663d26a4df196d48974ad18",
        credential: "QoUV/lDtsrXh0TXl",
      },
      ],
    },
  });


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
  const msg = JSON.parse(evt.data);

  switch (msg.type) {
    case 'JOINED':
      // Simply establish your identity in the room
      setPeerIndex(msg.peer_index);
      setPeerCount(msg.peers_count);
      console.log(`[WebRTC] Joined as Peer ${msg.peer_index}`);
      break;

    case 'PARTNER_JOINED':
    setPeerCount(2);
    setState(ConnectionState.PARTNER_JOINED);
    onPartnerJoined?.();
    
    // USE THE REF HERE, not the state variable
    if (peerIndexRef.current === 0) {
      console.log("[WebRTC] Partner joined. I am Peer 0, initiating offer...");
      setTimeout(() => createPeer(true), 1000); // 1s delay is safer for cross-network
    }
  break;

    case 'OFFER':
      // Peer 1 receives the offer and creates its peer as the Answerer
      if (!peerRef.current) {
        console.log("[WebRTC] Received offer from Peer 0. Creating Answerer...");
        createPeer(false);
      }
      peerRef.current.signal(msg.signal);
      break;

    case 'ANSWER':
    case 'ICE_CANDIDATE':
      // Forward the response signals to the existing peer instance
      if (peerRef.current) {
        peerRef.current.signal(msg.signal);
      }
      break;

    case 'FIRE_AT':
    case 'STITCH_READY':
      onSignal?.(msg);
      break;

    case 'PARTNER_LEFT':
      onPartnerLeft?.();
      setPeerCount(1);
      setState(ConnectionState.DISCONNECTED);
      destroyPeer();
      setRemoteStream(null);
      break;

    default:
      onSignal?.(msg);
  }
};

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
