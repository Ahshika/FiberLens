import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/** JS side of android/.../FiberLensGnssPlugin.java */
export interface FiberLensGnssPlugin {
  startStatus(): Promise<void>;
  stopStatus(): Promise<void>;
  listBondedDevices(): Promise<{ devices: { name: string; address: string }[] }>;
  connect(o: { address: string }): Promise<{ name: string }>;
  disconnect(): Promise<void>;
  addListener(event: 'gnssStatus', cb: (e: { used: number; inView: number; avgCn0: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'nmea' | 'sppData', cb: (e: { sentence: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'sppError', cb: (e: { error: string }) => void): Promise<PluginListenerHandle>;
}

export const FiberLensGnss = registerPlugin<FiberLensGnssPlugin>('FiberLensGnss');
