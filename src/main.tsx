import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './styles/app.css';
import { startAutoSync } from './data/sync';
import { useApp } from './app/store';

startAutoSync((r) => useApp.getState().toast(`Synced: ↑${r.pushed} ↓${r.pulled}${r.conflicts ? ` · ${r.conflicts} conflicts` : ''}`, 'info'));

createRoot(document.getElementById('root')!).render(<App />);
