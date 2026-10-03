/** Native platform bridge (Capacitor). On the web every function falls back gracefully. */
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { App } from '@capacitor/app';

export const isNative = () => Capacitor.isNativePlatform();
export const platform = () => Capacitor.getPlatform();

export { Geolocation, Filesystem, Directory, Share, App };

/** deep links (fiberlens://…) and the Android back button */
export function installNativeHandlers(h: { onUrl: (url: string) => void; onBack: () => boolean }) {
  if (!isNative()) return;
  App.addListener('appUrlOpen', (e) => h.onUrl(e.url));
  App.addListener('backButton', () => { if (!h.onBack()) App.minimizeApp(); });
}
