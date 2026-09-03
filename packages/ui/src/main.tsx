// Mount point. Deliberately thin: everything that matters is in App.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App.tsx';
import './styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Registering the service worker is what makes the app installable -- the
// home-screen icon, the standalone window, and more reliable screen-off
// playback on Android. sw.js itself is a network passthrough and caches
// nothing; offline downloads are meant to grow there later.
//
// It fails on plain http and on old browsers, and that is fine: install-less
// is a perfectly good degraded state, so the rejection is swallowed.
navigator.serviceWorker?.register('/sw.js').catch(() => {});
