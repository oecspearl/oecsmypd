/**
 * Firebase Cloud Messaging Service Worker
 *
 * This service worker handles push notifications when the app is in the background.
 * It must be at the root of your public folder to work correctly.
 */

// Import Firebase scripts
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

// Firebase configuration
// Note: These values are public and safe to include in client-side code.
// The registering page (lib/firebase/config.ts) passes the NEXT_PUBLIC_FIREBASE_*
// values as query-string parameters on the service worker URL, because a
// service worker has no access to process.env.
const swParams = new URLSearchParams(self.location.search);
const firebaseConfig = {
  apiKey: swParams.get('apiKey') || '',
  authDomain: swParams.get('authDomain') || '',
  projectId: swParams.get('projectId') || '',
  storageBucket: swParams.get('storageBucket') || '',
  messagingSenderId: swParams.get('messagingSenderId') || '',
  appId: swParams.get('appId') || '',
};

// Initialize Firebase only if config is present
if (firebaseConfig.apiKey && firebaseConfig.projectId) {
  firebase.initializeApp(firebaseConfig);
  const messaging = firebase.messaging();

  // Handle background messages
  messaging.onBackgroundMessage((payload) => {
    console.log('[firebase-messaging-sw.js] Received background message:', payload);

    const notificationTitle = payload.notification?.title || payload.data?.title || 'New Notification';
    const notificationOptions = {
      body: payload.notification?.body || payload.data?.body || '',
      icon: payload.notification?.icon || '/icons/icon-192x192.png',
      badge: '/icons/badge-72x72.png',
      tag: payload.data?.tag || 'default',
      data: {
        url: payload.data?.url || payload.fcmOptions?.link || '/',
        ...payload.data,
      },
      actions: payload.data?.actions ? JSON.parse(payload.data.actions) : [],
      requireInteraction: payload.data?.requireInteraction === 'true',
      silent: payload.data?.silent === 'true',
    };

    return self.registration.showNotification(notificationTitle, notificationOptions);
  });
}

// Handle notification click
self.addEventListener('notificationclick', (event) => {
  console.log('[firebase-messaging-sw.js] Notification click:', event);

  event.notification.close();

  // Get the URL from notification data
  const urlToOpen = event.notification.data?.url || '/';

  // Handle action button clicks
  if (event.action) {
    const actions = event.notification.data?.actions || [];
    const action = actions.find((a) => a.action === event.action);
    if (action?.url) {
      event.waitUntil(clients.openWindow(action.url));
      return;
    }
  }

  // Open or focus the app window
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Check if there's already a window/tab open
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          if (urlToOpen !== '/') {
            client.navigate(urlToOpen);
          }
          return;
        }
      }
      // If no window is open, open a new one
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});

// Handle push subscription change
self.addEventListener('pushsubscriptionchange', (event) => {
  console.log('[firebase-messaging-sw.js] Push subscription changed');

  event.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true })
      .then((subscription) => {
        // Send the new subscription to your server
        return fetch('/api/notifications/push/resubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            oldEndpoint: event.oldSubscription?.endpoint,
            newSubscription: subscription.toJSON(),
          }),
        });
      })
  );
});

console.log('[firebase-messaging-sw.js] Service worker loaded');
