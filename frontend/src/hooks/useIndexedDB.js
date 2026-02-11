import { useEffect, useRef, useCallback } from 'react'

const DB_NAME = 'twinlens_queue'
const STORE_NAME = 'pending_uploads'
const DB_VERSION = 1

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export function useOfflineQueue(onUploadReady) {
  const dbRef = useRef(null)
  const onUploadReadyRef = useRef(onUploadReady)
  onUploadReadyRef.current = onUploadReady

  useEffect(() => {
    openDB().then(db => { dbRef.current = db })
    return () => { dbRef.current?.close() }
  }, [])

  const enqueue = useCallback(async (item) => {
    if (!dbRef.current) return
    const tx = dbRef.current.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put({ ...item, queued_at: Date.now() })
  }, [])

  const dequeue = useCallback(async (id) => {
    if (!dbRef.current) return
    const tx = dbRef.current.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(id)
  }, [])

  const drainQueue = useCallback(async () => {
    if (!dbRef.current) return
    const tx = dbRef.current.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).getAll()
    req.onsuccess = async () => {
      const items = req.result || []
      for (const item of items) {
        try {
          await onUploadReadyRef.current(item)
          await dequeue(item.id)
        } catch (e) {
          console.warn('[Queue] Retry failed', e)
        }
      }
    }
  }, [dequeue])

  // Watch online/offline
  useEffect(() => {
    const handleOnline = () => {
      console.log('[Queue] Back online — draining queue')
      drainQueue()
    }
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [drainQueue])

  return { enqueue, dequeue, drainQueue }
}
