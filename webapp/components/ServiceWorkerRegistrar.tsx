'use client'

import { useEffect } from 'react'

export default function ServiceWorkerRegistrar () {
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!('serviceWorker' in navigator)) return

    // basePath in Next config means the app is served from a subpath; the SW
    // file is therefore at the same subpath, and so is its scope.
    const scope = window.location.pathname.replace(/\/[^/]*$/, '/')
    const swPath = `${scope}sw.js`

    navigator.serviceWorker
      .register(swPath, { scope })
      .catch((err) => {
        // SW failure should not break the app; just log.
        console.warn('[sw] registration failed', err)
      })
  }, [])
  return null
}
