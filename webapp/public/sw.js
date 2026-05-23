// Service Worker for PWA + Web Push notifications
// Scope: directory where this file lives (set via registration)

const SW_VERSION = 'v1'

self.addEventListener('install', (event) => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch (_) {
    payload = { title: '通知', body: event.data ? event.data.text() : '' }
  }

  const title = payload.title || '放貸通知'
  const options = {
    body: payload.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: payload.tag || 'default',
    data: payload.data || {},
    renotify: false,
    requireInteraction: false,
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = (event.notification.data && event.notification.data.url) || './'

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of allClients) {
      if (client.url.includes(self.registration.scope) && 'focus' in client) {
        try { client.postMessage({ type: 'notification-click', data: event.notification.data }) } catch (_) {}
        return client.focus()
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl)
  })())
})

self.addEventListener('pushsubscriptionchange', (event) => {
  // Re-subscribe with the new endpoint
  event.waitUntil((async () => {
    try {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of allClients) {
        client.postMessage({ type: 'push-subscription-change' })
      }
    } catch (_) {}
  })())
})
