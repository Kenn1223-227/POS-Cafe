// Service Worker cho Cafe POS — App Shell Offline-First + Background Sync
const CACHE_NAME = 'cafe-pos-shell-v1'
const PRECACHE_URLS = ['/', '/index.html', '/manifest.webmanifest', '/cafe-avatar.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // Chỉ cache cùng origin; bỏ qua API & Socket.IO (được quản lý riêng qua IndexedDB Outbox)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io')) return

  // Điều hướng SPA (/pos, /barista, /admin/*...): Network-First, rớt mạng thì trả index.html đã cache
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy))
          }
          return res
        })
        .catch(() => caches.match('/index.html'))
    )
    return
  }

  // Tài nguyên tĩnh (JS/CSS/SVG/Fonts): Stale-While-Revalidate
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request)
        .then((networkRes) => {
          if (networkRes && networkRes.ok && networkRes.type === 'basic') {
            const copy = networkRes.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
          }
          return networkRes
        })
        .catch(() => cached)
      return cached || fetchPromise
    })
  )
})

// Background Sync: đánh thức tab POS để xả hàng đợi IndexedDB Outbox khi mạng hồi phục
self.addEventListener('sync', (event) => {
  if (event.tag === 'pos-outbox-sync') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => client.postMessage({ type: 'TRIGGER_OUTBOX_SYNC' }))
      })
    )
  }
})
