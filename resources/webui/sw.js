/*
 * CRAFT-FORK 2026-06-20: FEATURE-008 mobile F5 hosted slice — push service worker.
 *
 * Handles background Web Push for the hosted PWA: shows a notification when the
 * agent needs the user / finishes, and routes a tap back to the right session.
 * Deliberately tiny + dependency-free (raw file copied to the dist root).
 */

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload = {}
    try {
      payload = event.data ? event.data.json() : {}
    } catch (_e) {
      payload = {}
    }

    // Foreground suppression: if a window is focused, the user is already
    // watching — don't buzz. (Backgrounded/locked phone has no focused client.)
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (clients.some((c) => c.focused)) return

    const sessionId = payload.sessionId || ''
    await self.registration.showNotification(payload.title || 'Peng', {
      body: payload.body || '',
      // Collapse per-session so a busy task shows one latest-state notification.
      tag: sessionId || 'craft-agents',
      renotify: true,
      data: { sessionId, workspaceId: payload.workspaceId || '' },
      icon: '/icon-192.png',
      badge: '/icon-192.png',
    })
  })())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  const sessionId = data.sessionId || ''
  const workspaceId = data.workspaceId || ''

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    // Warm path: focus an existing tab and ask it to navigate in-place.
    for (const client of clients) {
      if ('focus' in client) {
        await client.focus()
        client.postMessage({ type: 'navigate', sessionId, workspaceId })
        return
      }
    }
    // Cold path: open a new window with the deep-link params.
    const url = new URL('/', self.location.origin)
    if (sessionId) url.searchParams.set('session', sessionId)
    if (workspaceId) url.searchParams.set('workspace', workspaceId)
    await self.clients.openWindow(url.toString())
  })())
})
