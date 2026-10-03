import React, { useEffect } from 'react';
import { useApp } from '../app/store';
import { Toasts, Loading, DialogHost } from './common';
import { StartScreen } from './StartScreen';
import { CadScreen } from './CadScreen';
import { MediaViewer } from './field/ObjectMedia';

export function App() {
  const screen = useApp((s) => s.screen);
  const dark = useApp((s) => s.dark);
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, [dark]);
  return (
    <div className="app">
      {screen === 'start' ? <StartScreen /> : <CadScreen />}
      <Toasts />
      <DialogHost />
      <MediaViewer />
      <Loading />
    </div>
  );
}
