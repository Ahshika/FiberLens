import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './styles/app.css';
import { startAutoSync } from './data/sync';
import { useApp } from './app/store';
import { Capacitor } from '@capacitor/core';

startAutoSync((r) => useApp.getState().toast(`Synced: ↑${r.pushed} ↓${r.pulled}${r.conflicts ? ` · ${r.conflicts} conflicts` : ''}`, 'info'));

createRoot(document.getElementById('root')!).render(<App />);

// Web build (iPhone "Add to Home Screen", any browser): work offline and keep the projects.
// The native apps already ship their files and storage.
if (import.meta.env.PROD && !Capacitor.isNativePlatform() && 'serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* offline mode unavailable */ });
  navigator.storage?.persist?.().catch(() => {});
}
