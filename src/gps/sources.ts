import type { GpsFix, GpsSource } from './types';
import { NmeaParser } from './nmea';
import { isNative, Geolocation } from '../platform/native';
import { FiberLensGnss } from '../platform/gnssNative';
import type { PluginListenerHandle } from '@capacitor/core';

declare global { interface Window { Capacitor?: any } }

/**
 * Phone GNSS via the platform location API. On Android (Capacitor) the native
 * Geolocation plugin is used when present (permissions + background-safe); external
 * receivers that publish an Android mock location are picked up transparently.
 */
export class DeviceGpsSource implements GpsSource {
  readonly id = 'device';
  readonly label = 'Phone GNSS';
  private watch: any = null;
  private plugin: any = null;
  private sats: { used: number; inView: number } | null = null;
  private statusSub: PluginListenerHandle | null = null;

  async start(onFix: (f: GpsFix) => void, onError: (e: string) => void) {
    this.plugin = isNative() ? Geolocation : null;
    if (this.plugin) {
      // satellites used / in view from Android GnssStatus (native FiberLens plugin)
      try {
        this.statusSub = await FiberLensGnss.addListener('gnssStatus', (s) => { this.sats = { used: s.used, inView: s.inView }; });
        await FiberLensGnss.startStatus();
      } catch { /* plugin unavailable: no satellite info */ }
    }
    const handle = (pos: any) => {
      const c = pos.coords;
      onFix({
        satellites: this.sats?.used, satellitesInView: this.sats?.inView,
        lat: c.latitude, lon: c.longitude, alt: c.altitude ?? undefined, accuracy: c.accuracy ?? 99,
        altAccuracy: c.altitudeAccuracy ?? undefined, heading: Number.isFinite(c.heading) ? c.heading : undefined,
        speed: Number.isFinite(c.speed) ? c.speed : undefined, source: this.label, time: pos.timestamp || Date.now(),
        fixType: (c.accuracy ?? 99) < 30 ? 'gps' : 'network',
      });
    };
    if (this.plugin) {
      try {
        const perm = await this.plugin.checkPermissions();
        if (perm.location !== 'granted') await this.plugin.requestPermissions();
        this.watch = await this.plugin.watchPosition({ enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }, (pos: any, err: any) => {
          if (err) onError(err.message ?? String(err)); else if (pos) handle(pos);
        });
        return;
      } catch (err) {
        onError((err as Error).message);
      }
    }
    if (!('geolocation' in navigator)) { onError('Geolocation is not available on this device'); return; }
    this.watch = navigator.geolocation.watchPosition(handle, (e) => onError(e.message || 'Location error'), { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  }

  stop() {
    this.statusSub?.remove(); this.statusSub = null;
    if (this.plugin) FiberLensGnss.stopStatus().catch(() => {});
    if (this.watch === null) return;
    if (this.plugin) this.plugin.clearWatch({ id: this.watch });
    else navigator.geolocation.clearWatch(this.watch);
    this.watch = null;
  }
}

/** External GNSS receiver streaming NMEA over USB / serial (Web Serial API). */
export class SerialNmeaSource implements GpsSource {
  readonly id = 'serial';
  readonly label = 'External GNSS (USB/Serial)';
  private port: any = null;
  private reader: any = null;
  private running = false;
  constructor(private baud = 9600) {}

  async start(onFix: (f: GpsFix) => void, onError: (e: string) => void) {
    const serial = (navigator as any).serial;
    if (!serial) { onError('Web Serial is not supported here. On Android, pair the receiver and enable it as a mock-location provider, then use Phone GNSS.'); return; }
    try {
      this.port = await serial.requestPort();
      await this.port.open({ baudRate: this.baud });
    } catch (err) { onError((err as Error).message); return; }
    this.running = true;
    const parser = new NmeaParser(this.label, onFix);
    const dec = new TextDecoder();
    (async () => {
      while (this.running && this.port?.readable) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            parser.push(dec.decode(value));
          }
        } catch (err) { onError((err as Error).message); }
        finally { this.reader.releaseLock(); }
      }
    })();
  }

  stop() {
    this.running = false;
    try { this.reader?.cancel(); } catch { /* ignore */ }
    try { this.port?.close(); } catch { /* ignore */ }
    this.port = null;
  }
}

/** External GNSS over Bluetooth LE (Nordic UART service, used by many RTK receivers). */
export class BleNmeaSource implements GpsSource {
  readonly id = 'ble';
  readonly label = 'External GNSS (Bluetooth LE)';
  private device: any = null;
  static NUS = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  static NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

  async start(onFix: (f: GpsFix) => void, onError: (e: string) => void) {
    const bt = (navigator as any).bluetooth;
    if (!bt) { onError('Web Bluetooth is not supported here. Use the receiver vendor app with Android mock location, then Phone GNSS.'); return; }
    try {
      this.device = await bt.requestDevice({ filters: [{ services: [BleNmeaSource.NUS] }], optionalServices: [BleNmeaSource.NUS] });
      const server = await this.device.gatt.connect();
      const svc = await server.getPrimaryService(BleNmeaSource.NUS);
      const ch = await svc.getCharacteristic(BleNmeaSource.NUS_TX);
      const parser = new NmeaParser(this.label, onFix);
      const dec = new TextDecoder();
      ch.addEventListener('characteristicvaluechanged', (ev: any) => parser.push(dec.decode(ev.target.value)));
      await ch.startNotifications();
    } catch (err) { onError((err as Error).message); }
  }

  stop() { try { this.device?.gatt?.disconnect(); } catch { /* ignore */ } this.device = null; }
}

/** NMEA text pasted / streamed (e.g. replay of a recorded log) — also used by tests. */
export class ReplayNmeaSource implements GpsSource {
  readonly id = 'replay';
  readonly label = 'NMEA replay';
  private timer: any = 0;
  constructor(private text: string, private intervalMs = 1000) {}
  async start(onFix: (f: GpsFix) => void) {
    const lines = this.text.split(/\r?\n/).filter((l) => l.startsWith('$'));
    const parser = new NmeaParser(this.label, onFix);
    let i = 0;
    this.timer = setInterval(() => {
      // push until next GGA
      while (i < lines.length) { const l = lines[i++]; parser.push(l + '\n'); if (/GGA/.test(l)) break; }
      if (i >= lines.length) i = 0;
    }, this.intervalMs);
  }
  stop() { clearInterval(this.timer); }
}

/**
 * Simulator: walks along a route (lat/lon list) at walking speed — for training,
 * demos and testing without leaving the office.
 */
export class SimulatorSource implements GpsSource {
  readonly id = 'sim';
  readonly label = 'Simulator';
  private timer: any = 0;
  constructor(private route: { lat: number; lon: number }[], private speed = 1.4, private noise = 1.5) {}
  async start(onFix: (f: GpsFix) => void, onError: (e: string) => void) {
    if (this.route.length < 1) { onError('Simulator needs a route'); return; }
    const R = 6371008.8, rad = Math.PI / 180;
    // segment lengths in metres
    const segs: number[] = [];
    for (let i = 0; i + 1 < this.route.length; i++) {
      const a = this.route[i], b = this.route[i + 1];
      const dx = (b.lon - a.lon) * rad * R * Math.cos(a.lat * rad), dy = (b.lat - a.lat) * rad * R;
      segs.push(Math.hypot(dx, dy));
    }
    const total = segs.reduce((s, x) => s + x, 0);
    let dist = 0;
    const tick = () => {
      let d = total > 0 ? dist % total : 0, i = 0;
      while (i < segs.length && d > segs[i]) { d -= segs[i]; i++; }
      const a = this.route[Math.min(i, this.route.length - 1)], b = this.route[Math.min(i + 1, this.route.length - 1)];
      const t = segs[i] ? d / segs[i] : 0;
      const lat = a.lat + (b.lat - a.lat) * t, lon = a.lon + (b.lon - a.lon) * t;
      const heading = (Math.atan2((b.lon - a.lon) * Math.cos(a.lat * rad), b.lat - a.lat) / rad + 360) % 360;
      const n = () => (Math.random() - 0.5) * 2 * this.noise / R / rad;
      onFix({ lat: lat + n(), lon: lon + n() / Math.cos(lat * rad), alt: 12, accuracy: this.noise * 2 + Math.random(), heading, speed: this.speed, satellites: 14, hdop: 0.8, fixType: 'gps', source: this.label, time: Date.now() });
      dist += this.speed;
    };
    tick();
    this.timer = setInterval(tick, 1000);
  }
  stop() { clearInterval(this.timer); }
}

/**
 * External GNSS / RTK receiver over Bluetooth Classic (SPP) — Android app only, through the
 * native FiberLens plugin. Streams NMEA (GGA/RMC/GST…) so RTK fix type, HDOP, satellites and
 * accuracy come straight from the receiver.
 */
export class BluetoothSppSource implements GpsSource {
  readonly id = 'bt-spp';
  readonly label = 'External GNSS (Bluetooth)';
  private subs: PluginListenerHandle[] = [];
  constructor(private choose: (devices: { name: string; address: string }[]) => Promise<string | null>) {}

  async start(onFix: (f: GpsFix) => void, onError: (e: string) => void) {
    if (!isNative()) { onError('Bluetooth receivers are supported in the Android app. On desktop use USB/Serial or Bluetooth LE.'); return; }
    try {
      const { devices } = await FiberLensGnss.listBondedDevices();
      if (!devices.length) { onError('No paired Bluetooth devices. Pair the GNSS receiver in Android settings first.'); return; }
      const address = await this.choose(devices);
      if (!address) { onError('No receiver selected'); return; }
      const parser = new NmeaParser(this.label, onFix);
      this.subs.push(await FiberLensGnss.addListener('sppData', (e) => parser.push(e.sentence + '\n')));
      this.subs.push(await FiberLensGnss.addListener('sppError', (e) => onError('Receiver disconnected: ' + e.error)));
      const r = await FiberLensGnss.connect({ address });
      (this as any).label = 'Bluetooth: ' + (r.name || address);
    } catch (err) {
      onError((err as Error).message ?? String(err));
    }
  }

  stop() {
    for (const s of this.subs) s.remove();
    this.subs = [];
    FiberLensGnss.disconnect().catch(() => {});
  }
}
