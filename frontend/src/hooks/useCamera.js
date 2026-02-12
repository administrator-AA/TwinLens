import { useRef, useState, useCallback, useEffect } from 'react'

/**
 * Manages local camera stream.
 * Preview: 360p @15fps (low bandwidth, high framerate)
 * Capture: requests max supported resolution via ImageCapture API
 */
export function useCamera() {
  const [stream, setStream] = useState(null)
  const [error, setError] = useState(null)
  const [ready, setReady] = useState(false)
  const videoRef = useRef(null)
  const streamRef = useRef(null)

  const start = useCallback(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640, max: 1280 },
          height: { ideal: 360, max: 720 },
          frameRate: { ideal: 15, max: 30 },
          facingMode: 'user',
        },
        audio: false,
      })
      streamRef.current = s
      setStream(s)
      setReady(true)
      if (videoRef.current) {
        videoRef.current.srcObject = s
      }
      return s
    } catch (err) {
      setError(err.message)
      throw err
    }
  }, [])

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    setStream(null)
    setReady(false)
  }, [])

  /**
   * Capture a high-res still using ImageCapture API.
   * Falls back to canvas snapshot from video element if unavailable.
   * Returns a Blob (JPEG).
   */
  const captureStill = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) throw new Error('No video track')

    // Prefer ImageCapture for max resolution
    if (typeof ImageCapture !== 'undefined') {
      try {
        const ic = new ImageCapture(track)
        const capabilities = await ic.getPhotoCapabilities()
        const width = capabilities.imageWidth?.max || 1920
        const height = capabilities.imageHeight?.max || 1080
        const blob = await ic.takePhoto({ imageWidth: width, imageHeight: height })
        return blob
      } catch (e) {
        console.warn('[Camera] ImageCapture failed, falling back', e)
      }
    }

    // Fallback: canvas snapshot from current video
    if (!videoRef.current) throw new Error('No video element')
    const video = videoRef.current
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0)
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
  }, [])

  // Add this effect inside useCamera()
  useEffect(() => {
    if (ready && stream && videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [ready, stream]); // This triggers as soon as the camera is ready

  return { stream, error, ready, videoRef, start, stop, captureStill }
}
