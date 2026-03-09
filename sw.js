importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyA0UqHP0P50FjWss90GEnVdNkJD4ZyRbwk",
  authDomain: "focuskit-ffef2.firebaseapp.com",
  projectId: "focuskit-ffef2",
  storageBucket: "focuskit-ffef2.firebasestorage.app",
  messagingSenderId: "60713684347",
  appId: "1:60713684347:web:bc250dbec4ae530ef5c1de"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log('백그라운드 메시지 수신:', payload);
  const { title, body } = payload.notification || {};
  self.registration.showNotification(title || 'FocusKit', {
    body: body || '',
    icon: '/icon.png',
    badge: '/icon.png',
    tag: 'focuskit',
    vibrate: [200, 100, 200]
  });
});

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
