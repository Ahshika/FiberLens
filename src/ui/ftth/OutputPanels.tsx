import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { jsPDF } from 'jspdf';
import { useFtth, getObject } from '../../ftth/store';
import { KINDS, kindMeta } from '../../ftth/model';
import { openCard } from './ftthUi';
import { Icon } from '../icons';
import { useApp } from '../../app/store';
import { app } from '../../app/controller';
import { currentProjectId, listVersions, currentDrawingId, loadVersionDrawing } from '../../data/projects';
import { downloadBytes, dataUrlToBytes, stamp } from '../../reports/download';
import { REPORTS } from '../../reports/reports';
import { downloadXlsx, toCsv } from '../../reports/tables';
import { downloadText } from '../../reports/download';
import { pdfReport } from '../../reports/pdfTable';
import { computeBoq, type BoqRow } from '../../ftth/boq';
import type { VersionRow, FtthKind } from '../../data/db';
import type { Drawing, Entity } from '../../cad/model/types';
import { geometryOf, transformGeom } from '../../cad/geom/tessellate';
import { walkInsert } from '../../cad/geom/blocks';
import { fmt } from '../common';
import { unpackJson } from '../../data/compress';

const toast = (m: string, k: 'info' | 'error' | 'success' = 'info') => useApp.getState().toast(m, k);

export const qrPayload = (projectId: string, objectId: string, code: string) => `fiberlens://o/${projectId}/${objectId}?c=${encodeURIComponent(code)}`;
export function parseQr(text: string): { projectId?: string; objectId?: string; code?: string } | null {
  const m = /^fiberlens:\/\/o\/([^/]+)\/([^?]+)(?:\?c=(.*))?$/.exec(text.trim());
  if (m) return { projectId: m[1], objectId: m[2], code: m[3] ? decodeURIComponent(m[3]) : undefined };
  return text.trim() ? { code: text.trim() } : null;
}

export function openFromQr(text: string) {
  const r = parseQr(text);
  if (!r) return;
  const s = useFtth.getState();
  let o = r.objectId ? s.objects.get(r.objectId) : undefined;
  if (!o && r.code) o = [...s.objects.values()].find((x) => x.code.toLowerCase() === r.code!.toLowerCase());
  if (!o) { toast(`QR: object ${r.code ?? r.objectId} not found in this project`, 'error'); return; }
  openCard({ type: 'object', id: o.id });
  toast(`Opened ${o.kind} ${o.code}`, 'success');
}

export function QrPanel() {
  const s = useFtth();
  const [sel, setSel] = useState<string>((window as any).__qrObject ?? '');
  const [img, setImg] = useState('');
  const [kind, setKind] = useState<FtthKind>('FAT');
  const [scanning, setScanning] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const pid = currentProjectId()!;
  const o = getObject(sel);
  useEffect(() => { if (o) QRCode.toDataURL(qrPayload(pid, o.id, o.code), { width: 360, margin: 2, errorCorrectionLevel: 'M' }).then(setImg); else setImg(''); }, [sel, o?.code]);

  useEffect(() => {
    if (!scanning) return;
    let stream: MediaStream | null = null, raf = 0, stop = false;
    const detector = 'BarcodeDetector' in window ? new (window as any).BarcodeDetector({ formats: ['qr_code'] }) : null;
    const canvas = document.createElement('canvas');
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        const v = video.current!;
        v.srcObject = stream; await v.play();
        const tick = async () => {
          if (stop) return;
          if (v.readyState >= 2) {
            let text: string | null = null;
            if (detector) { const codes = await detector.detect(v).catch(() => []); text = codes[0]?.rawValue ?? null; }
            else {
              canvas.width = v.videoWidth; canvas.height = v.videoHeight;
              const ctx = canvas.getContext('2d')!; ctx.drawImage(v, 0, 0);
              const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
              text = jsQR(d.data, d.width, d.height)?.data ?? null;
            }
            if (text) { setScanning(false); openFromQr(text); return; }
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) { toast('Camera: ' + (e as Error).message, 'error'); setScanning(false); }
    })();
    return () => { stop = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
  }, [scanning]);

  const sheet = async () => {
    const list = [...s.objects.values()].filter((x) => x.kind === kind).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    if (!list.length) { toast('No objects of this type', 'error'); return; }
    useApp.setState({ loading: `Generating ${list.length} QR labels…` });
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const cols = 4, rows = 6, w = 210 / cols, h = 297 / rows;
    for (let i = 0; i < list.length; i++) {
      if (i && i % (cols * rows) === 0) doc.addPage();
      const k = i % (cols * rows), cx = (k % cols) * w, cy = Math.floor(k / cols) * h;
      const url = await QRCode.toDataURL(qrPayload(pid, list[i].id, list[i].code), { width: 300, margin: 1 });
      doc.addImage(url, 'PNG', cx + w / 2 - 17, cy + 5, 34, 34);
      doc.setFontSize(10); doc.text(list[i].code.replace(/[^\x20-\x7e]/g, '?'), cx + w / 2, cy + 44, { align: 'center' } as any);
      doc.setFontSize(7); doc.text(`${list[i].kind} · FiberLens`, cx + w / 2, cy + 48, { align: 'center' } as any);
    }
    await downloadBytes(`QR_${kind}_${stamp()}.pdf`, new Uint8Array(doc.output('arraybuffer')), 'application/pdf');
    useApp.setState({ loading: null });
  };

  return (
    <div>
      <div className="section">Scan</div>
      {!scanning ? <button className="btn primary" onClick={() => setScanning(true)}><Icon name="camera" />Scan QR code</button> : (
        <div><video ref={video} playsInline muted style={{ width: '100%', borderRadius: 10, background: '#000' }} /><button className="btn" style={{ marginTop: 6 }} onClick={() => setScanning(false)}>Cancel</button></div>
      )}
      <p className="small muted">Scanning opens the object card: information, location, connected fibres & cables, splitter, customers, photos, maintenance history, notes and status.</p>
      <div className="section">Generate</div>
      <select value={sel} onChange={(e) => setSel(e.target.value)} style={{ width: '100%' }}>
        <option value="">Choose object…</option>
        {[...s.objects.values()].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })).slice(0, 5000).map((x) => <option key={x.id} value={x.id}>{x.kind} {x.code}</option>)}
      </select>
      {img && o && (
        <div className="card" style={{ marginTop: 8, textAlign: 'center' }}>
          <img src={img} style={{ width: 220, height: 220, background: '#fff', borderRadius: 8 }} />
          <div><b>{o.code}</b> <span className="muted small">{o.kind}</span></div>
          <button className="btn sm" style={{ marginTop: 6 }} onClick={() => downloadBytes(`QR_${o.code}.png`, dataUrlToBytes(img), 'image/png')}>Download PNG</button>
        </div>
      )}
      <div className="section">Label sheet (A4, 24 per page)</div>
      <div className="row"><select value={kind} onChange={(e) => setKind(e.target.value as FtthKind)}>{KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</select><button className="btn" onClick={sheet}>PDF labels</button></div>
    </div>
  );
}

// ---------------- Design vs As-Built compare ----------------
export function ComparePanel() {
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [a, setA] = useState('');
  const [b, setB] = useState('current');
  const [res, setRes] = useState<{ added: number[]; modified: number[]; removed: Entity[]; ftth: { added: string[]; removed: string[]; changed: string[] } } | null>(null);
  const did = currentDrawingId();
  useEffect(() => { if (did) listVersions(did).then((v) => { setVersions(v); const design = v.find((x) => x.kind === 'design' || x.kind === 'import'); if (design) setA(design.id); }); }, [did]);
  useEffect(() => () => { app.view?.removeOverlay('compare'); app.selection?.setHighlight('cmp-add', null); app.selection?.setHighlight('cmp-mod', null); if (app.view) { app.view.opts.drawingAlpha = 1; app.view.invalidate(); } }, []);
  const run = async () => {
    const va = await loadVersionDrawing(a);
    if (!va) return;
    let cur: Drawing;
    let ftthB: Record<string, any[]>;
    if (b === 'current') {
      cur = app.doc!.live();
      const s = useFtth.getState();
      ftthB = { ftthObjects: [...s.objects.values()], cables: [...s.cables.values()] };
    } else {
      const vb = await loadVersionDrawing(b);
      if (!vb) return;
      cur = vb.drawing;
      ftthB = vb.row.ftth ? unpackJson(vb.row.ftth) : {};
    }
    const key = (e: Entity) => (e.handle ? 'h' + e.handle : 'i' + e.id);
    const old = new Map(va.drawing.entities.map((e) => [key(e), e]));
    const added: number[] = [], modified: number[] = [];
    const curKeys = new Set<string>();
    for (const e of cur.entities) {
      const k = key(e); curKeys.add(k);
      const p = old.get(k);
      if (!p) added.push(e.id);
      else if (JSON.stringify({ ...p, id: 0 }) !== JSON.stringify({ ...e, id: 0 })) modified.push(e.id);
    }
    const removed = va.drawing.entities.filter((e) => !curKeys.has(key(e)));
    const ftthA = va.row.ftth ? unpackJson<Record<string, any[]>>(va.row.ftth) : {};
    const ia = new Map((ftthA.ftthObjects ?? []).map((o) => [o.id, o])), ib = new Map((ftthB.ftthObjects ?? []).map((o) => [o.id, o]));
    const fAdded = [...ib.values()].filter((o) => !ia.has(o.id)).map((o) => `${o.kind} ${o.code}`);
    const fRemoved = [...ia.values()].filter((o) => !ib.has(o.id)).map((o) => `${o.kind} ${o.code}`);
    const fChanged = [...ib.values()].filter((o) => ia.has(o.id) && (ia.get(o.id).status !== o.status || Math.hypot(ia.get(o.id).cad.x - o.cad.x, ia.get(o.id).cad.y - o.cad.y) > 0.01)).map((o) => `${o.kind} ${o.code}: ${ia.get(o.id).status}→${o.status}`);
    setRes({ added, modified, removed, ftth: { added: fAdded, removed: fRemoved, changed: fChanged } });
    // visualise on the current drawing
    if (b === 'current') {
      app.selection?.setHighlight('cmp-add', { ids: added, color: '#30d158', width: 4 });
      app.selection?.setHighlight('cmp-mod', { ids: modified, color: '#ffb000', width: 4 });
      const blocks = va.drawing.blocks;
      app.view?.addOverlay('compare', (ctx, cam) => {
        ctx.save(); ctx.strokeStyle = '#ff3b30'; ctx.lineWidth = 3; ctx.setLineDash([6, 4]); ctx.beginPath();
        for (const e of removed.slice(0, 3000)) {
          const gs = e.type === 'insert' ? (() => { const out: any[] = []; walkInsert(e, blocks, (c, m) => out.push(transformGeom(geometryOf(c), m))); return out; })() : [geometryOf(e)];
          for (const g of gs) for (const p of g.paths) { p.pts.forEach((v: number, i: number) => { if (i % 2) return; const s = cam.worldToScreen(p.pts[i], p.pts[i + 1]); if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y); }); }
        }
        ctx.stroke(); ctx.restore();
      }, 15);
      if (app.view) { app.view.opts.drawingAlpha = 0.45; app.view.invalidate(); }
    }
  };
  return (
    <div>
      <p className="small muted">Compare a design version with the as-built (current working copy or a saved As-Built version). On the drawing: <span style={{ color: '#30d158' }}>added</span>, <span style={{ color: '#ffb000' }}>modified</span>, <span style={{ color: '#ff3b30' }}>removed</span>.</p>
      <div className="field"><label>Design (baseline)</label><select value={a} onChange={(e) => setA(e.target.value)}>{versions.map((v) => <option key={v.id} value={v.id}>{v.label} · {new Date(v.createdAt).toLocaleDateString()}</option>)}</select></div>
      <div className="field"><label>As-Built</label><select value={b} onChange={(e) => setB(e.target.value)}><option value="current">Current working copy</option>{versions.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select></div>
      <button className="btn primary" onClick={run} disabled={!a}><Icon name="compare" />Compare</button>
      {res && (
        <div style={{ marginTop: 10 }}>
          <div className="grid3">
            <div className="card"><div className="small muted">Added</div><b style={{ color: '#30d158', fontSize: 20 }}>{res.added.length}</b></div>
            <div className="card"><div className="small muted">Modified</div><b style={{ color: '#ffb000', fontSize: 20 }}>{res.modified.length}</b></div>
            <div className="card"><div className="small muted">Removed</div><b style={{ color: '#ff3b30', fontSize: 20 }}>{res.removed.length}</b></div>
          </div>
          <div className="row wrap" style={{ marginTop: 8 }}>
            <button className="btn sm" onClick={() => app.zoomToEntities([...res.added, ...res.modified])} disabled={!res.added.length && !res.modified.length}>Zoom to changes</button>
            <button className="btn sm" onClick={() => app.selection?.set([...res.added, ...res.modified])}>Select changes</button>
          </div>
          <div className="section">FTTH differences</div>
          <div className="small">
            {res.ftth.added.length > 0 && <div><b style={{ color: '#30d158' }}>Added ({res.ftth.added.length}):</b> {res.ftth.added.slice(0, 40).join(', ')}</div>}
            {res.ftth.removed.length > 0 && <div><b style={{ color: '#ff3b30' }}>Removed ({res.ftth.removed.length}):</b> {res.ftth.removed.slice(0, 40).join(', ')}</div>}
            {res.ftth.changed.length > 0 && <div><b style={{ color: '#ffb000' }}>Changed ({res.ftth.changed.length}):</b> {res.ftth.changed.slice(0, 40).join('; ')}</div>}
            {!res.ftth.added.length && !res.ftth.removed.length && !res.ftth.changed.length && <span className="muted">No FTTH differences</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- Reports & BOQ ----------------
export function ReportsPanel() {
  const [boq, setBoq] = useState<BoqRow[] | null>(null);
  const pid = currentProjectId()!;
  const st = useApp();
  useEffect(() => { computeBoq(pid, { includeCad: false }).then(setBoq); }, [pid, useFtth((s) => s.rev)]);
  const gen = async (id: string, fmtOut: 'xlsx' | 'pdf' | 'csv') => {
    const def = REPORTS.find((r) => r.id === id)!;
    useApp.setState({ loading: `Building ${def.title}…` });
    try {
      const sections = await def.build(pid);
      const base = `${st.projectName}_${def.title}`.replace(/[^\w\-]+/g, '_') + '_' + stamp();
      if (fmtOut === 'xlsx') await downloadXlsx(`${base}.xlsx`, sections.map((s) => ({ name: s.title, rows: s.rows, title: `${def.title} — ${s.title} — ${st.projectName}` })));
      else if (fmtOut === 'csv') await downloadText(`${base}.csv`, toCsv(sections[sections.length > 1 ? 1 : 0].rows), 'text/csv');
      else await downloadBytes(`${base}.pdf`, pdfReport(`${def.title} — ${st.projectName}`, `${st.drawingName} · ${st.mode === 'asbuilt' ? 'AS-BUILT' : 'DESIGN'}`, sections), 'application/pdf');
    } catch (e) { toast((e as Error).message, 'error'); }
    useApp.setState({ loading: null });
  };
  const sections = boq ? [...new Set(boq.map((r) => r.section))] : [];
  return (
    <div>
      <div className="section">Bill of quantities</div>
      {!boq ? <div className="small muted">Computing…</div> : boq.length === 0 ? <div className="small muted">No FTTH data yet — run FTTH → Detect, or use the CAD takeoff in the BOQ report.</div> : (
        <div className="tbl-wrap" style={{ maxHeight: 280 }}>
          <table className="tbl"><thead><tr><th>Item</th><th>Qty</th><th>Unit</th></tr></thead>
            <tbody>{sections.map((s) => (
              <React.Fragment key={s}>
                <tr><td colSpan={3} style={{ fontWeight: 700, color: 'var(--accent)' }}>{s}</td></tr>
                {boq.filter((r) => r.section === s).map((r, i) => <tr key={i}><td>{r.item}</td><td style={{ textAlign: 'right' }}>{fmt(r.qty, 1)}</td><td>{r.unit}</td></tr>)}
              </React.Fragment>
            ))}</tbody></table>
        </div>
      )}
      <div className="section">Reports</div>
      <div className="list">
        {REPORTS.map((r) => (
          <div key={r.id} className="list-item" style={{ cursor: 'default', alignItems: 'flex-start' }}>
            <Icon name={r.id === 'boq' ? 'boq' : 'report'} />
            <div className="grow"><b>{r.title}</b><div className="small muted">{r.description}</div>
              <div className="row" style={{ marginTop: 4, gap: 6 }}>
                <button className="btn sm" onClick={() => gen(r.id, 'xlsx')}>Excel</button>
                <button className="btn sm" onClick={() => gen(r.id, 'pdf')}>PDF</button>
                <button className="btn sm" onClick={() => gen(r.id, 'csv')}>CSV</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export { kindMeta };
