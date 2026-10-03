import type { GpsFix, FixType } from './types';

/** Incremental NMEA 0183 parser (GGA, RMC, GSA, GSV, GST, VTG) for external GNSS receivers. */
export class NmeaParser {
  private buf = '';
  private state: Partial<GpsFix> & { gstAcc?: number } = {};
  constructor(private source: string, private onFix: (f: GpsFix) => void) {}

  push(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line.startsWith('$')) this.line(line);
    }
    if (this.buf.length > 4096) this.buf = '';
  }

  static checksumOk(line: string): boolean {
    const star = line.indexOf('*');
    if (star < 0) return true;
    let cs = 0;
    for (let i = 1; i < star; i++) cs ^= line.charCodeAt(i);
    return cs === parseInt(line.slice(star + 1, star + 3), 16);
  }

  private line(line: string) {
    if (!NmeaParser.checksumOk(line)) return;
    const body = line.split('*')[0];
    const f = body.split(',');
    const type = f[0].slice(3);
    switch (type) {
      case 'GGA': {
        const lat = coord(f[2], f[3]), lon = coord(f[4], f[5]);
        const q = parseInt(f[6] || '0', 10);
        const fixMap: Record<number, FixType> = { 0: 'none', 1: 'gps', 2: 'dgps', 4: 'rtk-fixed', 5: 'rtk-float', 6: 'estimated' };
        this.state.fixType = fixMap[q] ?? 'gps';
        this.state.satellites = parseInt(f[7] || '0', 10);
        this.state.hdop = parseFloat(f[8]) || undefined;
        this.state.alt = f[9] ? parseFloat(f[9]) : undefined;
        if (lat !== null && lon !== null && q > 0) {
          this.state.lat = lat; this.state.lon = lon;
          this.emit();
        }
        break;
      }
      case 'RMC': {
        if (f[2] !== 'A') break;
        const sp = parseFloat(f[7]);
        if (Number.isFinite(sp)) this.state.speed = sp * 0.514444;
        const hd = parseFloat(f[8]);
        if (Number.isFinite(hd)) this.state.heading = hd;
        break;
      }
      case 'VTG': {
        const hd = parseFloat(f[1]);
        if (Number.isFinite(hd)) this.state.heading = hd;
        const kmh = parseFloat(f[7]);
        if (Number.isFinite(kmh)) this.state.speed = kmh / 3.6;
        break;
      }
      case 'GSV': {
        const n = parseInt(f[3] || '0', 10);
        if (Number.isFinite(n)) this.state.satellitesInView = n;
        break;
      }
      case 'GST': {
        // f[6] lat sigma, f[7] lon sigma (m)
        const sl = parseFloat(f[6]), so = parseFloat(f[7]);
        if (Number.isFinite(sl) && Number.isFinite(so)) this.state.gstAcc = Math.hypot(sl, so);
        break;
      }
    }
  }

  private emit() {
    const s = this.state;
    if (s.lat === undefined || s.lon === undefined) return;
    // accuracy: prefer GST sigma, else HDOP × UERE by fix type
    const uere: Record<string, number> = { 'rtk-fixed': 0.02, 'rtk-float': 0.3, dgps: 1.0, gps: 3.0, estimated: 10, none: 50 };
    const acc = s.gstAcc ?? (s.hdop ?? 1.5) * (uere[s.fixType ?? 'gps'] ?? 3);
    this.onFix({
      lat: s.lat, lon: s.lon, alt: s.alt, accuracy: acc, heading: s.heading, speed: s.speed,
      satellites: s.satellites, satellitesInView: s.satellitesInView, hdop: s.hdop, fixType: s.fixType,
      source: this.source, time: Date.now(),
    });
  }
}

function coord(v: string, hemi: string): number | null {
  if (!v) return null;
  const dot = v.indexOf('.');
  const degLen = dot - 2;
  const deg = parseInt(v.slice(0, degLen), 10);
  const min = parseFloat(v.slice(degLen));
  let d = deg + min / 60;
  if (hemi === 'S' || hemi === 'W') d = -d;
  return Number.isFinite(d) ? d : null;
}
