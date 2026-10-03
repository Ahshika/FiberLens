import { useGps, type TrackPoint } from './gpsStore';
import type { GpsFix, GpsSource } from './types';
import { DeviceGpsSource, SerialNmeaSource, BleNmeaSource, SimulatorSource } from './sources';
import { geoToCad, cadToGeo, headingToCadAngle, isUsable, type Calibration } from '../geo/calibration';
import { app } from '../app/controller';
import { useApp } from '../app/store';
import type { Camera } from '../cad/render/camera';
import type { Vec2 } from '../cad/model/types';

export interface GpsPersistence {
  saveCalibration?: (c: Calibration) => Promise<void> | void;
  saveTrack?: (name: string, pts: TrackPoint[]) => Promise<void> | void;
  deleteCalibration?: () => Promise<void> | void;
}

/**
 * GPS → coordinate transformation → CAD marker. Owns the active source, follow/heading
 * modes, tracking and the navigation target, and draws "YOU ARE HERE" inside the drawing.
 */
class GpsController {
  source: GpsSource | null = null;
  persistence: GpsPersistence = {};
  private fixListeners = new Set<(f: GpsFix, cad: Vec2 | null) => void>();
  private orientationHandler: ((e: DeviceOrientationEvent) => void) | null = null;
  private lastHeadingCad: number | null = null;
  /** extra saved tracks to display */
  shownTracks: { name: string; pts: TrackPoint[] }[] = [];

  constructor() {
    app.gpsCadPosition = () => useGps.getState().cad;
    app.viewMountedHooks.push((view) => {
      view.addOverlay('gps', (ctx, cam) => this.draw(ctx, cam), 30);
    });
  }

  onFix(l: (f: GpsFix, cad: Vec2 | null) => void) { this.fixListeners.add(l); return () => this.fixListeners.delete(l); }

  makeSource(id: string): GpsSource {
    switch (id) {
      case 'serial': return new SerialNmeaSource(9600);
      case 'serial115': return new SerialNmeaSource(115200);
      case 'ble': return new BleNmeaSource();
      case 'sim': return new SimulatorSource(this.simulatorRoute());
      default: return new DeviceGpsSource();
    }
  }

  /** simulator route: along the selected polyline when calibrated, else around the drawing centre */
  simulatorRoute(): { lat: number; lon: number }[] {
    const cal = useGps.getState().calibration;
    const doc = app.doc;
    if (cal && isUsable(cal) && doc) {
      const sel = app.selection?.list ?? [];
      const pl = sel.map((id) => doc.get(id)).find((e) => e?.type === 'polyline' || e?.type === 'line') as any;
      let pts: Vec2[] = [];
      if (pl?.type === 'polyline') for (let i = 0; i < pl.pts.length; i += 2) pts.push({ x: pl.pts[i], y: pl.pts[i + 1] });
      else if (pl?.type === 'line') pts = [pl.p1, pl.p2];
      if (pts.length < 2) {
        const c = app.view ? { x: app.view.cam.cx, y: app.view.cam.cy } : { x: 0, y: 0 };
        const r = 60 * cal.unitsPerMeter;
        for (let k = 0; k <= 24; k++) pts.push({ x: c.x + Math.cos((k / 24) * Math.PI * 2) * r, y: c.y + Math.sin((k / 24) * Math.PI * 2) * r });
      }
      return pts.map((p) => cadToGeo(cal, p.x, p.y));
    }
    // default: a loop in Alexandria
    const c = { lat: 31.2156, lon: 29.9553 };
    return Array.from({ length: 25 }, (_, k) => ({ lat: c.lat + Math.sin((k / 24) * Math.PI * 2) * 0.0006, lon: c.lon + Math.cos((k / 24) * Math.PI * 2) * 0.0007 }));
  }

  async start(sourceId = useGps.getState().sourceId) {
    this.stop();
    const src = this.makeSource(sourceId);
    this.source = src;
    useGps.getState().set({ running: true, sourceId, error: null });
    this.startCompass();
    await src.start((f) => this.handleFix(f), (e) => {
      useGps.getState().set({ error: e });
      useApp.getState().toast('GPS: ' + e, 'error');
    });
  }

  stop() {
    this.source?.stop();
    this.source = null;
    this.stopCompass();
    useGps.getState().set({ running: false, follow: false });
    if (useGps.getState().headingUp) this.setHeadingUp(false);
  }

  setCalibration(cal: Calibration | null, persist = true) {
    const st = useGps.getState();
    st.set({ calibration: cal, calibrated: isUsable(cal) });
    if (st.fix) this.handleFix(st.fix);
    if (cal && persist) this.persistence.saveCalibration?.(cal);
    if (!cal && persist) this.persistence.deleteCalibration?.();
    app.view?.invalidateOverlay();
  }

  private handleFix(f: GpsFix) {
    const st = useGps.getState();
    const cal = st.calibration;
    let cad: Vec2 | null = null;
    if (isUsable(cal)) {
      try { cad = geoToCad(cal, f.lat, f.lon); } catch { cad = null; }
    }
    const patch: any = { fix: f, cad, fixCount: st.fixCount + 1 };
    if (st.tracking) {
      const last = st.track[st.track.length - 1];
      const moved = !last || Math.hypot((cad?.x ?? 0) - (last.x ?? 0), (cad?.y ?? 0) - (last.y ?? 0)) / (cal?.unitsPerMeter ?? 1) > 1 || !cad;
      if (moved || f.time - (last?.t ?? 0) > 15000) {
        patch.track = [...st.track, { t: f.time, lat: f.lat, lon: f.lon, x: cad?.x, y: cad?.y, acc: f.accuracy, alt: f.alt, spd: f.speed, hdg: f.heading }];
      }
    }
    st.set(patch);
    // heading in CAD
    const hdgDeg = f.speed !== undefined && f.speed > 0.7 && f.heading !== undefined ? f.heading : st.compass;
    this.lastHeadingCad = cal && hdgDeg !== null && hdgDeg !== undefined ? headingToCadAngle(cal, hdgDeg) : null;
    const view = app.view;
    if (view && cad) {
      if (st.follow) { view.cam.cx = cad.x; view.cam.cy = cad.y; }
      if (st.headingUp && this.lastHeadingCad !== null) view.cam.rotation = this.lastHeadingCad - Math.PI / 2;
      if (st.follow || st.headingUp) view.viewChanged();
      else view.invalidateOverlay();
    }
    for (const l of this.fixListeners) l(f, cad);
  }

  private startCompass() {
    if (this.orientationHandler) return;
    this.orientationHandler = (e: DeviceOrientationEvent) => {
      const anyE = e as any;
      let h: number | null = null;
      if (typeof anyE.webkitCompassHeading === 'number') h = anyE.webkitCompassHeading;
      else if (e.absolute && e.alpha !== null) h = (360 - e.alpha) % 360;
      if (h !== null) {
        const prev = useGps.getState().compass;
        if (prev === null || Math.abs(prev - h) > 2) {
          useGps.getState().set({ compass: h });
          const st = useGps.getState();
          if (st.calibration && (!st.fix?.speed || st.fix.speed < 0.7)) {
            this.lastHeadingCad = headingToCadAngle(st.calibration, h);
            if (st.headingUp && app.view) { app.view.cam.rotation = this.lastHeadingCad - Math.PI / 2; app.view.viewChanged(); }
            else app.view?.invalidateOverlay();
          }
        }
      }
    };
    window.addEventListener('deviceorientationabsolute' as any, this.orientationHandler as any);
    window.addEventListener('deviceorientation', this.orientationHandler);
  }

  private stopCompass() {
    if (!this.orientationHandler) return;
    window.removeEventListener('deviceorientationabsolute' as any, this.orientationHandler as any);
    window.removeEventListener('deviceorientation', this.orientationHandler);
    this.orientationHandler = null;
  }

  /** Locate me → Follow me → off */
  async locateOrFollow() {
    const st = useGps.getState();
    if (!st.running) {
      await this.start();
      useApp.getState().toast(st.calibrated ? 'Locating…' : 'GPS started. Calibrate the drawing (GPS → Calibrate) to see your position inside the CAD.', st.calibrated ? 'info' : 'error');
      useGps.getState().set({ follow: false });
      this.locateOnce();
      return;
    }
    if (!st.calibrated) { useApp.getState().set({ panel: 'calib' }); return; }
    if (!st.follow) { useGps.getState().set({ follow: true }); this.locate(); }
    else useGps.getState().set({ follow: false });
  }

  private locateOnce() {
    const off = this.onFix((_f, cad) => { if (cad) { this.locate(); off(); } });
    setTimeout(() => off(), 30000);
  }

  locate() {
    const { cad, calibration } = useGps.getState();
    const view = app.view;
    if (!cad || !view) return;
    const minScale = 2 / (calibration?.unitsPerMeter ?? 1); // ≥ 2 px per metre
    view.centerOn(cad.x, cad.y, Math.max(view.cam.scale, minScale));
  }

  setHeadingUp(on: boolean) {
    useGps.getState().set({ headingUp: on });
    const view = app.view;
    if (!view) return;
    if (on && this.lastHeadingCad !== null) view.cam.rotation = this.lastHeadingCad - Math.PI / 2;
    if (!on) {
      const cal = useGps.getState().calibration;
      view.cam.rotation = useGps.getState().northUp && cal ? cal.northAngle - Math.PI / 2 : 0;
    }
    view.viewChanged();
  }

  setNorthUp(on: boolean) {
    useGps.getState().set({ northUp: on, headingUp: false });
    const cal = useGps.getState().calibration;
    if (app.view) { app.view.cam.rotation = on && cal ? cal.northAngle - Math.PI / 2 : 0; app.view.viewChanged(); }
  }

  startTracking(name?: string) {
    useGps.getState().set({ tracking: true, track: [], trackName: name || `Track ${new Date().toLocaleString()}` });
    if (!useGps.getState().running) this.start();
  }

  async stopTracking(save = true) {
    const st = useGps.getState();
    st.set({ tracking: false });
    if (save && st.track.length > 1) {
      await this.persistence.saveTrack?.(st.trackName, st.track);
      useApp.getState().toast(`Track saved (${st.track.length} points)`, 'success');
    }
  }

  /** average the next n fixes (weighted by 1/accuracy²) — used for calibration control points */
  averageFix(n = 10, timeoutMs = 30000): Promise<GpsFix> {
    return new Promise((resolve, reject) => {
      const fixes: GpsFix[] = [];
      const done = () => {
        off(); clearTimeout(timer);
        if (!fixes.length) { reject(new Error('No GPS fix received')); return; }
        let w = 0, lat = 0, lon = 0, alt = 0;
        for (const f of fixes) { const k = 1 / Math.max(0.01, f.accuracy) ** 2; w += k; lat += f.lat * k; lon += f.lon * k; alt += (f.alt ?? 0) * k; }
        const best = Math.min(...fixes.map((f) => f.accuracy));
        resolve({ ...fixes[fixes.length - 1], lat: lat / w, lon: lon / w, alt: alt / w, accuracy: best / Math.sqrt(fixes.length) });
      };
      const off = this.onFix((f) => { fixes.push(f); if (fixes.length >= n) done(); });
      const timer = setTimeout(done, timeoutMs);
      if (!useGps.getState().running) this.start();
    });
  }

  setNavTarget(t: { name: string; x: number; y: number; id?: string } | null) {
    useGps.getState().set({ navTarget: t });
    app.view?.invalidateOverlay();
  }

  /** distance (m) and bearing (deg clockwise from north) from current position to a CAD point */
  navInfo(x: number, y: number): { dist: number; bearing: number; screenAngle: number } | null {
    const { cad, calibration } = useGps.getState();
    if (!cad || !calibration) return null;
    const dx = x - cad.x, dy = y - cad.y;
    const dist = Math.hypot(dx, dy) / calibration.unitsPerMeter;
    const cadAng = Math.atan2(dy, dx);
    let bearing = ((calibration.northAngle - cadAng) * 180) / Math.PI;
    bearing = ((bearing % 360) + 360) % 360;
    const screenAngle = cadAng - (app.view?.cam.rotation ?? 0);
    return { dist, bearing, screenAngle };
  }

  // ---------------- drawing ----------------
  private draw(ctx: CanvasRenderingContext2D, cam: Camera) {
    const st = useGps.getState();
    const upm = st.calibration?.unitsPerMeter ?? 1;
    // tracks
    const drawTrack = (pts: TrackPoint[], color: string) => {
      const xy = pts.filter((p) => p.x !== undefined);
      if (xy.length < 2) return;
      ctx.save();
      ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.globalAlpha = 0.85;
      ctx.beginPath();
      xy.forEach((p, i) => { const s = cam.worldToScreen(p.x!, p.y!); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); });
      ctx.stroke();
      ctx.restore();
    };
    for (const t of this.shownTracks) drawTrack(t.pts, '#b06cff');
    if (st.track.length) drawTrack(st.track, '#ff4fa0');
    // navigation line
    if (st.navTarget && st.cad) {
      const a = cam.worldToScreen(st.cad.x, st.cad.y), b = cam.worldToScreen(st.navTarget.x, st.navTarget.y);
      ctx.save();
      ctx.strokeStyle = '#0b5cff'; ctx.lineWidth = 3; ctx.setLineDash([10, 6]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#0b5cff';
      ctx.beginPath(); ctx.arc(b.x, b.y, 8, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      ctx.restore();
    }
    if (!st.cad) return;
    const s = cam.worldToScreen(st.cad.x, st.cad.y);
    const accPx = (st.fix?.accuracy ?? 0) * upm * cam.scale;
    ctx.save();
    // accuracy circle
    if (accPx > 6) {
      ctx.fillStyle = 'rgba(46,140,255,0.13)';
      ctx.strokeStyle = 'rgba(46,140,255,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(s.x, s.y, Math.min(accPx, 4000), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    // heading wedge
    if (this.lastHeadingCad !== null) {
      const ang = -(this.lastHeadingCad - cam.rotation);
      const grd = ctx.createRadialGradient(s.x, s.y, 4, s.x, s.y, 60);
      grd.addColorStop(0, 'rgba(46,140,255,0.55)'); grd.addColorStop(1, 'rgba(46,140,255,0)');
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.arc(s.x, s.y, 60, ang - 0.45, ang + 0.45); ctx.closePath(); ctx.fill();
    }
    // dot
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 6;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(s.x, s.y, 11, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    const stale = st.fix ? Date.now() - st.fix.time > 10000 : true;
    ctx.fillStyle = stale ? '#8a96a8' : '#1a73ff';
    ctx.beginPath(); ctx.arc(s.x, s.y, 7.5, 0, Math.PI * 2); ctx.fill();
    // label
    const label = '📍 YOU ARE HERE';
    ctx.font = 'bold 12px system-ui, sans-serif';
    const w = ctx.measureText(label).width + 14;
    ctx.fillStyle = 'rgba(26,115,255,0.95)';
    const lx = s.x - w / 2, ly = s.y - 44;
    ctx.beginPath();
    (ctx as any).roundRect ? (ctx as any).roundRect(lx, ly, w, 22, 11) : ctx.rect(lx, ly, w, 22);
    ctx.fill();
    ctx.beginPath(); ctx.moveTo(s.x - 6, ly + 22); ctx.lineTo(s.x + 6, ly + 22); ctx.lineTo(s.x, ly + 29); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, s.x, ly + 11);
    ctx.restore();
  }
}

export const gpsController = new GpsController();
