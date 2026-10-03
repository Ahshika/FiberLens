import React, { useEffect, useState } from 'react';
import { useGps } from '../../gps/gpsStore';
import { gpsController } from '../../gps/controller';
import { useApp } from '../../app/store';
import { app } from '../../app/controller';
import { Icon } from '../icons';
import { fmt } from '../common';
import { Tool, type ToolEvent } from '../../cad/tools/types';
import { extraTools } from '../../cad/tools/registry';
import { newCalibration, solveCalibration, cadToGeo, geoToCad, minPointsFor, type Calibration, type ControlPoint } from '../../geo/calibration';
import { listCrs, detectCrs, getCrs, utmZoneFor, registerCustomCrs } from '../../geo/crs';
import type { Vec2 } from '../../cad/model/types';
import { db, uid, type TrackRow } from '../../data/db';
import { currentProjectId } from '../../data/projects';
import { ask, confirmDialog } from '../../app/dialogs';
import { can } from '../../auth/session';
import { downloadText } from '../../reports/download';
import { tracksToGpx } from '../../reports/geoExport';
import { isPhone } from '../useDevice';
import { useT } from '../../app/i18n';

/** One-shot point picker used by the calibration wizard and other modules. */
export class PickPointTool extends Tool {
  readonly id = 'pickpoint'; readonly label = 'Pick point';
  static pending: { prompt: string; cb: (p: Vec2) => void } | null = null;
  protected onActivate() { this.setPrompt(PickPointTool.pending?.prompt ?? 'Pick a point'); }
  click(e: ToolEvent) {
    const p = PickPointTool.pending;
    PickPointTool.pending = null;
    this.host.finish();
    p?.cb(e.p);
  }
  overlay(ctx: CanvasRenderingContext2D, cam: any) {
    if (!this.cursor) return;
    const s = cam.worldToScreen(this.cursor.x, this.cursor.y);
    ctx.save(); ctx.strokeStyle = '#ff3b6b'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(s.x, s.y, 12, 0, Math.PI * 2); ctx.moveTo(s.x - 20, s.y); ctx.lineTo(s.x + 20, s.y); ctx.moveTo(s.x, s.y - 20); ctx.lineTo(s.x, s.y + 20); ctx.stroke(); ctx.restore();
  }
}
extraTools.push({ id: 'pickpoint', make: () => new PickPointTool() });

export function pickPoint(prompt: string): Promise<Vec2> {
  return new Promise((resolve) => {
    // on phones the sheet would hide the drawing: minimise it while picking
    if (isPhone()) useApp.getState().set({ sheet: 'min' });
    PickPointTool.pending = { prompt, cb: (p) => { if (isPhone()) useApp.getState().set({ sheet: 'half' }); resolve(p); } };
    app.setTool('pickpoint');
  });
}

const SOURCES = [
  { id: 'device', label: 'Phone GNSS (incl. external receivers via mock location)', icon: 'satellite' },
  { id: 'bt-spp', label: 'External GNSS / RTK · Bluetooth (Android app)', icon: 'bluetooth' },
  { id: 'serial', label: 'External GNSS · USB/Serial 9600', icon: 'usb' },
  { id: 'serial115', label: 'External GNSS · USB/Serial 115200 (RTK)', icon: 'usb' },
  { id: 'ble', label: 'External GNSS · Bluetooth LE', icon: 'bluetooth' },
  { id: 'sim', label: 'Simulator (walk the selected polyline)', icon: 'play' },
];

export function GpsPanel() {
  const g = useGps();
  const t = useT();
  const [tracks, setTracks] = useState<TrackRow[]>([]);
  const pid = currentProjectId();
  const loadTracks = () => { if (pid) db.tracks.where('projectId').equals(pid).reverse().sortBy('startedAt').then(setTracks); };
  useEffect(loadTracks, [pid, g.tracking]);
  const f = g.fix;
  const autoDetect = async () => {
    if (!f) { useApp.getState().toast('Wait for a GPS fix first', 'error'); return; }
    const d = app.doc!.drawing.meta;
    const c = detectCrs({ minX: d.extMin.x, minY: d.extMin.y, maxX: d.extMax.x, maxY: d.extMax.y }, f.lon, f.lat);
    const inside = c.filter((x) => x.inside);
    if (!inside.length) {
      useApp.getState().toast('The drawing does not appear to be in a known projected CRS here. Use the Calibration Wizard with control points.', 'error');
      useApp.getState().set({ panel: 'calib' });
      return;
    }
    const best = inside[0];
    const ok = await confirmDialog('CRS detected', `Your position falls inside the drawing when interpreted as:\n\n${best.name} (${best.crs})\n\nDistance from drawing centre: ${fmt(best.distance, 0)} m.\n\nUse it? You can refine with control points later.`, false, 'Use this CRS');
    if (!ok) return;
    const cal = solveCalibration({ ...newCalibration(best.crs, 'crs'), source: 'auto-detect', method: 'translation' });
    gpsController.setCalibration(cal);
    gpsController.locate();
  };
  return (
    <div>
      <div className="card">
        <div className="row" style={{ marginBottom: 6 }}>
          <span className={`gps-dot ${g.running ? (f ? (f.accuracy <= 5 ? 'ok' : 'warn') : 'warn') : ''}`} />
          <b className="grow">{g.running ? (f ? `Fix · ${f.source}` : 'Searching for satellites…') : 'GPS stopped'}</b>
          {g.running ? <button className="btn sm danger" onClick={() => gpsController.stop()}><Icon name="stop" />Stop</button>
            : <button className="btn sm primary" onClick={() => gpsController.start()}><Icon name="play" />Start</button>}
        </div>
        <div className="kv mono small">
          <div>Latitude</div><div>{f ? f.lat.toFixed(8) : '—'}</div>
          <div>Longitude</div><div>{f ? f.lon.toFixed(8) : '—'}</div>
          <div>CAD X / Y</div><div>{g.cad ? `${fmt(g.cad.x, 3)} / ${fmt(g.cad.y, 3)}` : g.calibrated ? '—' : 'not calibrated'}</div>
          <div>Accuracy</div><div>{f ? `± ${f.accuracy.toFixed(2)} m` : '—'}{f?.fixType ? ` (${f.fixType})` : ''}</div>
          <div>Altitude</div><div>{f?.alt !== undefined ? `${f.alt.toFixed(1)} m` : '—'}</div>
          <div>Heading</div><div>{f?.heading !== undefined ? `${f.heading.toFixed(0)}°` : g.compass !== null ? `${g.compass.toFixed(0)}° (compass)` : '—'}</div>
          <div>Speed</div><div>{f?.speed !== undefined ? `${(f.speed * 3.6).toFixed(1)} km/h` : '—'}</div>
          <div>Satellites</div><div>{f?.satellites !== undefined ? `${f.satellites} used${f.satellitesInView ? ` / ${f.satellitesInView} in view` : ''}` : 'n/a (phone API)'}</div>
          <div>HDOP</div><div>{f?.hdop ?? '—'}</div>
        </div>
        {g.error && <div className="badge err" style={{ marginTop: 6, whiteSpace: 'normal' }}>{g.error}</div>}
      </div>

      <div className="section">Source</div>
      <select value={g.sourceId} onChange={(e) => { g.set({ sourceId: e.target.value }); if (g.running) gpsController.start(e.target.value); }} style={{ width: '100%' }}>
        {SOURCES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>

      <div className="section">Modes</div>
      <div className="grid2">
        <button className="btn" onClick={() => { if (!g.running) gpsController.start(); gpsController.locate(); }}><Icon name="locate" />{t('Locate me')}</button>
        <button className={`btn ${g.follow ? 'primary' : ''}`} onClick={() => { if (!g.running) gpsController.start(); g.set({ follow: !g.follow }); gpsController.locate(); }}><Icon name="follow" />{t('Follow me')}</button>
        <button className={`btn ${!g.headingUp && g.northUp ? 'primary' : ''}`} onClick={() => gpsController.setNorthUp(!g.northUp)}><Icon name="north" />{t('North up')}</button>
        <button className={`btn ${g.headingUp ? 'primary' : ''}`} onClick={() => gpsController.setHeadingUp(!g.headingUp)}><Icon name="navigate" />{t('Heading up')}</button>
      </div>

      <div className="section">Georeference</div>
      <div className="card">
        {g.calibration ? (
          <div className="kv small">
            <div>Mode</div><div>{g.calibration.mode === 'crs' ? 'Drawing in projected CRS' : 'Control points'}</div>
            <div>CRS</div><div>{getCrs(g.calibration.crs)?.name ?? g.calibration.crs}</div>
            <div>Points</div><div>{g.calibration.points.filter((p) => p.enabled).length}</div>
            <div>RMS error</div><div>{g.calibration.points.length ? `${g.calibration.rms.toFixed(3)} du` : '—'}</div>
            <div>Scale</div><div>{g.calibration.unitsPerMeter.toFixed(6)} du/m</div>
            <div>Source</div><div>{g.calibration.source}</div>
          </div>
        ) : <div className="small muted">Not calibrated — your position cannot be shown inside the drawing yet.</div>}
        <div className="row wrap" style={{ marginTop: 8 }}>
          <button className="btn sm primary" disabled={!can('calibrate')} onClick={() => useApp.getState().set({ panel: 'calib' })}><Icon name="calibrate" />Calibration wizard</button>
          <button className="btn sm" disabled={!can('calibrate')} onClick={autoDetect}>Auto-detect CRS</button>
        </div>
      </div>

      <div className="section">Tracking</div>
      <div className="row wrap">
        {!g.tracking ? <button className="btn" onClick={async () => { const r = await ask('Start tracking', [{ key: 'name', label: 'Session name', value: `Track ${new Date().toLocaleString()}` }]); if (r) gpsController.startTracking(r.name); }}><Icon name="track" />Start tracking</button>
          : <>
            <button className="btn primary" onClick={() => gpsController.stopTracking(true)}><Icon name="save" />Stop & save ({g.track.length} pts)</button>
            <button className="btn danger" onClick={() => gpsController.stopTracking(false)}>Discard</button>
          </>}
      </div>
      {tracks.length > 0 && (
        <div className="list" style={{ marginTop: 8 }}>
          {tracks.map((t) => {
            const shown = gpsController.shownTracks.some((s) => s.name === t.id);
            return (
              <div key={t.id} className="list-item">
                <Icon name="track" />
                <div className="grow"><div>{t.name}</div><div className="small muted">{t.points.length} pts · {fmt(t.length, 1)} m · {new Date(t.startedAt).toLocaleString()}</div></div>
                <button className={`btn sm ${shown ? 'primary' : ''}`} onClick={() => {
                  if (shown) gpsController.shownTracks = gpsController.shownTracks.filter((s) => s.name !== t.id);
                  else {
                    const cal = useGps.getState().calibration;
                    const pts = t.points.map((p) => (cal ? { ...p, ...geoToCad(cal, p.lat, p.lon) } : p));
                    gpsController.shownTracks = [...gpsController.shownTracks, { name: t.id, pts }];
                  }
                  app.view?.invalidateOverlay(); setTracks([...tracks]);
                }}>{shown ? 'Hide' : 'Show'}</button>
                <button className="btn sm" onClick={() => downloadText(`${t.name}.gpx`, tracksToGpx([t]), 'application/gpx+xml')}>GPX</button>
                <button className="icon-btn" onClick={async () => { if (await confirmDialog('Delete track', t.name, true, 'Delete')) { await db.tracks.delete(t.id); loadTracks(); } }}><Icon name="trash" /></button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function CalibrationPanel() {
  const g = useGps();
  const [cal, setCal] = useState<Calibration>(() => g.calibration ? structuredClone(g.calibration) : newCalibration('auto', 'points'));
  const [step, setStep] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [pendingCad, setPendingCad] = useState<Vec2 | null>(null);
  const crsList = listCrs();
  const solved = (() => { try { return solveCalibration(cal); } catch (e) { return { ...cal, error: (e as Error).message } as any; } })();
  const need = minPointsFor(cal.method);
  const enabled = cal.points.filter((p) => p.enabled).length;

  useEffect(() => {
    // show control points on the drawing while the wizard is open
    app.view?.addOverlay('calib', (ctx, cam) => {
      for (const p of solved.points as ControlPoint[]) {
        const s = cam.worldToScreen(p.cad.x, p.cad.y);
        ctx.save();
        ctx.fillStyle = p.enabled ? '#ff3b6b' : '#888';
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - 8, s.y - 16); ctx.lineTo(s.x + 8, s.y - 16); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.font = 'bold 12px system-ui'; ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
        const lbl = `${p.name}${p.residual !== undefined ? ` (${p.residual.toFixed(2)})` : ''}`;
        ctx.strokeText(lbl, s.x + 10, s.y - 18); ctx.fillText(lbl, s.x + 10, s.y - 18);
        ctx.restore();
      }
      if (pendingCad) { const s = cam.worldToScreen(pendingCad.x, pendingCad.y); ctx.save(); ctx.strokeStyle = '#ffd400'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(s.x, s.y, 10, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); }
    }, 25);
    return () => app.view?.removeOverlay('calib');
  }, [solved, pendingCad]);

  const pickCad = async () => {
    setStep('2. Tap the control point in the drawing (snaps to corners, block insertion points…)');
    const p = await pickPoint('Calibration: tap the CAD point you are standing on / know the coordinates of');
    setPendingCad(p);
    setStep('3. Obtain the real-world position for this point');
  };
  const addWithGeo = (lat: number, lon: number, accuracy?: number) => {
    if (!pendingCad) return;
    const n = cal.points.length + 1;
    const pt: ControlPoint = { id: uid(), name: `P${n}`, cad: pendingCad, lat, lon, accuracy, enabled: true };
    const next = { ...cal, points: [...cal.points, pt] };
    if ((next.crs === 'auto' || !next.crs) && next.mode === 'points') next.crs = utmZoneFor(lon, lat);
    setCal(next);
    setPendingCad(null);
    setStep(`Point ${pt.name} added. ${next.points.length < need ? `Add ${need - next.points.length} more.` : 'Add more points to improve accuracy, or Save.'}`);
  };
  const useGpsNow = async () => {
    setBusy(true);
    try {
      setStep('Averaging GPS fixes — stand still on the point…');
      const f = await gpsController.averageFix(10, 25000);
      addWithGeo(f.lat, f.lon, f.accuracy);
    } catch (e) { useApp.getState().toast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  const typeGeo = async () => {
    const r = await ask('Real-world coordinates', [
      { key: 'lat', label: 'Latitude (decimal degrees) — or leave empty and use X/Y below', value: '' },
      { key: 'lon', label: 'Longitude (decimal degrees)', value: '' },
      { key: 'x', label: `…or projected X (${getCrs(cal.crs)?.name ?? 'CRS'})`, value: '' },
      { key: 'y', label: '…projected Y', value: '' },
    ]);
    if (!r) return;
    if (r.lat && r.lon) return addWithGeo(parseFloat(r.lat), parseFloat(r.lon));
    if (r.x && r.y && cal.crs && cal.crs !== 'auto') {
      const { unproject } = await import('../../geo/crs');
      const g2 = unproject(cal.crs, parseFloat(r.x), parseFloat(r.y));
      return addWithGeo(g2.lat, g2.lon);
    }
    useApp.getState().toast('Enter lat/lon, or select a CRS and enter X/Y', 'error');
  };
  const save = () => {
    const s = solveCalibration(cal);
    gpsController.setCalibration(s);
    useApp.getState().toast(`Calibration saved · RMS ${s.rms.toFixed(3)} du · GPS enabled inside CAD`, 'success');
    if (!useGps.getState().running) gpsController.start();
  };

  return (
    <div>
      <div className="card small" style={{ marginBottom: 10 }}>
        <b>How it works:</b> 1 open drawing → 2 tap a CAD point → 3 capture GPS (or type coordinates) → 4 add → 5 repeat (Helmert ≥ 2, affine ≥ 3) → 6 compute → 7 check residuals → 8 save → 9 your position appears inside the DWG.
      </div>
      <div className="grid2">
        <div className="field"><label>Mode</label>
          <select value={cal.mode} onChange={(e) => setCal({ ...cal, mode: e.target.value as any, method: e.target.value === 'crs' ? 'translation' : 'helmert' })}>
            <option value="points">Control points (any drawing)</option>
            <option value="crs">Drawing already in a projected CRS</option>
          </select>
        </div>
        <div className="field"><label>Method</label>
          <select value={cal.method} onChange={(e) => setCal({ ...cal, method: e.target.value as any })}>
            <option value="translation">Translation (1+ pts)</option>
            <option value="helmert">Helmert: shift+rotate+scale (2+)</option>
            <option value="affine">Affine (3+)</option>
          </select>
        </div>
      </div>
      <div className="field"><label>Coordinate reference system {cal.mode === 'points' ? '(working projection)' : '(of the drawing)'}</label>
        <select value={cal.crs} onChange={async (e) => {
          if (e.target.value === '__custom') {
            const r = await ask('Custom CRS', [{ key: 'p', label: 'proj4 definition', value: '+proj=tmerc +lat_0=0 +lon_0=33 +k=0.9996 +x_0=500000 +y_0=0 +datum=WGS84 +units=m' }]);
            if (r?.p) setCal({ ...cal, crs: registerCustomCrs(r.p) });
            return;
          }
          setCal({ ...cal, crs: e.target.value });
        }}>
          {cal.mode === 'points' && <option value="auto">Auto (UTM zone of first point)</option>}
          {['Egypt', 'UTM North', 'Middle East', 'Global', 'Custom', 'UTM South'].map((grp) => (
            <optgroup key={grp} label={grp}>{crsList.filter((c) => c.group === grp).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
          ))}
          <option value="__custom">Custom proj4…</option>
        </select>
      </div>

      <div className="section">Control points ({cal.points.length})</div>
      {cal.points.length === 0 && <div className="small muted">No points yet.</div>}
      <div className="list">
        {(solved.points as ControlPoint[]).map((p, i) => (
          <div key={p.id} className="list-item" style={{ cursor: 'default' }}>
            <input type="checkbox" checked={p.enabled} onChange={(e) => setCal({ ...cal, points: cal.points.map((x) => (x.id === p.id ? { ...x, enabled: e.target.checked } : x)) })} />
            <div className="grow small mono">
              <b>{p.name}</b> CAD {fmt(p.cad.x, 2)}, {fmt(p.cad.y, 2)}<br />GPS {p.lat.toFixed(7)}, {p.lon.toFixed(7)}{p.accuracy ? ` ±${p.accuracy.toFixed(1)}m` : ''}
            </div>
            {p.residual !== undefined && <span className={`badge ${p.residual < 1 * (solved.unitsPerMeter || 1) ? 'ok' : p.residual < 3 * (solved.unitsPerMeter || 1) ? 'warn' : 'err'}`}>{p.residual.toFixed(2)}</span>}
            <button className="icon-btn" onClick={() => app.view?.centerOn(p.cad.x, p.cad.y)}><Icon name="zoomin" /></button>
            <button className="icon-btn" onClick={() => setCal({ ...cal, points: cal.points.filter((_, k) => k !== i) })}><Icon name="trash" /></button>
          </div>
        ))}
      </div>

      <div className="section">Add control point</div>
      {step && <div className="badge info" style={{ whiteSpace: 'normal', marginBottom: 8 }}>{step}</div>}
      {!pendingCad ? (
        <button className="btn primary" onClick={pickCad}><Icon name="pin" />Pick CAD point</button>
      ) : (
        <div className="row wrap">
          <button className="btn primary" disabled={busy} onClick={useGpsNow}><Icon name="satellite" />{busy ? 'Averaging…' : 'Use my GPS position (avg)'}</button>
          <button className="btn" onClick={typeGeo}>Type coordinates…</button>
          <button className="btn" onClick={() => setPendingCad(null)}>Cancel</button>
        </div>
      )}

      <div className="section">Result</div>
      <div className="card small">
        {solved.error ? <span className="badge err">{solved.error}</span> : (
          <div className="kv">
            <div>Status</div><div>{cal.mode === 'crs' || enabled >= need ? <span className="badge ok">Ready</span> : <span className="badge warn">Need {need - enabled} more point(s)</span>}</div>
            <div>Method used</div><div>{solved.method}</div>
            <div>RMS error</div><div>{enabled ? `${solved.rms.toFixed(3)} du (≈ ${(solved.rms / (solved.unitsPerMeter || 1)).toFixed(2)} m)` : '—'}</div>
            <div>Scale</div><div>{solved.unitsPerMeter.toFixed(6)} du per metre</div>
            <div>Grid north</div><div>{((solved.northAngle * 180) / Math.PI).toFixed(3)}° from +X</div>
            {enabled > 0 && <><div>Check</div><div className="mono">{(() => { const p = solved.points.find((x: ControlPoint) => x.enabled); if (!p) return ''; const gg = cadToGeo(solved, p.cad.x, p.cad.y); return `${p.name} → ${gg.lat.toFixed(7)}, ${gg.lon.toFixed(7)}`; })()}</div></>}
          </div>
        )}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary grow" disabled={!!solved.error || (cal.mode === 'points' && enabled < need)} onClick={save}><Icon name="check" />Save calibration & enable GPS</button>
      </div>
      {g.calibration && <button className="btn sm danger" style={{ marginTop: 8 }} onClick={async () => { if (await confirmDialog('Remove calibration', 'Remove the georeference of this drawing?', true)) { gpsController.setCalibration(null); setCal(newCalibration('auto', 'points')); } }}>Remove calibration</button>}
    </div>
  );
}
