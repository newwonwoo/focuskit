importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');

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
  self.registration.showNotification(payload.notification.title, {
    body: payload.notification.body,
    icon: '/icon.png'
  });
});
