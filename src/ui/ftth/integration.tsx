import React, { useEffect, useState } from 'react';
import { registerSearchProvider, matchScore, type SearchHit } from '../../app/search';
import { registerInfoExtension } from '../infoExtensions';
import { useFtth, ftthForEntity, getObject, getCable, linkedEntity, nearestObjects } from '../../ftth/store';
import { cableTypeLabel, kindMeta } from '../../ftth/model';
import { openCard, runTrace } from './ftthUi';
import { ObjectCard } from './FtthPanel';
import { db } from '../../data/db';
import { currentProjectId } from '../../data/projects';
import { app } from '../../app/controller';
import { useGps } from '../../gps/gpsStore';
import { gpsController } from '../../gps/controller';
import { useField } from '../../field/fieldData';
import { Icon } from '../icons';
import { fmt } from '../common';

// ---------- search: FTTH objects, cables, cores, splitters, notes ----------
registerSearchProvider('ftth', async (q) => {
  const s = useFtth.getState();
  const hits: SearchHit[] = [];
  for (const o of s.objects.values()) {
    const sc = Math.max(matchScore(o.code, q), matchScore(o.name ?? '', q) - 10, ...Object.values(o.props).map((v) => (typeof v === 'string' ? matchScore(v, q) - 15 : 0)));
    if (sc > 0) hits.push({ key: 'o' + o.id, title: o.code, subtitle: `${o.kind}${o.name ? ' · ' + o.name : ''} · ${o.status}`, kind: o.kind === 'Customer' ? 'Customer' : 'FTTH', entityIds: [], score: sc + 10, open: () => openCard({ type: 'object', id: o.id }) });
  }
  for (const c of s.cables.values()) {
    const sc = matchScore(c.code, q);
    if (sc > 0) hits.push({ key: 'c' + c.id, title: c.code, subtitle: `${cableTypeLabel(c.category, c.fiberCount)} · ${fmt(c.length, 1)} m · ${getObject(c.fromId)?.code ?? '?'} → ${getObject(c.toId)?.code ?? '?'}`, kind: 'Cable', entityIds: [], score: sc + 10, open: () => openCard({ type: 'cable', id: c.id }) });
  }
  for (const sp of s.splitters.values()) {
    const sc = matchScore(sp.code, q);
    if (sc > 0) hits.push({ key: 's' + sp.id, title: sp.code, subtitle: `Splitter 1:${sp.ratio}`, kind: 'Splitter', entityIds: [], score: sc + 5, open: () => openCard({ type: 'splitter', id: sp.id }, false) });
  }
  const pid = currentProjectId();
  if (pid && q.length >= 2) {
    // fibre cores: "F-0245/12" or "F-0245#12" or by assignment label
    const m = /^(.+?)[#/:\s]+(\d{1,4})$/.exec(q.trim());
    if (m) {
      const cab = [...s.cables.values()].find((c) => c.code.toLowerCase() === m[1].toLowerCase());
      if (cab) hits.push({ key: `core${cab.id}${m[2]}`, title: `${cab.code} core ${m[2]}`, subtitle: 'Fibre core', kind: 'Core', entityIds: [], score: 95, open: () => openCard({ type: 'cable', id: cab.id }) });
    }
    const cores = await db.cores.where('projectId').equals(pid).filter((c) => !!c.assignLabel && matchScore(c.assignLabel, q) > 0).limit(20).toArray();
    for (const c of cores) hits.push({ key: `core${c.cableId}${c.index}`, title: `${getCable(c.cableId)?.code} #${c.index} → ${c.assignLabel}`, subtitle: `Core ${c.color} · ${c.status}`, kind: 'Core', entityIds: [], score: matchScore(c.assignLabel!, q), open: () => openCard({ type: 'cable', id: c.cableId }) });
    const notes = await db.notes.where('projectId').equals(pid).filter((n) => matchScore(`${n.title} ${n.text} ${n.objectCode ?? ''}`, q) > 0).limit(20).toArray();
    for (const n of notes) hits.push({ key: 'n' + n.id, title: n.title, subtitle: `Note · ${n.status}${n.objectCode ? ' · ' + n.objectCode : ''}`, kind: 'Note', entityIds: [], x: n.x, y: n.y, score: 30 });
  }
  return hits;
});

// ---------- info card: FTTH section for tapped CAD entities ----------
registerInfoExtension(function FtthInfo({ entityId }) {
  useFtth((s) => s.rev);
  const link = ftthForEntity(entityId);
  if (!link) {
    return (
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn sm" onClick={() => app.setTool('ftth-link')}><Icon name="join" />Make smart FTTH object</button>
      </div>
    );
  }
  if (link.kind === 'object') return <div style={{ marginTop: 8, borderTop: '1px solid var(--line)', paddingTop: 8 }}><ObjectCard id={link.id} compact /><button className="btn sm" style={{ marginTop: 6 }} onClick={() => openCard({ type: 'object', id: link.id }, false)}>Full details…</button></div>;
  const c = getCable(link.id)!;
  return (
    <div style={{ marginTop: 8, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
      <div className="row"><Icon name="cable" /><b className="grow">Cable {c.code}</b><span className="badge">{c.status}</span></div>
      <div className="kv small">
        <div>Type</div><div>{cableTypeLabel(c.category, c.fiberCount)}</div>
        <div>Length</div><div>{fmt(c.length + c.slack, 2)} m</div>
        <div>From → To</div><div>{getObject(c.fromId)?.code ?? '?'} → {getObject(c.toId)?.code ?? '?'}</div>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <button className="btn sm primary" onClick={() => openCard({ type: 'cable', id: c.id }, false)}>Cores & details…</button>
        {c.toId && <button className="btn sm" onClick={() => runTrace(c.toId!, 'up')}>Trace</button>}
      </div>
    </div>
  );
});

// ---------- map pins for notes / photos / survey items ----------
interface Pin { x: number; y: number; kind: 'note' | 'photo' | 'survey'; status?: string }
let pins: Pin[] = [];
async function loadPins() {
  const pid = currentProjectId();
  if (!pid) { pins = []; return; }
  const [notes, photos, items] = await Promise.all([
    db.notes.where('projectId').equals(pid).toArray(),
    db.photos.where('projectId').equals(pid).toArray(),
    db.surveyItems.where('projectId').equals(pid).toArray(),
  ]);
  pins = [
    ...notes.filter((n) => n.x !== undefined).map((n) => ({ x: n.x!, y: n.y!, kind: 'note' as const, status: n.status })),
    ...photos.filter((p) => p.x !== undefined && !p.objectId).map((p) => ({ x: p.x!, y: p.y!, kind: 'photo' as const })),
    ...items.filter((i) => i.x !== undefined && !['note', 'photo'].includes(i.kind)).map((i) => ({ x: i.x!, y: i.y!, kind: 'survey' as const, status: i.kind })),
  ];
  app.view?.invalidateOverlay();
}
useField.subscribe(() => loadPins());
app.viewMountedHooks.push((view) => view.addOverlay('field', (ctx, cam) => {
  const vb = cam.viewBox(20);
  ctx.save();
  for (const p of pins) {
    if (p.x < vb.minX || p.x > vb.maxX || p.y < vb.minY || p.y > vb.maxY) continue;
    const s = cam.worldToScreen(p.x, p.y);
    const color = p.kind === 'note' ? (p.status === 'resolved' ? '#30d158' : p.status === 'pending' ? '#ffb000' : '#ff3b30') : p.kind === 'photo' ? '#64d2ff' : '#bf5af2';
    ctx.fillStyle = color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.bezierCurveTo(s.x - 9, s.y - 12, s.x - 7, s.y - 22, s.x, s.y - 22); ctx.bezierCurveTo(s.x + 7, s.y - 22, s.x + 9, s.y - 12, s.x, s.y); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(p.kind === 'note' ? '!' : p.kind === 'photo' ? '◉' : '•', s.x, s.y - 12);
  }
  ctx.restore();
}, 22));

// ---------- navigation HUD (direction + distance over the CAD) ----------
export function NavHud() {
  const g = useGps();
  useFtth((s) => s.rev);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const upm = app.unitsPerMeter();
  if (g.navTarget && g.cad) {
    const info = gpsController.navInfo(g.navTarget.x, g.navTarget.y);
    if (!info) return null;
    const arrived = info.dist < Math.max(3, (g.fix?.accuracy ?? 5));
    return (
      <div className="nav-hud">
        <svg viewBox="0 0 24 24" className="arrow" style={{ transform: `rotate(${-info.screenAngle * 180 / Math.PI + 90}deg)` }}><path d="M12 2l7 18-7-4-7 4 7-18z" fill="#fff" /></svg>
        <div><div style={{ fontSize: 12, opacity: 0.85 }}>Navigate to {g.navTarget.name}</div><div style={{ fontSize: 20 }}>{arrived ? 'Arrived ✓' : `${fmt(info.dist, info.dist < 100 ? 1 : 0)} m`} <span style={{ fontSize: 12, opacity: 0.85 }}>{Math.round(info.bearing)}°</span></div></div>
        {g.navTarget.id && <button className="btn sm" onClick={() => openCard({ type: 'object', id: g.navTarget!.id! }, false)}>Info</button>}
        <button className="btn sm" onClick={() => gpsController.setNavTarget(null)}>✕</button>
      </div>
    );
  }
  if (g.cad && g.running) {
    const n = nearestObjects(g.cad, 1, (o) => !['Building', 'Manhole', 'Handhole', 'Pole'].includes(o.kind))[0];
    if (!n || n.d / upm > 300) return null;
    return (
      <div className="nav-hud" style={{ background: 'rgba(22,27,34,0.92)', border: '1px solid var(--line)', fontWeight: 500 }} onClick={() => openCard({ type: 'object', id: n.o.id })}>
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: kindMeta(n.o.kind).color }} />
        <div><div style={{ fontSize: 11, opacity: 0.8 }}>📍 Nearest FTTH object</div><div><b>{n.o.code}</b> {n.o.kind} · {fmt(n.d / upm, 1)} m</div></div>
        <button className="btn sm primary" onClick={(e) => { e.stopPropagation(); gpsController.setNavTarget({ name: n.o.code, x: n.o.cad.x, y: n.o.cad.y, id: n.o.id }); }}><Icon name="navigate" />Navigate</button>
      </div>
    );
  }
  return null;
}

export { linkedEntity };

// ---------- native: QR deep links & back button ----------
import { installNativeHandlers } from '../../platform/native';
import { openFromQr, parseQr } from './OutputPanels';
import { openProject } from '../../data/projects';
import { useApp } from '../../app/store';
installNativeHandlers({
  onUrl: async (url) => {
    // a drawing handed over by another app ("Open in FiberLens" from Files, WhatsApp, Mail…)
    const fileName = decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() ?? '');
    if (/^(file|content):/i.test(url) && /\.(dwg|dxf)$/i.test(fileName)) {
      try {
        const { Filesystem } = await import('../../platform/native');
        const r = await Filesystem.readFile({ path: url });
        const bytes = typeof r.data === 'string' ? Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)) : new Uint8Array(await r.data.arrayBuffer());
        const { createProject, importDrawingFile } = await import('../../data/projects');
        const p = await createProject({ name: fileName.replace(/\.(dwg|dxf)$/i, '') });
        await importDrawingFile(p.id, fileName, bytes);
        await openProject(p.id);
      } catch (e) {
        useApp.setState({ loading: null });
        useApp.getState().toast(`Cannot open ${fileName}: ${(e as Error).message}`, 'error');
      }
      return;
    }
    if (!url.startsWith('fiberlens://')) return;
    const r = parseQr(url);
    if (r?.projectId && currentProjectId() !== r.projectId && (await db.projects.get(r.projectId))) await openProject(r.projectId);
    setTimeout(() => openFromQr(url), 300);
  },
  onBack: () => {
    const st = useApp.getState();
    if (app.tools?.active && app.tools.active.id !== 'select') { app.setTool('select'); return true; }
    if (st.panel) { st.set({ panel: null }); return true; }
    if (st.infoEntity !== null) { st.set({ infoEntity: null }); return true; }
    return false;
  },
});
